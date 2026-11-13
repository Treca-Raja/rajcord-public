import { expect, it } from 'vitest';
import { screenIceServers, publicScreenIceServers, sameScreenIceServers } from './screen-ice';

it('uses public STUN discovery with no relay, credentials or microphone voice settings', () => {
  expect(screenIceServers(publicScreenIceServers)).toEqual([
    { urls: ['stun:stun.cloudflare.com:3478'] },
  ]);
  expect(screenIceServers()).toEqual([]);
  expect(
    sameScreenIceServers(publicScreenIceServers, [
      { urls: ['stun:stun.cloudflare.com:3478'], username: '', credential: '' },
    ]),
  ).toBe(true);
  expect(
    sameScreenIceServers(publicScreenIceServers, [{ urls: ['stun:stun.cloudflare.com:3478'] }]),
  ).toBe(true);
});
it.each(
  [
    [{ urls: 'turn:relay.example:3478' }],
    [{ urls: 'turns:relay.example:5349' }],
    [{ urls: ['stun:stun.example:3478', 'turn:relay.example:3478'] }],
    [{ urls: 'stun:stun.example:3478', username: 'voice-user' }],
    [{ urls: 'stun:stun.example:3478', credential: 'voice-secret' }],
    [{ urls: 'https://example.com' }],
    [{ urls: 'stun:stun.example:0' }],
    [{ urls: 'stun:stun.example:65536' }],
    [{ urls: [] }],
  ].map((servers) => ({ servers })),
)(
  'rejects unauthenticated relays, credentials and malformed STUN policy $servers',
  ({ servers }) => {
    expect(() => screenIceServers(servers)).toThrow();
  },
);
it('copies URLs and detects injected native ICE policy changes', () => {
  const original = [{ urls: ['stun:stun.example:3478'] }];
  const copied = screenIceServers(original);
  original[0]!.urls[0] = 'turn:relay.example:3478';
  expect(copied).toEqual([{ urls: ['stun:stun.example:3478'] }]);
  expect(sameScreenIceServers(copied, publicScreenIceServers)).toBe(false);
});

it('accepts explicit ephemeral relay credentials, copies them and rejects credential scope confusion', () => {
  const relay = {
    urls: ['turn:turn.rajcord.com:3478?transport=udp', 'turns:turn.rajcord.com:5349?transport=tcp'],
    username: 'TemporaryUsername',
    credential: 'TemporaryPassword',
  };
  const copied = screenIceServers([relay]);
  expect(copied).toEqual([relay]);
  expect(copied[0]).not.toBe(relay);
  expect(sameScreenIceServers(copied, [relay])).toBe(true);
  expect(() =>
    screenIceServers([{ ...relay, urls: ['stun:stun.example:3478', relay.urls[0]!] }]),
  ).toThrow('scope');
  expect(() => screenIceServers([{ ...relay, credential: 'x'.repeat(129) }])).toThrow();
  expect(() => screenIceServers([{ ...relay, credentialType: 'oauth' } as RTCIceServer])).toThrow(
    'credential type',
  );
  expect(() =>
    screenIceServers([{ ...relay, urls: ['turns:turn.rajcord.com:5349?transport=udp'] }]),
  ).toThrow();
});
