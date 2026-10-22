import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeQuality } from './quality-probe';
import type { SourceConfig } from './types';

const mocks = vi.hoisted(() => ({ fetchUpstream: vi.fn() }));
vi.mock('./fetch-utils', () => ({ fetchUpstream: mocks.fetchUpstream }));
vi.mock('./ssrf', () => ({ checkUpstreamAllowed: () => Promise.resolve({ ok: true }) }));

/**
 * 画质探测带出码率（anericn 定制）：
 * - 多码率源直接取最高档的 BANDWIDTH；
 * - 单码率源取中间分片，用响应头里的完整大小 ÷ 分片时长，不下载整个分片。
 */

const SOURCE: SourceConfig = { key: 'demo', name: 'demo', url: 'https://api.test/api.php/provide/vod' };
const PLAYLIST_URL = 'https://cdn.test/v/index.m3u8';

const detailJson = {
  list: [{ vod_id: 1, vod_name: '测试', vod_play_url: `第1集$${PLAYLIST_URL}` }],
};

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
1080/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:4.0,
seg0.ts
#EXTINF:10.0,
seg1.ts
#EXTINF:10.0,
seg2.ts
#EXT-X-ENDLIST
`;

function textResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

beforeEach(() => {
  mocks.fetchUpstream.mockReset();
});

describe('probeQuality 码率', () => {
  it('多码率源：按最高档子列表的实际分片测码率，不采信声明值', async () => {
    const fakeMaster = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4096000,RESOLUTION=1920x1080
hd/index.m3u8
`;
    mocks.fetchUpstream.mockImplementation(async (url: string) => {
      if (url.includes('ac=videolist')) return new Response(JSON.stringify(detailJson));
      if (url === PLAYLIST_URL) return textResponse(fakeMaster);
      if (url === 'https://cdn.test/v/hd/index.m3u8') return textResponse(MEDIA);
      if (url === 'https://cdn.test/v/hd/seg1.ts') {
        // 1.95MB / 10s ≈ 1560 kbps（声明 4096）
        return new Response(new Uint8Array([0x47]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-0/1950000', 'Content-Length': '1' },
        });
      }
      return new Response(new Uint8Array(0), { status: 200 });
    });
    const result = await probeQuality({ source: SOURCE, id: '1' });
    expect(result.kbps).toBe(1560);
  });

  it('多码率源：子列表打不开时，退回最高档的声明码率', async () => {
    mocks.fetchUpstream.mockImplementation(async (url: string) => {
      if (url.includes('ac=videolist')) return new Response(JSON.stringify(detailJson));
      if (url === PLAYLIST_URL) return textResponse(MASTER);
      throw new Error(`unexpected ${url}`);
    });
    const result = await probeQuality({ source: SOURCE, id: '1' });
    expect(result).toMatchObject({ height: 1080, kbps: 6000 });
  });

  it('单码率源：用中间分片的 Content-Range 总大小计算码率', async () => {
    const requested: Array<{ url: string; range?: string }> = [];
    mocks.fetchUpstream.mockImplementation(async (url: string, opts?: { headers?: Record<string, string> }) => {
      requested.push({ url, range: opts?.headers?.Range });
      if (url.includes('ac=videolist')) return new Response(JSON.stringify(detailJson));
      if (url === PLAYLIST_URL) return textResponse(MEDIA);
      if (url.endsWith('seg1.ts')) {
        // 2.5MB / 10s = 2000 kbps
        return new Response(new Uint8Array([0x47]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-0/2500000', 'Content-Length': '1' },
        });
      }
      // 首分片解析分辨率：返回空内容，分辨率测不出，不影响码率
      return new Response(new Uint8Array(0), { status: 200 });
    });
    const result = await probeQuality({ source: SOURCE, id: '1' });
    expect(result.kbps).toBe(2000);
    expect(requested.find((r) => r.url.endsWith('seg1.ts'))?.range).toBe('bytes=0-0');
  });

  it('源站不支持 Range 时退回 Content-Length', async () => {
    mocks.fetchUpstream.mockImplementation(async (url: string) => {
      if (url.includes('ac=videolist')) return new Response(JSON.stringify(detailJson));
      if (url === PLAYLIST_URL) return textResponse(MEDIA);
      if (url.endsWith('seg1.ts')) {
        return new Response(new Uint8Array([0x47]), { status: 200, headers: { 'Content-Length': '1250000' } });
      }
      return new Response(new Uint8Array(0), { status: 200 });
    });
    const result = await probeQuality({ source: SOURCE, id: '1' });
    expect(result.kbps).toBe(1000);
  });

  it('分片请求失败时只是没有码率，不影响其余结论', async () => {
    mocks.fetchUpstream.mockImplementation(async (url: string) => {
      if (url.includes('ac=videolist')) return new Response(JSON.stringify(detailJson));
      if (url === PLAYLIST_URL) return textResponse(MEDIA);
      return new Response('', { status: 404 });
    });
    const result = await probeQuality({ source: SOURCE, id: '1' });
    expect(result.kbps).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});
