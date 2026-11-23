import { describe, expect, it } from 'vitest';
import { delta, options } from './feasibility-metrics.js';

describe('screen feasibility evidence', () => {
  it('measures bytes and frames over actual elapsed time, retaining missing data', () => {
    expect(delta({ time: 100, bytes: 10 }, { time: 2100, bytes: 1000010 })).toEqual({
      seconds: 2,
      bitsPerSecond: 4000000,
      fps: null,
      width: null,
      height: null,
      workMsPerFrame: null,
    });
    expect(
      delta(
        { time: 0, bytes: 0, frames: 0, workSeconds: 0 },
        { time: 1000, bytes: 100, frames: 30, width: 1920, height: 1080, workSeconds: 0.15 },
      ),
    ).toMatchObject({ fps: 30, workMsPerFrame: 5, width: 1920, height: 1080 });
  });
  it('rejects resets and invalid intervals instead of generating success-shaped rates', () => {
    expect(() => delta({ time: 0, bytes: 0 }, { time: Number.NaN, bytes: 10 })).toThrow();
    expect(() => delta({ time: 0, bytes: 0 }, { time: 10, bytes: Number.NaN })).toThrow();
    expect(() => delta({ time: 1, bytes: 0 }, { time: 1, bytes: 10 })).toThrow();
    expect(() => delta({ time: 0, bytes: 20 }, { time: 10, bytes: 10 })).toThrow();
    expect(() =>
      delta({ time: 0, bytes: 0, frames: 4 }, { time: 10, bytes: 1, frames: 2 }),
    ).toThrow();
  });
  it('bounds measurement duration and rejects unknown or unsupported options', () => {
    expect(options(['--codec=H264', '--phase-ms=5000'])).toEqual({
      codec: 'H264',
      content: 'motion',
      hint: 'auto',
      phaseMs: 5000,
      bitrates: [2000000, 8000000],
    });
    for (const arg of [
      '--runtime=electron',
      '--codec=HEVC',
      '--content=private-desktop',
      '--hint=unsupported',
      '--phase-ms=1',
      '--phase-ms=Infinity',
      '--bitrates-mbps=6,3',
      '--bitrates-mbps=6,6',
      '--bitrates-mbps=6,',
      '--url=https://example.com',
    ])
      expect(() => options([arg])).toThrow();
  });
  it('accepts a single bitrate or a fixed-format sweep in the requested order', () => {
    expect(options(['--bitrates-mbps=17']).bitrates).toEqual([17000000]);
    expect(options(['--hint=fixed', '--bitrates-mbps=12,6,8,17,20'])).toMatchObject({
      hint: 'fixed',
      bitrates: [12000000, 6000000, 8000000, 17000000, 20000000],
    });
  });
  it.each(['VP8', 'H264', 'VP9', 'AV1'])('accepts %s for explicit codec qualification', (codec) => {
    expect(options(['--codec=' + codec, '--content=text'])).toMatchObject({
      codec,
      content: 'text',
    });
  });
});
