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
    expect(options(['--runtime=edge', '--codec=H264', '--phase-ms=5000'])).toEqual({
      runtime: 'edge',
      codec: 'H264',
      content: 'motion',
      phaseMs: 5000,
    });
    for (const arg of [
      '--runtime=chrome',
      '--codec=AV1',
      '--content=private-desktop',
      '--phase-ms=1',
      '--phase-ms=Infinity',
      '--url=https://example.com',
    ])
      expect(() => options([arg])).toThrow();
  });
});
