import { fetchUpstream } from './fetch-utils';
import { bitrateFromSegment, pickBitrateSegment } from './quality-bitrate';
import { checkUpstreamAllowed } from './ssrf';

/**
 * 服务端估算单码率源的码率（anericn 定制）。
 *
 * 不下载分片：带 `Range: bytes=0-0` 请求中间那个分片，从 Content-Range 里读完整大小；
 * 源站不支持 Range 时回 200，就用 Content-Length。拿到大小立刻断开连接。
 * 任何一步失败都只返回 undefined（没有码率），不影响画质探测的其他结论。
 */

/** 单独的时间预算：码率只是锦上添花，不能拖慢分辨率探测 */
const BITRATE_BUDGET_MS = 4000;

/** 从响应头读分片完整大小：206 看 Content-Range 的总长，200 看 Content-Length */
function totalSizeFromHeaders(res: Response): number | undefined {
  const range = res.headers.get('content-range');
  const total = range?.match(/\/(\d+)\s*$/)?.[1];
  if (res.status === 206 && total) return parseInt(total, 10);
  const length = res.headers.get('content-length');
  if (res.status === 200 && length) return parseInt(length, 10);
  return undefined;
}

export async function probeSegmentBitrate(
  playlistText: string,
  playlistUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<number | undefined> {
  const segment = pickBitrateSegment(playlistText);
  if (!segment) return undefined;
  let url: string;
  try {
    url = new URL(segment.uri, playlistUrl).toString();
  } catch {
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('码率估算超时', 'TimeoutError')), BITRATE_BUDGET_MS);
  try {
    const verdict = await checkUpstreamAllowed(url);
    if (!verdict.ok) return undefined;
    const res = await fetchUpstream(url, {
      timeoutMs: BITRATE_BUDGET_MS,
      headers: { ...headers, Range: 'bytes=0-0' },
      signal: AbortSignal.any([signal, controller.signal]),
    });
    // 只要头部：不 cancel 的话源站不支持 Range 时会把整个分片传完
    res.body?.cancel().catch(() => {});
    return bitrateFromSegment(totalSizeFromHeaders(res), segment.duration);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
