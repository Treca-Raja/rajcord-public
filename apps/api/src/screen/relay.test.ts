import { expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
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

it('issues coturn REST credentials with a stable opaque quota identity across renewals', () => {
  const secret = '3d'.repeat(32);
  const cfg = {
    url: 'http://127.0.0.1:7880',
    key: 'voice-key',
    secret: 'voice-secret',
    screenTurnHost: 'legacy.example.com',
    screenCoturn: { host: 'screen.example.com', secret },
  };
  const a = screenRelayServers(cfg, 'account-a', 100000)![1]!;
  const renewed = screenRelayServers(cfg, 'account-a', 101000)![1]!;
  expect(a.urls).toEqual([
    'turn:screen.example.com:3479?transport=udp',
    'turn:screen.example.com:3479?transport=tcp',
    'turns:screen.example.com:5350?transport=tcp',
  ]);
  expect(a.username).toMatch(/^160\.[a-f0-9]{32}$/);
  expect(renewed.username).toBe(a.username!.replace('160.', '161.'));
  expect(a.credential).toBe(createHmac('sha1', secret).update(a.username!).digest('base64'));
  expect(renewed.credential).not.toBe(a.credential);
  expect(screenRelayServers(cfg, 'account-b', 100000)![1]!.username).not.toBe(a.username);
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
