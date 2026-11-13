import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { description, ice, signal } from './signaling.js';
import { screenSdp, screenIce } from './signaling-fixture.js';
import { ScreenBudget, ScreenOutput } from './budget.js';
import { parseScreenDescription, parseScreenIce, parseScreenSignal } from '@tricord/shared';

describe('strict direct-screen envelopes', () => {
  it.each([
    '192.0.2.1',
    '0.0.0.0',
    '255.255.255.255',
    '::1',
    '2001:db8::1',
    '::ffff:192.0.2.1',
    'owned-source.local',
  ])('portable and API parsers agree for direct address %s', (address) => {
    const candidate = {
      ...screenIce,
      candidate: screenIce.candidate.replace('192.0.2.1', address),
    };
    expect(parseScreenIce(candidate)).toEqual(ice(candidate));
    const sdp = screenSdp('offer').replace('a=mid:0', 'a=mid:0\r\na=' + candidate.candidate);
    expect(parseScreenDescription(sdp, 'offer')).toEqual(description(sdp, 'offer'));
  });
  it.each([
    'example.com',
    '127.1',
    '192.000.2.1',
    '256.0.0.1',
    '[::1]',
    '2001:::1',
    '::1/turn',
    'user@owned.local',
  ])('portable and API parsers reject unsafe address %s', (address) => {
    const candidate = {
      ...screenIce,
      candidate: screenIce.candidate.replace('192.0.2.1', address),
    };
    expect(() => parseScreenIce(candidate)).toThrow();
    expect(() => ice(candidate)).toThrow();
  });
  it('preserves API validation status/messages while sharing the browser grammar', () => {
    for (const [value, message] of [
      [null, 'Invalid request.'],
      [{ unknown: true }, 'Unexpected request field.'],
      [
        {
          epoch: 'fake',
          linkId: randomUUID(),
          revision: 1,
          sequence: 1,
          payload: { type: 'offer', sdp: screenSdp('offer') },
        },
        'Invalid identifier.',
      ],
    ] as const) {
      expect(() => signal(value)).toThrow(message);
      try {
        signal(value);
      } catch (error) {
        expect(error).toMatchObject({ statusCode: 400 });
      }
      expect(() => parseScreenSignal(value)).toThrow(message);
    }
  });
  it('accepts bounded unidirectional video/source sound and LAN/mDNS direct candidates', () => {
    for (const type of ['offer', 'answer'] as const) {
      expect(description(screenSdp(type), type).mids).toEqual(['0', '1']);
      expect(description(screenSdp(type, false), type).mids).toEqual(['0']);
    }
    expect(ice(screenIce)).toEqual(screenIce);
    expect(
      ice({ ...screenIce, candidate: screenIce.candidate.replace('192.0.2.1', 'fixture.local') })
        .candidate,
    ).toContain('fixture.local');
  });
  it.each([
    (s: string) => s.replace('m=video', 'm=application'),
    (s: string) => s.replace('a=sendonly', 'a=sendrecv'),
    (s: string) => s.replace('a=mid:1', 'a=mid:0'),
    (s: string) => s.replace('a=rtcp-mux', 'a=rtcp-mux\r\na=recvonly'),
    (s: string) => s.replace('UDP/TLS/RTP/SAVPF', 'RTP/AVP'),
    (s: string) => s + 'a=x:' + 'x'.repeat(12288) + '\r\n',
    (s: string) => s.replace('a=ice-ufrag:test', 'a=ice-ufrag:x'),
    (s: string) => s.replace('a=mid:0', 'a=mid:0\nBAD'),
    (s: string) =>
      s.replace(
        'a=mid:0',
        'a=mid:0\r\na=' + screenIce.candidate.replace('typ host', 'typ invalid'),
      ),
  ])('rejects unsafe or oversized SDP %s', (change) => {
    expect(() => description(change(screenSdp('offer')), 'offer')).toThrow();
  });
  it.each([
    { ...screenIce, candidate: screenIce.candidate.replace('typ host', 'typ invalid') },
    { ...screenIce, candidate: screenIce.candidate + '\r\na=sendrecv' },
    { ...screenIce, candidate: screenIce.candidate + ' turn:server 1' },
    { ...screenIce, candidate: 'x'.repeat(2049) },
    { ...screenIce, usernameFragment: 'wrong' },
    { ...screenIce, sdpMLineIndex: 2 },
    { ...screenIce, token: 'injected' },
  ])('rejects invalid or relay ICE %#', (candidate) => expect(() => ice(candidate)).toThrow());
  it('rejects injected caller context, mixed payloads and unsafe sequences before authorization', () => {
    const request = {
      epoch: randomUUID(),
      linkId: randomUUID(),
      revision: 1,
      sequence: 1,
      payload: { type: 'offer', sdp: screenSdp('offer') },
    };
    expect(signal(request)).toEqual(request);
    for (const mutation of [
      { token: 'fake' },
      { transportId: 'fake' },
      { sequence: 0 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { payload: { ...request.payload, candidate: screenIce } },
    ])
      expect(() => signal({ ...request, ...mutation })).toThrow();
  });
});

describe('screen work admission', () => {
  it('bounds screen output to stalled transports without retaining payloads or resetting on retries', () => {
    const output = new ScreenOutput();
    for (let i = 0; i < 32; i++) expect(output.take(false, [{ result: i }])).toBe(true);
    expect(output.take(false, [{}])).toBe(false);
    expect(output.take(false, [{}])).toBe(false);
    expect(output.take(true, [{}])).toBe(true);
    expect(output.take(false, ['x'.repeat(65536)])).toBe(false);
    expect(output.take(false, Array(32).fill({}))).toBe(false);
  });
  it('bounds slow work globally and per account without releasing unfinished authorization', () => {
    const b = new ScreenBudget(() => 0),
      release: (() => void)[] = [];
    for (let i = 0; i < 10; i++)
      for (let j = 0; j < 2; j++) release.push(b.acquire('account' + i, 'signal', 200));
    expect(() => b.acquire('extra', 'signal', 200)).toThrow(/busy/);
    expect(() => b.acquire('account0', 'signal', 200)).toThrow(/busy/);
    release[0]!();
    release[0]!();
    const finish = b.acquire('account0', 'signal', 200);
    expect(() => b.acquire('extra', 'signal', 200)).toThrow(/busy/);
    finish();
    for (const done of release) done();
    expect(() => b.acquire('extra', 'signal', 200)).not.toThrow();
  });
  it('admits ten 128-candidate bursts in waves and throttles bytes, controls and renewals independently', () => {
    let now = 0;
    const b = new ScreenBudget(() => now);
    for (let wave = 0; wave < 128; wave++)
      for (let i = 0; i < 10; i++) b.acquire('a' + i, 'signal', 220)();
    for (let i = 0; i < 10; i++) b.acquire('a0', 'control', 100)();
    expect(() => b.acquire('a0', 'control', 100)).toThrow(/budget/);
    for (let i = 0; i < 3; i++) b.acquire('a0', 'renew', 100)();
    expect(() => b.acquire('a0', 'renew', 100)).toThrow(/budget/);
    expect(() => b.acquire('a0', 'signal', 524288)).toThrow(/budget/);
    now = 60000;
    expect(() => b.acquire('a0', 'control', 100)).not.toThrow();
  });
  it('enforces service-wide rate ceilings despite independent account allowance', () => {
    const b = new ScreenBudget(() => 0);
    for (let i = 0; i < 1800; i++) b.acquire('a' + (i % 20), 'signal', 100)();
    expect(() => b.acquire('new', 'signal', 100)).toThrow(/budget/);
    const bytes = new ScreenBudget(() => 0);
    for (let i = 0; i < 10; i++) bytes.acquire('a' + i, 'signal', 524288)();
    expect(() => bytes.acquire('new', 'signal', 1)).toThrow(/budget/);
  });
});

it('accepts a bounded TURN relay candidate while preserving the strict candidate envelope', () => {
  const relay = { ...screenIce, candidate: screenIce.candidate.replace('typ host', 'typ relay') };
  expect(ice(relay)).toEqual(relay);
});
