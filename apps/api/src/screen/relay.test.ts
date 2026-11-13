import { expect, it } from 'vitest';
import { livekitBase62, screenRelayServers } from './relay.js';

it.each([
  ['', ''],
  ['00', 'AA'],
  ['ff', 'fH'],
  ['00ff', 'fHA'],
  ['7beaff', 'fX99A'],
])('preserves the pinned LiveKit binary base62 wire vector %s', (hex, encoded) => {
  expect(livekitBase62(Buffer.from(hex!, 'hex'))).toBe(encoded);
});
it('is opt-in and separates account/expiry credentials without disclosing the signing secret or a room JWT', () => {
  const config = { url: 'http://127.0.0.1:7880', key: 'fixture-key', secret: 'fixture-secret' };
  expect(screenRelayServers(config, 'account-a', 100000)).toBeUndefined();
  const enabled = { ...config, screenTurnHost: 'turn.rajcord.com' };
  const a = screenRelayServers(enabled, 'account-a', 100000)!;
  expect(a[1]!.username).toMatch(/^[A-Za-z0-9]+$/);
  expect(a[1]!.credential).toMatch(/^[A-Za-z0-9]+$/);
  expect(JSON.stringify(a)).not.toContain(config.secret);
  expect(screenRelayServers(enabled, 'account-b', 100000)).not.toEqual(a);
  expect(screenRelayServers(enabled, 'account-a', 101000)).not.toEqual(a);
});
