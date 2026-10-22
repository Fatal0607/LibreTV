import { describe, expect, it } from 'vitest';
import {
  bitrateFromSegment,
  compareQualityEntries,
  formatBitrate,
  parseBestBandwidthKbps,
  pickBitrateSegment,
  pickTopVariantUri,
  qualityTier,
} from './quality-bitrate';
import { QUALITY_UNVERIFIED_TTL_MS, isQualityEntryFresh, mergeQualityEntries } from './quality';
import type { QualityEntry } from './types';

/**
 * 码率（anericn 定制）：换源时「同样 1080P、码率差几倍」要能一眼看出来并排在前面。
 */

const NOW = 1_800_000_000_000;
const entry = (patch: Partial<QualityEntry>): QualityEntry => ({ from: 'probe', timestamp: NOW, ...patch });

describe('formatBitrate', () => {
  it('≥1000 kbps 显示为 M，保留一位小数', () => {
    expect(formatBitrate(2100)).toBe('2.1M');
    expect(formatBitrate(7412)).toBe('7.4M');
    expect(formatBitrate(1000)).toBe('1.0M');
  });

  it('十位数以上不再保留小数', () => {
    expect(formatBitrate(12_340)).toBe('12M');
  });

  it('<1000 kbps 显示为 K', () => {
    expect(formatBitrate(520)).toBe('520K');
  });

  it('缺失或非法时返回 undefined', () => {
    expect(formatBitrate(undefined)).toBeUndefined();
    expect(formatBitrate(0)).toBeUndefined();
    expect(formatBitrate(Number.NaN)).toBeUndefined();
  });
});

describe('bitrateFromSegment', () => {
  it('字节数 × 8 ÷ 时长，单位 kbps', () => {
    // 2.5MB / 10s ≈ 2000 kbps
    expect(bitrateFromSegment(2_500_000, 10)).toBe(2000);
  });

  it('时长过短或结果离谱时放弃（避免广告片段、错误 Content-Length 带来的假数据）', () => {
    expect(bitrateFromSegment(2_500_000, 0.2)).toBeUndefined();
    expect(bitrateFromSegment(100, 10)).toBeUndefined();
    expect(bitrateFromSegment(10_000_000_000, 10)).toBeUndefined();
    expect(bitrateFromSegment(undefined, 10)).toBeUndefined();
  });
});

describe('parseBestBandwidthKbps', () => {
  it('取 master playlist 里最高一档的 BANDWIDTH', () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080/index.m3u8
`;
    expect(parseBestBandwidthKbps(master)).toBe(5000);
  });

  it('优先用 AVERAGE-BANDWIDTH（平均码率），与分片估算、播放实测同口径', () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
720/index.m3u8
`;
    expect(parseBestBandwidthKbps(master)).toBe(4500);
  });

  it('非 master playlist 返回 undefined', () => {
    expect(parseBestBandwidthKbps('#EXTM3U\n#EXTINF:10,\na.ts\n')).toBeUndefined();
  });
});

describe('pickBitrateSegment', () => {
  it('取中间的分片：片头常是黑场/片头曲，码率偏低', () => {
    const text = `#EXTM3U
#EXTINF:4.0,
a.ts
#EXTINF:10.0,
b.ts
#EXTINF:9.5,
c.ts
#EXT-X-ENDLIST
`;
    expect(pickBitrateSegment(text)).toEqual({ uri: 'b.ts', duration: 10 });
  });

  it('没有分片时返回 undefined', () => {
    expect(pickBitrateSegment('#EXTM3U\n#EXT-X-ENDLIST\n')).toBeUndefined();
  });

  it('BYTERANGE 播放列表放弃：所有分片指向同一个文件，整文件大小不能当单段大小', () => {
    const text = `#EXTM3U
#EXTINF:10.0,
#EXT-X-BYTERANGE:1000000@0
movie.ts
#EXTINF:10.0,
#EXT-X-BYTERANGE:1000000@1000000
movie.ts
`;
    expect(pickBitrateSegment(text)).toBeUndefined();
  });

  it('有插播广告时，从最长的那段正片里取中间分片', () => {
    const text = `#EXTM3U
#EXTINF:10.0,
a0.ts
#EXTINF:10.0,
a1.ts
#EXT-X-DISCONTINUITY
#EXTINF:5.0,
ad0.ts
#EXTINF:5.0,
ad1.ts
#EXTINF:5.0,
ad2.ts
#EXT-X-DISCONTINUITY
#EXTINF:10.0,
b0.ts
#EXTINF:10.0,
b1.ts
#EXTINF:9.0,
b2.ts
#EXTINF:10.0,
b3.ts
`;
    expect(pickBitrateSegment(text)).toEqual({ uri: 'b2.ts', duration: 9 });
  });
});

describe('qualityTier', () => {
  it('按徽章档位归一：1040、960 都算 1080，2160 以上算 4K', () => {
    expect(qualityTier(1040)).toBe(1080);
    expect(qualityTier(720)).toBe(720);
    expect(qualityTier(2160)).toBe(2160);
    expect(qualityTier(undefined)).toBe(0);
  });
});

describe('compareQualityEntries', () => {
  const sortKeys = (list: Array<[string, QualityEntry | undefined]>) =>
    [...list].sort((a, b) => compareQualityEntries(a[1], b[1])).map(([k]) => k);

  it('先比档位，同档再比码率，都高的排前面', () => {
    expect(
      sortKeys([
        ['720P-高码率', entry({ height: 720, kbps: 3000 })],
        ['1080P-低码率', entry({ height: 1080, kbps: 900 })],
        ['1080P-高码率', entry({ height: 1080, kbps: 7400 })],
      ]),
    ).toEqual(['1080P-高码率', '1080P-低码率', '720P-高码率']);
  });

  it('同档时有码率的排在不知道码率的前面；没测到画质的排最后', () => {
    expect(
      sortKeys([
        ['未探测', undefined],
        ['1080P-无码率', entry({ height: 1080 })],
        ['失败', entry({ error: 'HTTP 403' })],
        ['1080P-有码率', entry({ height: 1080, kbps: 2000 })],
      ]),
    ).toEqual(['1080P-有码率', '1080P-无码率', '未探测', '失败']);
  });

  it('完全相同时返回 0，保持原有顺序', () => {
    expect(compareQualityEntries(entry({ height: 720, kbps: 1000 }), entry({ height: 720, kbps: 1000 }))).toBe(0);
  });
});

describe('mergeQualityEntries 保留码率', () => {
  it('播放实测之间合并：高度取大，码率用最新测到的', () => {
    const merged = mergeQualityEntries(
      { k: entry({ from: 'play', height: 1080, kbps: 1500 }) },
      { k: entry({ from: 'play', kbps: 2100 }) },
      NOW,
    );
    expect(merged.k).toMatchObject({ from: 'play', height: 1080, kbps: 2100 });
  });

  it('播放实测只报了高度时，沿用之前的码率', () => {
    const merged = mergeQualityEntries(
      { k: entry({ from: 'play', height: 720, kbps: 1500 }) },
      { k: entry({ from: 'play', height: 1080 }) },
      NOW,
    );
    expect(merged.k).toMatchObject({ height: 1080, kbps: 1500 });
  });

  it('实测只报了码率时只更新码率，不把探测高度升格成实测（之后真实高度还能覆盖）', () => {
    const afterBitrate = mergeQualityEntries(
      { k: entry({ from: 'probe', height: 1080, kbps: 2000 }) },
      { k: entry({ from: 'play', kbps: 2600 }) },
      NOW,
    );
    expect(afterBitrate.k).toMatchObject({ from: 'probe', height: 1080, kbps: 2600 });
    const afterHeight = mergeQualityEntries(afterBitrate, { k: entry({ from: 'play', height: 720 }) }, NOW);
    expect(afterHeight.k).toMatchObject({ from: 'play', height: 720, kbps: 2600 });
  });

  it('没有任何记录时只报码率：不标成实测，后续探测仍能补上高度', () => {
    const merged = mergeQualityEntries({}, { k: entry({ from: 'play', kbps: 2600 }) }, NOW);
    expect(merged.k).toMatchObject({ from: 'probe', kbps: 2600 });
    expect(merged.k.height).toBeUndefined();
    const probed = mergeQualityEntries(merged, { k: entry({ from: 'probe', height: 1080 }) }, NOW);
    expect(probed.k).toMatchObject({ height: 1080, kbps: 2600 });
  });

  it('探测覆盖探测时，这次码率没测到就沿用上次的', () => {
    const merged = mergeQualityEntries(
      { k: entry({ height: 1080, kbps: 2000 }) },
      { k: entry({ height: 1080 }) },
      NOW,
    );
    expect(merged.k).toMatchObject({ height: 1080, kbps: 2000 });
  });

  it('实测覆盖探测时，实测还没测出码率就先保留探测的码率', () => {
    const merged = mergeQualityEntries(
      { k: entry({ from: 'probe', height: 1080, kbps: 2000 }) },
      { k: entry({ from: 'play', height: 1080 }) },
      NOW,
    );
    expect(merged.k).toMatchObject({ from: 'play', height: 1080, kbps: 2000 });
  });
});

describe('pickTopVariantUri', () => {
  it('取峰值码率最高那一档，不受 AVERAGE-BANDWIDTH 干扰', () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=9000000,BANDWIDTH=2500000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080/index.m3u8
`;
    expect(pickTopVariantUri(master)).toBe('1080/index.m3u8');
  });

  it('非 master 返回 undefined', () => {
    expect(pickTopVariantUri('#EXTM3U\n#EXTINF:10,\na.ts\n')).toBeUndefined();
  });
});

describe('未核实的声明值只短期缓存', () => {
  it('unverified 的探测结果 6 小时后过期，核实过的仍按 30 天', () => {
    const later = NOW + QUALITY_UNVERIFIED_TTL_MS + 1;
    expect(isQualityEntryFresh(entry({ height: 608, unverified: true }), NOW + 60_000)).toBe(true);
    expect(isQualityEntryFresh(entry({ height: 608, unverified: true }), later)).toBe(false);
    expect(isQualityEntryFresh(entry({ height: 1080 }), later)).toBe(true);
  });
});
