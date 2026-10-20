'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import { ConfirmDialog } from './confirm-dialog';
import { SectionTitle } from './settings-shared';
import { Spinner } from './states';
import { useToast } from './toast';
import { api, STATUS_QUERY_KEY } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { applyEnvPresets } from '@/lib/subscription-sync';
import { buildServerSyncPayload, diffServerSources, planLocalCleanup, type SyncState } from '@/lib/server-sources-sync';
import type { ServerSourcesFile, ServerSourcesPayload } from '@/lib/server-sources';
import type { AuthStatusResponse } from '@/lib/types';
import { formatRelativeTime } from '@/lib/utils';

/**
 * 全站共享源面板（anericn 定制）：把本机当前启用的源同步到服务器，
 * 所有登录用户下次打开站点时自动出现并勾选。修改需要管理密码 ADMIN_PASSWORD。
 */

type AdminSourcesResponse = ServerSourcesFile & { adminConfigured: boolean };

const ADMIN_SOURCES_QUERY_KEY = ['admin-server-sources'] as const;

async function fetchServerSources(): Promise<AdminSourcesResponse> {
  const res = await fetch('/api/admin/sources', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(res.status === 401 ? '请先登录' : `读取失败 (${res.status})`);
  return (await res.json()) as AdminSourcesResponse;
}

async function pushServerSources(adminPassword: string, payload: ServerSourcesPayload): Promise<void> {
  const res = await fetch('/api/admin/sources', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminPassword, ...payload }),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error || `同步失败 (${res.status})`);
}

/** 只订阅组装同步内容需要的字段：测活、画质等高频写入不会让面板反复重渲染 */
function selectSyncState(s: SyncState): SyncState {
  return {
    customAPIs: s.customAPIs,
    envSources: s.envSources,
    selectedKeys: s.selectedKeys,
    liveEnvSources: s.liveEnvSources,
    liveSubscriptions: s.liveSubscriptions,
    liveSelectedUrls: s.liveSelectedUrls,
  };
}

/** 同步成功后把共享源应用到本机，并收拾与共享源重复的本机条目 */
async function applyToLocal(fetchStatus: () => Promise<AuthStatusResponse>, saved: ServerSourcesPayload): Promise<void> {
  // 立即拉新的 /api/status，把共享源作为预置源应用到本机
  await applyEnvPresets(await fetchStatus());
  const plan = planLocalCleanup(useAppStore.getState(), saved);
  // 点播：重复的本机源只取消勾选（保留 key，旧观看历史仍能找到来源）
  if (plan.deselectVodKeys.length > 0) {
    const drop = new Set(plan.deselectVodKeys);
    useAppStore.getState().setSelectedKeys(useAppStore.getState().selectedKeys.filter((k) => !drop.has(k)));
  }
  // 直播：启用状态按地址记录，删除手动条目会连带取消同地址共享源的启用，删完再补回
  if (plan.removeLiveUrls.length > 0) {
    plan.removeLiveUrls.forEach((url) => useAppStore.getState().removeLiveSubscription(url));
    useAppStore.setState((s) => ({ liveSelectedUrls: [...new Set([...s.liveSelectedUrls, ...plan.removeLiveUrls])] }));
  }
}

function describeDiff(added: number, removed: number): string {
  if (added === 0 && removed === 0) return '无变化';
  return [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(Boolean).join(' ');
}

export function ServerSourcesPanel() {
  const syncState = useAppStore(useShallow(selectSyncState));
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [adminPassword, setAdminPassword] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const server = useQuery({ queryKey: ADMIN_SOURCES_QUERY_KEY, queryFn: fetchServerSources, staleTime: 0 });

  const next = buildServerSyncPayload(syncState);
  const diff = server.data ? diffServerSources(server.data, next) : null;
  const hasRemoval = !!diff && diff.removedVod + diff.removedLive > 0;
  const unchanged = !!diff && diff.addedVod + diff.removedVod + diff.addedLive + diff.removedLive === 0;

  const sync = async () => {
    setConfirming(false);
    setSyncing(true);
    try {
      await pushServerSources(adminPassword, next);
    } catch (err) {
      toast(err instanceof Error ? err.message : '同步失败', 'error');
      setSyncing(false);
      return;
    }
    // 走到这里服务器已经保存成功；之后本机应用失败只影响本机，单独提示
    setAdminPassword('');
    try {
      await applyToLocal(
        () => queryClient.fetchQuery<AuthStatusResponse>({ queryKey: STATUS_QUERY_KEY, queryFn: () => api.status(), staleTime: 0 }),
        next,
      );
      toast(`已同步 ${next.sources.length} 个点播源、${next.liveSources.length} 个直播源到服务器`, 'success');
    } catch {
      toast('服务器已保存，但本机刷新失败，请刷新页面', 'warning');
    } finally {
      void server.refetch();
      setSyncing(false);
    }
  };

  const onSyncClick = () => (hasRemoval ? setConfirming(true) : void sync());

  return (
    <section>
      <SectionTitle title="全站共享源" hint="同步到服务器后，所有登录用户都会自动获得这些源" />

      <div className="rounded-lg border border-line bg-chip/60 p-3 text-xs leading-relaxed">
        {server.isLoading ? (
          <div className="flex items-center gap-2 text-faint">
            <Spinner /> 正在读取服务器上的共享源…
          </div>
        ) : server.error ? (
          <p className="text-danger">{server.error instanceof Error ? server.error.message : '读取失败'}</p>
        ) : server.data ? (
          <>
            <p className="text-content">
              服务器当前共享 <b>{server.data.sources.length}</b> 个点播源、<b>{server.data.liveSources.length}</b> 个直播源
              {server.data.updatedAt && <span className="text-faint"> · 更新于 {formatRelativeTime(server.data.updatedAt)}</span>}
            </p>
            {server.data.sources.length + server.data.liveSources.length > 0 && (
              <p className="mt-1 text-faint break-words">
                {[...server.data.sources, ...server.data.liveSources].map((s) => s.name).join('、')}
              </p>
            )}
          </>
        ) : null}
      </div>

      <div className="mt-4 space-y-2 text-xs leading-relaxed">
        <p className="text-content">
          本机当前启用 <b>{next.sources.length}</b> 个点播源、<b>{next.liveSources.length}</b> 个直播源
          {diff && (
            <span className="text-faint">
              {unchanged
                ? ' · 与服务器一致'
                : ` · 同步后点播 ${describeDiff(diff.addedVod, diff.removedVod)}，直播 ${describeDiff(diff.addedLive, diff.removedLive)}`}
            </span>
          )}
        </p>
        <p className="text-faint">
          在「点播源」「直播源」里添加并勾选想共享的源，再点同步。服务器上的源列表会被替换成本机当前启用的这一份：
          取消勾选某个共享源再同步，就会把它从服务器移除。环境变量预置的源不受影响。
        </p>
      </div>

      {server.data && !server.data.adminConfigured ? (
        <p className="mt-3 text-xs text-danger">服务器未设置 ADMIN_PASSWORD 环境变量，暂时不能同步。</p>
      ) : (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (adminPassword && !syncing) onSyncClick();
          }}
        >
          <input
            type="password"
            className="input flex-1 min-w-0"
            placeholder="管理密码"
            autoComplete="off"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            aria-label="管理密码"
          />
          <button type="submit" className="btn-primary btn-sm shrink-0" disabled={!adminPassword || syncing || !server.data}>
            {syncing ? '同步中…' : '同步到服务器'}
          </button>
        </form>
      )}

      <ConfirmDialog
        open={confirming}
        danger
        title="从服务器移除部分共享源？"
        message={
          diff ? (
            <>
              这次同步会从服务器移除 {diff.removedVod} 个点播源、{diff.removedLive} 个直播源，所有用户都将不再看到它们：
              <span className="block mt-1.5 text-content break-words">{diff.removedNames.join('、')}</span>
            </>
          ) : undefined
        }
        confirmLabel="同步并移除"
        onConfirm={() => void sync()}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
