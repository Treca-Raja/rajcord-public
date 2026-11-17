import { expect, it } from 'vitest';
import { applicationAudioSupported } from './application-audio.js';

it('enables app-only capture only on the qualified Windows runtime', () => {
  expect(applicationAudioSupported('win32', '10.0.26100', '45.1.0')).toBe(true);
  for (const [platform, release, electron] of [
    ['win32', '10.0.19045', '45.1.0'],
    ['linux', '10.0.26100', '45.1.0'],
    ['win32', '10.0.26100', '45.2.0'],
    ['win32', 'invalid', '45.1.0'],
  ] as const)
    expect(applicationAudioSupported(platform, release, electron)).toBe(false);
});
