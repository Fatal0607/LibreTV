import { describe, expect, it } from 'vitest';
import { dropProbeEntries } from './quality-cache-reset';
import type { QualityEntry } from './types';

/**
 * anericn：画质探测改为核实实际分片后，浏览器里旧的「探测」记录（多半来自 m3u8 模板声明值）
 * 需要一次性清掉，否则要等 30 天过期才会重新探测。播放实测的记录是真实值，保留。
 */

const e = (patch: Partial<QualityEntry>): QualityEntry => ({ from: 'probe', timestamp: 1, ...patch });

describe('dropProbeEntries', () => {
  it('只删探测记录，保留播放实测记录', () => {
    const map = {
      a: e({ height: 608, kbps: 800 }),
      b: e({ from: 'play', height: 1080, kbps: 1560 }),
      c: e({ error: 'HTTP 403' }),
    };
    expect(dropProbeEntries(map)).toEqual({ b: map.b });
  });

  it('不修改传入的对象', () => {
    const map = { a: e({ height: 608 }) };
    dropProbeEntries(map);
    expect(Object.keys(map)).toEqual(['a']);
  });
});
