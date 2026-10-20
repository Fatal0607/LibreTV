import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_LIVE_SOURCES, MAX_VOD_SOURCES } from './source-list';
import type { LiveSourceConfig, SourceConfig } from './types';
import { hostnameOf } from './utils';

/**
 * 全站共享源（anericn 定制）：管理员在客户端「同步到服务器」后落盘到 DATA_DIR，
 * 由 /api/status 并入 DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES 一起下发，
 * 所有登录用户自动可见并勾选——复用上游「部署者预置源」的整套客户端逻辑。
 *
 * 与环境变量预置的区别：
 * - 运行时可改，不需要重启容器；
 * - key 按地址哈希（srv_ / srvlive_），增删条目不会让其余源的 key 错位，
 *   用户的勾选状态与观看历史里的 sourceKey 都保持稳定。
 */

export { MAX_LIVE_SOURCES, MAX_VOD_SOURCES };

const FILE_NAME = 'server-sources.json';
const MAX_NAME_LEN = 128;
const MAX_URL_LEN = 2048;

export interface ServerVodSource {
  name: string;
  url: string;
  detail?: string;
  isAdult?: boolean;
}

export interface ServerLiveSource {
  name: string;
  url: string;
  epg?: string;
}

export interface ServerSourcesPayload {
  sources: ServerVodSource[];
  liveSources: ServerLiveSource[];
}

export interface ServerSourcesFile extends ServerSourcesPayload {
  /** 最近一次同步的时间戳（毫秒）；从未同步过为 null */
  updatedAt: number | null;
}

const EMPTY: ServerSourcesFile = { sources: [], liveSources: [], updatedAt: null };

/** 按文件 mtime + 大小缓存解析结果：/api/status 每次请求都会读，避免反复读盘解析 */
let cache: { file: string; stamp: string; value: ServerSourcesFile } | null = null;

function fileStamp(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function dataFile(): string {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dir, FILE_NAME);
}

function trimUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const s = value.trim().slice(0, MAX_URL_LEN);
  return /^https?:\/\/[^\s]+$/i.test(s) ? s.replace(/\/+$/, '') : '';
}

function trimName(value: unknown, url: string): string {
  const s = typeof value === 'string' ? value.trim().slice(0, MAX_NAME_LEN) : '';
  return s || hostnameOf(url);
}

/** 白名单式取字段：只保留已知字段，按地址去重（先到先得），条数截断到上限 */
function normalizeList<T>(raw: unknown[], max: number, pick: (item: Record<string, unknown>, url: string) => T): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of raw) {
    if (out.length >= max) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = trimUrl(record.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(pick(record, url));
  }
  return out;
}

/** 清洗客户端提交（或磁盘读出）的源列表；结构不对返回 null，两个列表都允许为空 */
export function normalizeServerSources(raw: unknown): ServerSourcesPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const rawVod = record.sources ?? [];
  const rawLive = record.liveSources ?? [];
  if (!Array.isArray(rawVod) || !Array.isArray(rawLive)) return null;

  const sources = normalizeList<ServerVodSource>(rawVod, MAX_VOD_SOURCES, (item, url) => {
    const detail = trimUrl(item.detail);
    return {
      name: trimName(item.name, url),
      url,
      ...(detail ? { detail } : {}),
      ...(item.isAdult === true ? { isAdult: true } : {}),
    };
  });
  const liveSources = normalizeList<ServerLiveSource>(rawLive, MAX_LIVE_SOURCES, (item, url) => {
    const epg = trimUrl(item.epg);
    return { name: trimName(item.name, url), url, ...(epg ? { epg } : {}) };
  });
  return { sources, liveSources };
}

function urlHash(url: string): string {
  return crypto.createHash('sha1').update(url.trim().replace(/\/+$/, '')).digest('hex').slice(0, 12);
}

export function vodServerKey(url: string): string {
  return `srv_${urlHash(url)}`;
}

export function liveServerKey(url: string): string {
  return `srvlive_${urlHash(url)}`;
}

/** 读取全站共享源；文件不存在或损坏时返回空列表（损坏时告警，不影响站点运行） */
export function readServerSources(): ServerSourcesFile {
  const file = dataFile();
  const stamp = fileStamp(file);
  if (stamp && cache && cache.file === file && cache.stamp === stamp) return cache.value;
  const value = readUncached(file);
  cache = stamp ? { file, stamp, value } : null;
  return value;
}

function readUncached(file: string): ServerSourcesFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[LibreTV] 读取全站共享源失败：', err instanceof Error ? err.message : err);
    }
    return EMPTY;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const normalized = normalizeServerSources(parsed);
    if (!normalized) throw new Error('结构不正确');
    const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null;
    return { ...normalized, updatedAt };
  } catch (err) {
    console.warn(`[LibreTV] ${file} 解析失败，已按空列表处理：`, err instanceof Error ? err.message : err);
    return EMPTY;
  }
}

/** 整体替换全站共享源。先写临时文件再 rename，避免并发读到半个 JSON */
export function writeServerSources(payload: ServerSourcesPayload): ServerSourcesFile {
  const file = dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next: ServerSourcesFile = { ...payload, updatedAt: Date.now() };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  } finally {
    // rename 成功后临时文件已不存在；失败时清掉残留
    fs.rmSync(tmp, { force: true });
  }
  cache = null;
  return next;
}

/** 把全站共享点播源追加到 DEFAULT_SOURCES 之后（地址已存在的跳过），供 /api/status 下发 */
export function mergeServerVod(envSources: SourceConfig[], stored: ServerSourcesFile = readServerSources()): SourceConfig[] {
  const seen = new Set(envSources.map((s) => s.url.replace(/\/+$/, '')));
  const extra = stored
    .sources.filter((s) => !seen.has(s.url))
    .map((s) => ({ key: vodServerKey(s.url), ...s }));
  return [...envSources, ...extra];
}

/** 把全站共享直播源追加到 DEFAULT_LIVE_SOURCES 之后（地址已存在的跳过） */
export function mergeServerLive(envLive: LiveSourceConfig[], stored: ServerSourcesFile = readServerSources()): LiveSourceConfig[] {
  const seen = new Set(envLive.map((s) => s.url.replace(/\/+$/, '')));
  const extra = stored
    .liveSources.filter((s) => !seen.has(s.url))
    .map((s) => ({ key: liveServerKey(s.url), ...s }));
  return [...envLive, ...extra];
}
