import { expect, it } from 'vitest';
import { screenAdaptiveVideoPlan, screenVideoBudget } from './screen-adaptation';
import { screenVideoPlan } from './screen-quality';
const plan = (frameRate = 60) => {
  const quality = { profile: 'smooth', resolution: 1080, frameRate, videoBitrate: 8000000 };
  return screenVideoPlan(
    { revision: 1, publisher: quality, viewer: quality },
    { width: 1920, height: 1080, frameRate: 60 },
  );
};
it('does not preemptively blur or slow content when a lower bitrate ceiling is sufficient', () => {
  const original = plan();
  expect(screenAdaptiveVideoPlan(original, 2000000, 'detail').encoding).toEqual({
    ...original.encoding,
    maxBitrate: 2000000,
  });
  expect(screenAdaptiveVideoPlan(original, 2000000, 'motion').encoding).toEqual({
    ...original.encoding,
    maxBitrate: 2000000,
  });
});
it('chooses content policy independently of selected FPS while respecting both endpoint ceilings', () => {
  expect(screenAdaptiveVideoPlan(plan(60), 12000000, 'detail')).toMatchObject({
    content: 'detail',
    encoding: plan(60).encoding,
  });
  expect(screenAdaptiveVideoPlan(plan(15), 12000000, 'motion')).toMatchObject({
    content: 'motion',
    encoding: plan(15).encoding,
  });
  expect(() => screenAdaptiveVideoPlan(plan(), NaN, 'detail')).toThrow();
  expect(() => screenAdaptiveVideoPlan(plan(), 0, 'detail')).toThrow();
});
it('allocates a bounded total fairly and redistributes unused capacity from smaller viewers', () => {
  expect(screenVideoBudget([8000000, 8000000, 8000000], 12000000)).toEqual([
    4000000, 4000000, 4000000,
  ]);
  expect(screenVideoBudget([2000000, 8000000, 8000000], 12000000)).toEqual([
    2000000, 5000000, 5000000,
  ]);
  expect(screenVideoBudget([2000000], 12000000)).toEqual([2000000]);
  const nine = screenVideoBudget(Array(9).fill(8000000), 8000000);
  expect(nine.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(8000000);
  expect(screenVideoBudget([], 8000000)).toEqual([]);
  expect(() => screenVideoBudget([NaN], 8000000)).toThrow();
  expect(() => screenVideoBudget([100], 0)).toThrow();
});
