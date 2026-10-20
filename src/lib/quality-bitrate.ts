/**
 * 码率工具（anericn 定制）：换源时「同样 1080P、码率差几倍」要能一眼看出来并排在前面。
 *
 * 实测采集站的片源大多是单码率，分辨率普遍不低（1080P 宽银幕居多），
 * 真正决定清不清楚的是码率：同一部片在不同源上可以从 0.5 Mbps 差到 7 Mbps。
 * 本模块是纯函数（客户端、服务端共用），网络探测在 quality-bitrate-probe.ts。
 */

import { qualityLabel } from './quality';
import type { QualityEntry } from './types';

/** 合理码率区间（kbps）：超出多半是 Content-Length 错误或广告/占位分片 */
const MIN_KBPS = 50;
const MAX_KBPS = 100_000;
/** 分片时长下限：过短的分片（广告切片、片尾残片）算出的码率波动太大 */
const MIN_SEGMENT_SECONDS = 1;

/** 码率展示：2100 → 2.1M，12340 → 12M，520 → 520K */
export function formatBitrate(kbps?: number): string | undefined {
  if (!kbps || !Number.isFinite(kbps) || kbps <= 0) return undefined;
  if (kbps < 1000) return `${Math.round(kbps)}K`;
  const mbps = kbps / 1000;
  return mbps >= 10 ? `${Math.round(mbps)}M` : `${mbps.toFixed(1)}M`;
}

/** 分片大小 + 时长 → 码率（kbps）；数据不可信时返回 undefined */
export function bitrateFromSegment(bytes: number | undefined, seconds: number | undefined): number | undefined {
  if (!bytes || !seconds || seconds < MIN_SEGMENT_SECONDS) return undefined;
  const kbps = Math.round((bytes * 8) / seconds / 1000);
  return kbps >= MIN_KBPS && kbps <= MAX_KBPS ? kbps : undefined;
}

/**
 * master playlist 里最高一档的码率（kbps）；非 master 返回 undefined。
 * 按峰值 BANDWIDTH 选出最高档，优先返回它的 AVERAGE-BANDWIDTH——
 * 平均码率才与分片估算、播放实测同口径，峰值会把声明了多码率的源抬高。
 */
export function parseBestBandwidthKbps(text: string): number | undefined {
  if (!text.includes('#EXT-X-STREAM-INF')) return undefined;
  let bestPeak = 0;
  let bestValue = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const peak = parseInt(line.match(/(?<![-A-Z])BANDWIDTH=(\d+)/)?.[1] || '0', 10);
    const average = parseInt(line.match(/AVERAGE-BANDWIDTH=(\d+)/)?.[1] || '0', 10);
    if (peak > bestPeak) {
      bestPeak = peak;
      bestValue = average || peak;
    }
  }
  return bestValue > 0 ? Math.round(bestValue / 1000) : undefined;
}

/**
 * 选一个用来估算码率的分片：在最长的那段（按 DISCONTINUITY 切分，避开插播广告）里取中间分片，
 * 片头多是黑场/片头曲，码率偏低不具代表性。
 * BYTERANGE 播放列表直接放弃：所有分片指向同一个文件，拿到的是整个文件的大小。
 */
export function pickBitrateSegment(text: string): { uri: string; duration: number } | undefined {
  if (text.includes('#EXT-X-BYTERANGE')) return undefined;
  type Segment = { uri: string; duration: number };
  const groups: Segment[][] = [[]];
  let duration: number | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      if (groups[groups.length - 1].length > 0) groups.push([]);
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8).split(',')[0]);
      continue;
    }
    if (!line || line.startsWith('#') || duration === undefined) continue;
    if (Number.isFinite(duration)) groups[groups.length - 1].push({ uri: line, duration });
    duration = undefined;
  }
  const total = (g: Segment[]) => g.reduce((sum, s) => sum + s.duration, 0);
  const longest = groups.reduce((best, g) => (total(g) > total(best) ? g : best), groups[0]);
  return longest.length > 0 ? longest[Math.floor(longest.length / 2)] : undefined;
}

/** 高度 → 档位数值，与徽章标签同口径（1040 算 1080、960 算 1080），测不出为 0 */
export function qualityTier(height?: number): number {
  const label = qualityLabel(height);
  if (!label) return 0;
  if (label === '4K') return 2160;
  if (label === '2K') return 1440;
  return parseInt(label, 10) || 0;
}

/** 状态排序：有画质结论 > 尚未探测 > 测不出 > 探测失败 */
function statusRank(entry?: QualityEntry): number {
  if (!entry) return 2;
  if (entry.height && entry.height > 0) return 3;
  if (entry.error) return 0;
  return 1;
}

/**
 * 排序比较器（用于 Array.sort，越清楚越靠前）：
 * 先比档位，同档再比码率，有码率的排在不知道码率的前面；相同返回 0 以保持原有顺序。
 */
export function compareQualityEntries(a?: QualityEntry, b?: QualityEntry): number {
  const rank = statusRank(b) - statusRank(a);
  if (rank !== 0) return rank;
  const tier = qualityTier(b?.height) - qualityTier(a?.height);
  if (tier !== 0) return tier;
  return (b?.kbps ?? 0) - (a?.kbps ?? 0);
}
