import { expect, it } from 'vitest';
import { parseVoiceConfig } from './config.js';
const base = { LIVEKIT_API_KEY: 'test-key', LIVEKIT_API_SECRET: 'a'.repeat(32) };
it('local voice configuration remains restricted to loopback control', () => {
  expect(
    parseVoiceConfig({ ...base, LIVEKIT_URL: 'http://127.0.0.1:7880' })?.useServerIceServers,
  ).toBe(false);
  expect(() => parseVoiceConfig({ ...base, LIVEKIT_URL: 'http://livekit:7880' })).toThrow();
});
it('hosted voice uses the private Docker control service and server ICE settings', () => {
  expect(
    parseVoiceConfig({ ...base, NODE_ENV: 'production', LIVEKIT_URL: 'http://livekit:7880' }),
  ).toMatchObject({ url: 'http://livekit:7880', useServerIceServers: true });
  for (const url of [
    'http://public.example:7880',
    'https://livekit:7880',
    'http://user:pass@livekit:7880',
    'http://livekit:7880/path',
  ])
    expect(() => parseVoiceConfig({ ...base, NODE_ENV: 'production', LIVEKIT_URL: url })).toThrow();
});
it('hosted startup rejects missing or incomplete voice credentials', () => {
  expect(parseVoiceConfig({})).toBeUndefined();
  expect(() => parseVoiceConfig({ NODE_ENV: 'production' })).toThrow();
  expect(() =>
    parseVoiceConfig({
      ...base,
      LIVEKIT_URL: 'http://127.0.0.1:7880',
      LIVEKIT_API_SECRET: 'short',
    }),
  ).toThrow();
});
