import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_LIVE_SOURCES,
  MAX_VOD_SOURCES,
  liveServerKey,
  mergeServerLive,
  mergeServerVod,
  normalizeServerSources,
  readServerSources,
  vodServerKey,
  writeServerSources,
} from './server-sources';

/**
 * 全站共享源单测：入参白名单清洗、稳定 key、与 DEFAULT_* 预置源合并去重、落盘读写。
 * 读写用临时目录（DATA_DIR），不碰真实数据。
 */

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libretv-srv-'));
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('normalizeServerSources', () => {
  it('只保留已知字段，去掉地址结尾的斜杠', () => {
    const result = normalizeServerSources({
      sources: [{ name: ' 源A ', url: 'https://a.example.com/api.php/provide/vod/', detail: 'https://a.example.com', isAdult: true, extra: 'x' }],
      liveSources: [{ name: '直播A', url: 'https://live.example.com/list.m3u', epg: 'https://live.example.com/epg.xml.gz', junk: 1 }],
    });
    expect(result).toEqual({
      sources: [{ name: '源A', url: 'https://a.example.com/api.php/provide/vod', detail: 'https://a.example.com', isAdult: true }],
      liveSources: [{ name: '直播A', url: 'https://live.example.com/list.m3u', epg: 'https://live.example.com/epg.xml.gz' }],
    });
  });

  it('丢弃非 http(s) 地址，按地址去重（先到先得）', () => {
    const result = normalizeServerSources({
      sources: [
        { name: '坏', url: 'ftp://x.example.com' },
        { name: '甲', url: 'https://dup.example.com/vod' },
        { name: '乙', url: 'https://dup.example.com/vod/' },
      ],
      liveSources: [{ name: '坏', url: 'javascript:alert(1)' }],
    });
    expect(result?.sources).toEqual([{ name: '甲', url: 'https://dup.example.com/vod' }]);
    expect(result?.liveSources).toEqual([]);
  });

  it('名称缺省时用主机名，非法 EPG 只丢该字段', () => {
    const result = normalizeServerSources({
      sources: [{ url: 'https://noname.example.com/vod' }],
      liveSources: [{ url: 'https://l.example.com/a.m3u', epg: 'not-a-url' }],
    });
    expect(result?.sources[0].name).toBe('noname.example.com');
    expect(result?.liveSources[0]).toEqual({ name: 'l.example.com', url: 'https://l.example.com/a.m3u' });
  });

  it('超过条数上限时截断', () => {
    const many = Array.from({ length: MAX_VOD_SOURCES + 5 }, (_, i) => ({ name: `s${i}`, url: `https://s${i}.example.com/vod` }));
    const manyLive = Array.from({ length: MAX_LIVE_SOURCES + 5 }, (_, i) => ({ url: `https://l${i}.example.com/a.m3u` }));
    const result = normalizeServerSources({ sources: many, liveSources: manyLive });
    expect(result?.sources).toHaveLength(MAX_VOD_SOURCES);
    expect(result?.liveSources).toHaveLength(MAX_LIVE_SOURCES);
  });

  it('允许两个列表都为空（用于清空全站共享源）', () => {
    expect(normalizeServerSources({ sources: [], liveSources: [] })).toEqual({ sources: [], liveSources: [] });
  });

  it('结构不对时返回 null', () => {
    expect(normalizeServerSources(null)).toBeNull();
    expect(normalizeServerSources([])).toBeNull();
    expect(normalizeServerSources({ sources: 'x' })).toBeNull();
  });
});

describe('稳定 key', () => {
  it('同一地址 key 固定，与列表顺序无关', () => {
    expect(vodServerKey('https://a.example.com/vod')).toBe(vodServerKey('https://a.example.com/vod/'));
    expect(vodServerKey('https://a.example.com/vod')).not.toBe(vodServerKey('https://b.example.com/vod'));
    expect(vodServerKey('https://a.example.com/vod')).toMatch(/^srv_[0-9a-f]{12}$/);
    expect(liveServerKey('https://a.example.com/a.m3u')).toMatch(/^srvlive_[0-9a-f]{12}$/);
  });
});

describe('readServerSources / writeServerSources', () => {
  it('文件不存在时返回空列表', () => {
    expect(readServerSources()).toEqual({ sources: [], liveSources: [], updatedAt: null });
  });

  it('写入后可读回，并记录更新时间', () => {
    const saved = writeServerSources({ sources: [{ name: 'A', url: 'https://a.example.com/vod' }], liveSources: [] });
    expect(saved.updatedAt).toBeGreaterThan(0);
    const read = readServerSources();
    expect(read.sources).toEqual([{ name: 'A', url: 'https://a.example.com/vod' }]);
    expect(read.updatedAt).toBe(saved.updatedAt);
    // 原子写入：不残留临时文件
    expect(fs.readdirSync(dataDir)).toEqual(['server-sources.json']);
  });

  it('文件内容损坏时当作空列表，不抛错', () => {
    fs.writeFileSync(path.join(dataDir, 'server-sources.json'), '{ broken');
    expect(readServerSources().sources).toEqual([]);
  });

  it('数据目录不存在时自动创建', () => {
    process.env.DATA_DIR = path.join(dataDir, 'nested', 'dir');
    writeServerSources({ sources: [], liveSources: [{ name: 'L', url: 'https://l.example.com/a.m3u' }] });
    expect(readServerSources().liveSources).toHaveLength(1);
  });
});

describe('mergeServerVod / mergeServerLive', () => {
  it('追加在 DEFAULT_* 预置源之后，地址重复的跳过，并带上稳定 key', () => {
    writeServerSources({
      sources: [
        { name: '重复', url: 'https://env.example.com/vod' },
        { name: '共享', url: 'https://srv.example.com/vod', isAdult: true },
      ],
      liveSources: [{ name: '共享直播', url: 'https://srv.example.com/a.m3u' }],
    });
    const vod = mergeServerVod([{ key: 'env_0', name: '预置', url: 'https://env.example.com/vod' }]);
    expect(vod).toEqual([
      { key: 'env_0', name: '预置', url: 'https://env.example.com/vod' },
      { key: vodServerKey('https://srv.example.com/vod'), name: '共享', url: 'https://srv.example.com/vod', isAdult: true },
    ]);
    const live = mergeServerLive([]);
    expect(live).toEqual([{ key: liveServerKey('https://srv.example.com/a.m3u'), name: '共享直播', url: 'https://srv.example.com/a.m3u' }]);
  });
});
