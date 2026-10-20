import type { LiveSourceConfig, SourceConfig } from './types';
import type { LiveSubscription } from './store';
import type { ServerLiveSource, ServerSourcesPayload, ServerVodSource } from './server-sources';

/**
 * 「同步到服务器」的客户端纯逻辑（anericn 定制），与 UI 分开以便单测：
 * - 从本机勾选状态组装要提交的全站共享源；
 * - 与服务器现状做差异，给管理员确认；
 * - 同步成功后清理本机与共享源重复的条目，避免同一个源被搜索两次。
 */

export interface SyncState {
  customAPIs: SourceConfig[];
  envSources: SourceConfig[];
  selectedKeys: string[];
  liveEnvSources: LiveSourceConfig[];
  liveSubscriptions: LiveSubscription[];
  liveSelectedUrls: string[];
}

export interface ServerSourcesDiff {
  addedVod: number;
  removedVod: number;
  addedLive: number;
  removedLive: number;
  /** 将从服务器移除的源名称（点播在前），供确认框逐个列出 */
  removedNames: string[];
}

export interface LocalCleanupPlan {
  /**
   * 已在共享源里的本机点播源：只取消勾选、不删除——
   * 观看历史按 sourceKey 找来源，删掉 custom_N 会让旧历史无法续播；订阅导入的删了也会复活
   */
  deselectVodKeys: string[];
  /** 手动添加、且已在共享源里的直播源：直接删除（订阅导入的由 allLiveSources 去重） */
  removeLiveUrls: string[];
}

/** DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES 由环境变量管理，不随同步写入服务器 */
const ENV_VOD_PREFIX = 'env_';
const ENV_LIVE_PREFIX = 'envlive_';

function normUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** 组装提交内容：本机当前已勾选的点播源 + 已启用的直播源（包括已有的共享源，取消勾选即从服务器移除） */
export function buildServerSyncPayload(state: SyncState): ServerSourcesPayload {
  const all = [...state.customAPIs, ...state.envSources];
  const seenVod = new Set<string>();
  const sources: ServerVodSource[] = [];
  for (const key of state.selectedKeys) {
    if (key.startsWith(ENV_VOD_PREFIX)) continue;
    const src = all.find((s) => s.key === key);
    if (!src || !isHttp(src.url)) continue;
    const url = normUrl(src.url);
    if (seenVod.has(url)) continue;
    seenVod.add(url);
    sources.push({
      name: src.name,
      url,
      ...(src.detail ? { detail: src.detail } : {}),
      ...(src.isAdult ? { isAdult: true } : {}),
    });
  }

  const selectedLive = new Set(state.liveSelectedUrls);
  const envLiveUrls = new Set(state.liveEnvSources.map((s) => s.url));
  const liveCandidates: LiveSourceConfig[] = [
    ...state.liveEnvSources,
    ...state.liveSubscriptions
      .filter((s) => !envLiveUrls.has(s.url))
      .map((s) => ({ key: `sub_${s.url}`, name: s.name || '', url: s.url, epg: s.epg })),
  ];
  const seenLive = new Set<string>();
  const liveSources: ServerLiveSource[] = [];
  for (const s of liveCandidates) {
    if (s.key.startsWith(ENV_LIVE_PREFIX) || !selectedLive.has(s.url) || !isHttp(s.url)) continue;
    const url = normUrl(s.url);
    if (seenLive.has(url)) continue;
    seenLive.add(url);
    liveSources.push({ name: s.name, url, ...(s.epg ? { epg: s.epg } : {}) });
  }

  return { sources, liveSources };
}

function countDiff(
  current: { name: string; url: string }[],
  next: { url: string }[],
): { added: number; removed: string[] } {
  const cur = new Set(current.map((s) => normUrl(s.url)));
  const nxt = new Set(next.map((s) => normUrl(s.url)));
  return {
    added: [...nxt].filter((u) => !cur.has(u)).length,
    removed: current.filter((s) => !nxt.has(normUrl(s.url))).map((s) => s.name),
  };
}

export function diffServerSources(current: ServerSourcesPayload, next: ServerSourcesPayload): ServerSourcesDiff {
  const vod = countDiff(current.sources, next.sources);
  const live = countDiff(current.liveSources, next.liveSources);
  return {
    addedVod: vod.added,
    removedVod: vod.removed.length,
    addedLive: live.added,
    removedLive: live.removed.length,
    removedNames: [...vod.removed, ...live.removed],
  };
}

export function planLocalCleanup(state: SyncState, saved: ServerSourcesPayload): LocalCleanupPlan {
  const vodUrls = new Set(saved.sources.map((s) => normUrl(s.url)));
  const liveUrls = new Set(saved.liveSources.map((s) => normUrl(s.url)));
  const selected = new Set(state.selectedKeys);
  return {
    deselectVodKeys: state.customAPIs
      .filter((a) => selected.has(a.key) && vodUrls.has(normUrl(a.url)))
      .map((a) => a.key),
    removeLiveUrls: state.liveSubscriptions
      .filter((s) => s.fromSubscriptions.length === 0 && liveUrls.has(normUrl(s.url)))
      .map((s) => s.url),
  };
}
