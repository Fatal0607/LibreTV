import { flushPendingPersist } from './persist-storage';
import { useAppStore } from './store';
import type { QualityEntry } from './types';

/**
 * 画质缓存一次性重置（anericn 定制）。
 *
 * 画质探测改为核实实际分片之前，多码率源的结果直接取自 m3u8 声明值，而采集站的声明值常是模板
 * （每部片都写 1080x608 / 800K 之类）。这些旧结果存在浏览器里、有效期 30 天，且「已有结论就不再探」，
 * 不清掉的话新探测要一个月后才生效。播放实测的记录是解码出来的真实值，保留。
 */

/** 递增此值即可让所有浏览器再清一次探测缓存 */
const RESET_VERSION = '2026-10-22-verify-segments';
const RESET_FLAG_KEY = 'anericn-quality-probe-reset';

export function dropProbeEntries(map: Record<string, QualityEntry>): Record<string, QualityEntry> {
  return Object.fromEntries(Object.entries(map).filter(([, entry]) => entry.from === 'play'));
}

/** 在 store 恢复持久化状态之后调用；每个浏览器每个 RESET_VERSION 只执行一次 */
export function resetLegacyProbeCache(): void {
  try {
    if (localStorage.getItem(RESET_FLAG_KEY) === RESET_VERSION) return;
    useAppStore.setState({ qualityMap: dropProbeEntries(useAppStore.getState().qualityMap) });
    // 先把清理结果落盘再记标记：持久化有节流，标记先写会导致「已标记但旧记录没删掉」
    flushPendingPersist();
    localStorage.setItem(RESET_FLAG_KEY, RESET_VERSION);
  } catch {
    // 隐私模式等无法读写 localStorage：不清理，旧记录 30 天后自然过期
  }
}
