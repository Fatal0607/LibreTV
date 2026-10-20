import { describe, expect, it } from 'vitest';
import { buildServerSyncPayload, diffServerSources, planLocalCleanup, type SyncState } from './server-sources-sync';

/**
 * 「同步到服务器」客户端纯逻辑：从本机勾选状态组装提交内容、与服务器现状做差异、同步后清理本机重复源。
 */

function state(patch: Partial<SyncState> = {}): SyncState {
  return {
    customAPIs: [],
    envSources: [],
    selectedKeys: [],
    liveEnvSources: [],
    liveSubscriptions: [],
    liveSelectedUrls: [],
    ...patch,
  };
}

describe('buildServerSyncPayload', () => {
  it('只取已勾选的点播源，保留 detail / isAdult，按地址去重', () => {
    const payload = buildServerSyncPayload(
      state({
        customAPIs: [
          { key: 'custom_0', name: '手动A', url: 'https://a.example.com/vod', detail: 'https://a.example.com', isAdult: true },
          { key: 'custom_1', name: '未勾选', url: 'https://b.example.com/vod' },
          { key: 'sub_x_0', name: '订阅重复', url: 'https://a.example.com/vod/' },
        ],
        selectedKeys: ['custom_0', 'sub_x_0', 'missing_key'],
      }),
    );
    expect(payload.sources).toEqual([
      { name: '手动A', url: 'https://a.example.com/vod', detail: 'https://a.example.com', isAdult: true },
    ]);
  });

  it('包含已勾选的全站共享源（srv_），排除环境变量预置源（env_）', () => {
    const payload = buildServerSyncPayload(
      state({
        envSources: [
          { key: 'env_0', name: '环境变量', url: 'https://env.example.com/vod' },
          { key: 'srv_abc', name: '共享', url: 'https://srv.example.com/vod' },
        ],
        selectedKeys: ['env_0', 'srv_abc'],
      }),
    );
    expect(payload.sources.map((s) => s.name)).toEqual(['共享']);
  });

  it('只取已启用的直播源，排除环境变量预置直播源', () => {
    const payload = buildServerSyncPayload(
      state({
        liveEnvSources: [
          { key: 'envlive_0', name: '环境变量直播', url: 'https://env.example.com/a.m3u' },
          { key: 'srvlive_abc', name: '共享直播', url: 'https://srv.example.com/a.m3u' },
        ],
        liveSubscriptions: [
          { url: 'https://m.example.com/a.m3u', name: '手动直播', epg: 'https://m.example.com/epg.xml', fromSubscriptions: [] },
          { url: 'https://off.example.com/a.m3u', name: '未启用', fromSubscriptions: [] },
        ],
        liveSelectedUrls: ['https://env.example.com/a.m3u', 'https://srv.example.com/a.m3u', 'https://m.example.com/a.m3u'],
      }),
    );
    expect(payload.liveSources).toEqual([
      { name: '共享直播', url: 'https://srv.example.com/a.m3u' },
      { name: '手动直播', url: 'https://m.example.com/a.m3u', epg: 'https://m.example.com/epg.xml' },
    ]);
  });
});

describe('diffServerSources', () => {
  it('按地址统计新增与移除', () => {
    const diff = diffServerSources(
      { sources: [{ name: 'A', url: 'https://a/vod' }, { name: 'B', url: 'https://b/vod' }], liveSources: [{ name: 'L', url: 'https://l/a.m3u' }] },
      { sources: [{ name: 'B', url: 'https://b/vod' }, { name: 'C', url: 'https://c/vod' }], liveSources: [] },
    );
    expect(diff).toEqual({ addedVod: 1, removedVod: 1, addedLive: 0, removedLive: 1, removedNames: ['A', 'L'] });
  });
});

describe('planLocalCleanup', () => {
  it('同步后：重复的点播源一律只取消勾选（保留 key，观看历史仍能找到来源），手动直播源重复的删除', () => {
    const plan = planLocalCleanup(
      state({
        customAPIs: [
          { key: 'custom_0', name: '手动', url: 'https://a.example.com/vod/' },
          { key: 'sub_x_0', name: '订阅', url: 'https://b.example.com/vod' },
          { key: 'custom_1', name: '不相关', url: 'https://c.example.com/vod' },
        ],
        selectedKeys: ['custom_0', 'sub_x_0', 'custom_1'],
        liveSubscriptions: [
          { url: 'https://m.example.com/a.m3u', fromSubscriptions: [] },
          { url: 'https://s.example.com/a.m3u', fromSubscriptions: ['https://sub.example.com/list.json'] },
        ],
      }),
      {
        sources: [
          { name: 'A', url: 'https://a.example.com/vod' },
          { name: 'B', url: 'https://b.example.com/vod' },
        ],
        liveSources: [
          { name: 'M', url: 'https://m.example.com/a.m3u' },
          { name: 'S', url: 'https://s.example.com/a.m3u' },
        ],
      },
    );
    expect(plan).toEqual({
      deselectVodKeys: ['custom_0', 'sub_x_0'],
      removeLiveUrls: ['https://m.example.com/a.m3u'],
    });
  });
});
