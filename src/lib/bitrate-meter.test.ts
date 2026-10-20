import { describe, expect, it } from 'vitest';
import { createBitrateMeter } from './bitrate-meter';

/** 播放实测码率（anericn 定制）：按已下载分片累计，攒够时长才上报，之后按间隔更新 */

describe('createBitrateMeter', () => {
  it('攒够 20 秒才第一次上报，结果为累计平均码率', () => {
    const meter = createBitrateMeter();
    // 每片 10 秒、2.5MB → 2000 kbps
    expect(meter.add(2_500_000, 10)).toBeUndefined();
    expect(meter.add(2_500_000, 10)).toBe(2000);
  });

  it('首次上报后每再攒 60 秒更新一次', () => {
    const meter = createBitrateMeter();
    meter.add(2_500_000, 10);
    meter.add(2_500_000, 10);
    for (let i = 0; i < 5; i++) expect(meter.add(5_000_000, 10)).toBeUndefined();
    // 第 6 片（累计 80 秒）：(2×2.5MB + 6×5MB)×8 / 80s ≈ 3500 kbps
    expect(meter.add(5_000_000, 10)).toBe(3500);
  });

  it('忽略无效的分片数据', () => {
    const meter = createBitrateMeter();
    expect(meter.add(undefined, 10)).toBeUndefined();
    expect(meter.add(2_500_000, 0)).toBeUndefined();
    expect(meter.add(2_500_000, Number.NaN)).toBeUndefined();
    expect(meter.add(2_500_000, 10)).toBeUndefined();
    expect(meter.add(2_500_000, 10)).toBe(2000);
  });
});
