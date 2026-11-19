import { expect, it } from 'vitest';
import { screenImageQuality } from './feasibility-quality';
const image = (value: number) => new Uint8ClampedArray(16 * 16 * 4).fill(value);
it('represents an exact match without serializing Infinity as a misleading null score', () => {
  expect(screenImageQuality(image(100), image(100), 16, 16)).toEqual({
    lumaPsnrDb: null,
    rgbPsnrDb: null,
    exact: true,
    blockSsim: 1,
    detailBlockSsim: null,
  });
});
it('distinguishes small errors from major image degradation', () => {
  const good = screenImageQuality(image(100), image(102), 16, 16),
    bad = screenImageQuality(image(100), image(200), 16, 16);
  expect(good.lumaPsnrDb!).toBeGreaterThan(bad.lumaPsnrDb!);
  expect(good.blockSsim).toBeGreaterThan(bad.blockSsim);
  expect(bad.exact).toBe(false);
});
it('penalizes blurred edges and supports partial blocks', () => {
  const reference = image(0);
  for (let pixel = 0; pixel < 256; pixel++)
    if (pixel % 16 < 8) reference.fill(255, pixel * 4, pixel * 4 + 4);
  expect(screenImageQuality(reference, image(128), 16, 16).blockSsim).toBeLessThan(0.5);
  expect(screenImageQuality(new Uint8ClampedArray(12), new Uint8ClampedArray(12), 3, 1).exact).toBe(
    true,
  );
  expect(() => screenImageQuality(image(1), image(2), 0, 16)).toThrow();
});
