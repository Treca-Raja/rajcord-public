import { describe, expect, it } from 'vitest';
import { renderedAudioTiming } from './obs-av-timing.mjs';

describe('rendered OBS audio timing', () => {
  it('calibrates steady-state offset separately from the first marker and reports drift', () => {
    const video = Array.from({ length: 40 }, (_, i) => 800 * i);
    const audio = video.map((time, i) => time + 24 + (i === 0 ? 80 : i < 20 ? -20 : -38));
    expect(renderedAudioTiming(video, audio, { medianMs: 24 }, 0)).toMatchObject({
      matched: 40,
      steadyMarkers: 32,
      startupMarkerMs: 80,
      calibratedMedianMs: -38,
      calibratedP95AbsoluteMs: 38,
      driftMs: -18,
    });
  });

  it('does not reuse a captured audio edge or invent offset for missing edges', () => {
    expect(renderedAudioTiming([800, 1000, 1600], [924], { medianMs: 24 }, 0)).toMatchObject({
      matched: 1,
      visualMarkers: 3,
      startupMarkerMs: 100,
      steadyMarkers: 0,
      calibratedMedianMs: undefined,
    });
  });
});
