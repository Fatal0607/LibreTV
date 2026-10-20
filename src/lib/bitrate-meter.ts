import { bitrateFromSegment } from './quality-bitrate';

/**
 * 播放实测码率（anericn 定制）：按 hls.js 实际下载的分片累计「字节 ÷ 媒体时长」。
 * 攒够 FIRST_REPORT_SECONDS 才第一次上报（单个分片波动大），之后每多 REPORT_EVERY_SECONDS 更新一次，
 * 避免每个分片都写一次持久化存储。
 */

const FIRST_REPORT_SECONDS = 20;
const REPORT_EVERY_SECONDS = 60;

export interface BitrateMeter {
  /** 记录一个已下载分片；到了上报时机返回累计平均码率（kbps），否则返回 undefined */
  add(bytes: number | undefined, seconds: number | undefined): number | undefined;
}

export function createBitrateMeter(): BitrateMeter {
  let totalBytes = 0;
  let totalSeconds = 0;
  let nextReportAt = FIRST_REPORT_SECONDS;
  return {
    add(bytes, seconds) {
      if (!bytes || bytes <= 0 || !seconds || !Number.isFinite(seconds) || seconds <= 0) return undefined;
      totalBytes += bytes;
      totalSeconds += seconds;
      if (totalSeconds < nextReportAt) return undefined;
      nextReportAt = totalSeconds + REPORT_EVERY_SECONDS;
      return bitrateFromSegment(totalBytes, totalSeconds);
    },
  };
}
