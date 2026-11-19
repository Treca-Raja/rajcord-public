import { afterEach, expect, it, vi } from 'vitest';
import { ScreenContentMonitor, ScreenMotionDetector } from './screen-content';
const pixels = (value: number) => new Uint8ClampedArray(64 * 36 * 4).fill(value);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('keeps static content and small cursor changes detailed, even with a high FPS source', () => {
  const detector = new ScreenMotionDetector(),
    image = pixels(40);
  for (let time = 0; time <= 4000; time += 200) {
    image.fill(time % 400 ? 255 : 0, 0, 16);
    expect(detector.sample(image, time)).toBe('detail');
  }
});
it('detects sustained motion, resists short scrolling bursts, then returns to detail after settling', () => {
  const detector = new ScreenMotionDetector();
  detector.sample(pixels(0), 0);
  expect(detector.sample(pixels(100), 200)).toBe('detail');
  expect(detector.sample(pixels(0), 400)).toBe('detail');
  expect(detector.sample(pixels(100), 600)).toBe('motion');
  for (let time = 800; time < 2800; time += 200)
    expect(detector.sample(pixels(100), time)).toBe('motion');
  expect(detector.sample(pixels(100), 2800)).toBe('detail');
});
it('does not build motion confidence from delayed, resized or stale samples', () => {
  const detector = new ScreenMotionDetector();
  detector.sample(pixels(0), 0);
  detector.sample(pixels(100), 200);
  expect(detector.sample(pixels(0), 5000)).toBe('detail');
  expect(detector.sample(new Uint8ClampedArray(16).fill(255), 5200)).toBe('detail');
  expect(() => detector.sample(pixels(0), 5100)).toThrow();
});
it('still detects motion when background timer clamping slows analysis to about one sample per second', () => {
  const detector = new ScreenMotionDetector();
  detector.sample(pixels(0), 0);
  detector.sample(pixels(100), 1200);
  expect(detector.sample(pixels(0), 2400)).toBe('motion');
});
it('releases analysis elements on Stop without stopping the borrowed capture track or adopting late play', async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  const play = new Promise<void>((done) => {
    resolve = done;
  });
  const video = {
    muted: false,
    playsInline: false,
    srcObject: null,
    pause: vi.fn(),
    play: () => play,
  };
  const canvas = { width: 0, height: 0, getContext: () => ({}) };
  vi.stubGlobal('document', {
    createElement: (kind: string) => (kind === 'video' ? video : canvas),
  });
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: unknown[]) {}
    },
  );
  const track = { readyState: 'live', contentHint: '', stop: vi.fn() };
  const monitor = new ScreenContentMonitor(track as unknown as MediaStreamTrack);
  monitor.dispose();
  resolve();
  await play;
  await Promise.resolve();
  expect(video.srcObject).toBeNull();
  expect(track.stop).not.toHaveBeenCalled();
  expect(monitor.inspect().status).toBe('closed');
  expect(vi.getTimerCount()).toBe(0);
});
it('reports unavailable analysis explicitly and continues to permit media', () => {
  vi.stubGlobal('document', undefined);
  const monitor = new ScreenContentMonitor({} as MediaStreamTrack);
  expect(monitor.inspect()).toEqual({ kind: 'detail', status: 'unsupported' });
  monitor.dispose();
});

it('falls back to detail and releases failed analysis without ending the borrowed source', async () => {
  vi.useFakeTimers();
  let frame = 0;
  const context = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: pixels(frame++ % 2 ? 100 : 0) })),
  };
  const video = {
    readyState: 4,
    muted: true,
    playsInline: true,
    srcObject: null,
    play: async () => {},
    pause: vi.fn(),
  };
  vi.stubGlobal('document', {
    createElement: (kind: string) => (kind === 'video' ? video : { getContext: () => context }),
  });
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: unknown[]) {}
    },
  );
  const track = { readyState: 'live', contentHint: '', stop: vi.fn() };
  const monitor = new ScreenContentMonitor(track as unknown as MediaStreamTrack);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(800);
  expect(monitor.inspect()).toMatchObject({ kind: 'motion', status: 'available' });
  context.getImageData.mockImplementationOnce(() => {
    throw new Error('Owned analysis failure');
  });
  await vi.advanceTimersByTimeAsync(200);
  expect(monitor.inspect()).toEqual({ kind: 'detail', status: 'error' });
  expect(track.contentHint).toBe('detail');
  expect(video.srcObject).toBeNull();
  expect(track.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  monitor.dispose();
});
