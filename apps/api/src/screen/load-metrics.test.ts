import { expect, it } from 'vitest';
import {
  screenLoadInterval,
  screenLoadRounds,
  screenLoadWorkload,
  screenMicrophoneFailures,
  screenPublisherInterval,
  screenRecoveryResults,
  screenSharedUplinkResults,
  type ScreenLoadSample,
} from './load-metrics';

it('checks each expected remote microphone independently of the other inbound audio', () => {
  const before = [
    { publisher: 0, trackId: 'mic-0', bytesReceived: 200 },
    { publisher: 1, trackId: 'mic-1', bytesReceived: 100 },
  ];
  const after = before.map((row) => ({ ...row, bytesReceived: row.bytesReceived + 500 }));
  expect(screenMicrophoneFailures(2, 2, before, after.toReversed())).toEqual([]);
  for (const silent of [
    [],
    [before[1]!],
    [{ ...after[1]!, bytesReceived: 10 }],
    [{ ...after[1]!, trackId: 'replaced' }],
    [{ ...after[1]!, publisher: null }],
    [after[1]!, after[1]!],
  ])
    expect(screenMicrophoneFailures(2, 2, before, [after[0]!, ...silent])).toEqual([
      'Microphone 1 did not advance on the same track at listener 2.',
    ]);
  expect(screenMicrophoneFailures(2, 2, [before[0]!], after)).toHaveLength(1);
  expect(screenMicrophoneFailures(2, 0, [before[1]!], [after[1]!])).toEqual([]);
  expect(screenMicrophoneFailures(1, 0, [], [])).toEqual([]);
});

it('defaults to ten voice participants, one publisher and two direct viewers', () => {
  expect(screenLoadWorkload({})).toEqual({
    count: 10,
    audience: { publishers: 1, viewers: 2 },
    rounds: [[{ publisher: 0, viewer: 1 }], [{ publisher: 0, viewer: 2 }]],
  });
  expect(screenLoadWorkload({ TRICORD_SCREEN_LOAD_CLIENTS: '2' }).rounds.flat()).toHaveLength(1);
  expect(screenLoadWorkload({ TRICORD_SCREEN_LOAD_CLIENTS: '20' }).rounds.flat()).toHaveLength(2);
});
it('keeps the all-to-all stress and custom audiences selectable', () => {
  const mesh = screenLoadWorkload({ TRICORD_SCREEN_LOAD_ALL_TO_ALL: '1' });
  expect(mesh.count).toBe(20);
  expect(mesh.rounds.flat()).toHaveLength(380);
  const custom = { TRICORD_SCREEN_LOAD_PUBLISHERS: '2', TRICORD_SCREEN_LOAD_VIEWERS: '3' };
  expect(screenLoadWorkload(custom).rounds.flat()).toHaveLength(6);
  expect(() => screenLoadWorkload({ ...custom, TRICORD_SCREEN_LOAD_ALL_TO_ALL: '1' })).toThrow();
  expect(() => screenLoadWorkload({ TRICORD_SCREEN_LOAD_VIEWERS: '2' })).toThrow();
  expect(() => screenLoadWorkload({ TRICORD_SCREEN_LOAD_ALL_TO_ALL: 'invalid' })).toThrow();
});

function samples(participants = 20) {
  const before: ScreenLoadSample[] = [],
    after: ScreenLoadSample[] = [];
  for (let publisher = 0; publisher < participants; publisher++)
    for (let viewer = 0; viewer < participants; viewer++) {
      if (publisher === viewer) continue;
      const first = {
        publisher,
        viewer,
        time: 1000,
        bytes: 100,
        decoded: 10,
        rendered: 10,
        direct: true,
        freezes: 0,
        width: 1920,
        height: 1080,
      };
      before.push(first);
      after.push({ ...first, time: 11000, bytes: 10000100, decoded: 610, rendered: 610 });
    }
  return { before, after };
}
it('requires all 380 directed subscriptions for twenty participants', () => {
  const f = samples();
  expect(screenLoadInterval(20, f.before, f.after)).toMatchObject({
    passed: true,
    expectedSubscriptions: 380,
    failures: [],
  });
  expect(screenLoadInterval(20, f.before, f.after.slice(1)).passed).toBe(false);
});

const networkSamples = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    elapsedMs: (i + 1) * 5000,
    result: {
      streams: [1, 2].map((viewer) => ({
        viewer,
        bitrate: 12000000,
        renderedFps: 58,
        freezeDelta: 0,
        direct1080p: true,
      })),
    },
  }));
it('uses matching peers and interval denominators for native sender and receiver delay', () => {
  const prev = {
    peer: 1,
    frames: 10,
    packetsSent: 50,
    totalEncodeTime: 1,
    totalPacketSendDelay: 0.5,
  };
  const next = {
    peer: 1,
    frames: 20,
    packetsSent: 100,
    totalEncodeTime: 1.125,
    totalPacketSendDelay: 0.75,
    roundTripTime: 0.015,
  };
  expect(screenPublisherInterval([prev], [next, { ...next, peer: 2 }])).toEqual([
    { peer: 1, meanPacketSendDelayMs: 5, meanEncodeMs: 12.5, roundTripMs: 15 },
    { peer: 2, meanPacketSendDelayMs: null, meanEncodeMs: null, roundTripMs: 15 },
  ]);
  expect(screenPublisherInterval([next], [prev, { ...next, peer: 2 }])[0]).toMatchObject({
    meanPacketSendDelayMs: null,
    meanEncodeMs: null,
    roundTripMs: null,
  });
  expect(screenPublisherInterval([next], [next])[0]?.meanPacketSendDelayMs).toBeNull();
  const { before, after } = samples(2);
  before[0] = { ...before[0]!, jitterBufferDelay: 1, jitterBufferEmittedCount: 100 };
  after[0] = { ...after[0]!, jitterBufferDelay: 1.5, jitterBufferEmittedCount: 200 };
  expect(
    screenLoadInterval(2, before, after).streams.find((row) => row.publisher === 0)
      ?.meanJitterBufferDelayMs,
  ).toBe(5);
});
it('separates healthy viewer quality from bitrate recovery and measures its actual observation window', () => {
  const rows = networkSamples(13);
  for (const row of rows.slice(3, 7)) row.result.streams[1]!.bitrate = 3000000;
  rows[4]!.result.streams[0]!.freezeDelta = 1;
  expect(screenRecoveryResults(rows, [1, 2], 2, 25100)).toMatchObject({
    healthy: [{ viewer: 1, passed: false }],
    recovered: true,
    recoveryWindowMs: [9900, 14900],
  });
  rows[4]!.result.streams[0]!.freezeDelta = 0;
  for (const row of rows.slice(5)) row.result.streams[1]!.bitrate = 3000000;
  expect(screenRecoveryResults(rows, [1, 2], 2, 25100)).toMatchObject({
    healthy: [{ passed: true }],
    recovered: false,
    recoveryWindowMs: null,
  });
  expect(screenRecoveryResults(rows.slice(1), [1, 2], 2, 25100)).toBeNull();
});
it('requires aggregate evidence for the capped uplink and both links for recovery', () => {
  const rows = networkSamples(27);
  for (const row of rows.slice(0, 3)) row.result.streams.pop();
  for (const row of rows.slice(4, 9)) for (const link of row.result.streams) link.bitrate = 8000000;
  rows[9]!.result.streams[1]!.bitrate = 8000000;
  expect(screenSharedUplinkResults(rows, 18000000, 45100)).toMatchObject({
    aggregateLimitObserved: true,
    twoViewerMedian: 16000000,
    recoveryWindowMs: [4900, 9900],
  });
  expect(screenSharedUplinkResults(rows, null, 45100)).toMatchObject({
    twoViewerMedian: 16000000,
    aggregateLimitObserved: null,
  });
  for (const row of rows.slice(4, 9))
    for (const link of row.result.streams) link.bitrate = 12000000;
  expect(screenSharedUplinkResults(rows, 18000000, 45100)?.aggregateLimitObserved).toBe(false);
  rows[6]!.result.streams.pop();
  expect(screenSharedUplinkResults(rows, 18000000, 45100)).toBeNull();
});
it.each([2, 4, 8])('applies the full quality checks to a %i-person capacity run', (count) => {
  const { before, after } = samples(count);
  expect(screenLoadInterval(count, before, after)).toMatchObject({
    passed: true,
    expectedSubscriptions: count * (count - 1),
  });
  after[0] = { ...after[0]!, rendered: 310 };
  expect(screenLoadInterval(count, before, after).failures).toEqual([
    '0:1: rendered frame rate below 57 fps',
  ]);
});
it('scores only the intended audiences and detects missing or unexpected deliveries', () => {
  const routes = screenLoadRounds(6, { publishers: 2, viewers: 2 }).flat();
  expect(routes).toEqual([
    { publisher: 0, viewer: 2 },
    { publisher: 1, viewer: 3 },
    { publisher: 0, viewer: 4 },
    { publisher: 1, viewer: 5 },
  ]);
  const { before, after } = samples(6);
  const wanted = (s: ScreenLoadSample) =>
    routes.some((r) => r.viewer === s.viewer && r.publisher === s.publisher);
  const first = before.filter(wanted),
    last = after.filter(wanted);
  expect(screenLoadInterval(6, first, last, 60, routes)).toMatchObject({
    passed: true,
    expectedSubscriptions: 4,
  });
  expect(
    screenLoadInterval(6, first, [...last.slice(1), after.find((s) => !wanted(s))!], 60, routes)
      .passed,
  ).toBe(false);
  expect(() => screenLoadRounds(6, { publishers: 2, viewers: 3 })).toThrow('separate audience');
});
it('does not hide a single low-resolution, slow or frozen viewer behind the fleet average', () => {
  for (const patch of [
    { width: 1280, height: 720 },
    { decoded: 160 },
    { rendered: 160 },
    { direct: false },
    { freezes: 1 },
    { bytes: 100 },
    { freezes: null },
  ]) {
    const f = samples();
    f.after[0] = { ...f.after[0]!, ...patch };
    expect(screenLoadInterval(20, f.before, f.after).passed).toBe(false);
  }
});
it('scores an explicitly selected 30 fps profile independently from the 60 fps target', () => {
  const { before, after } = samples(2);
  const thirty = after.map((sample) => ({ ...sample, decoded: 310, rendered: 310 }));
  expect(screenLoadInterval(2, before, thirty, 30).passed).toBe(true);
  expect(screenLoadInterval(2, before, thirty).passed).toBe(false);
  thirty[0]!.rendered -= 2;
  expect(screenLoadInterval(2, before, thirty, 30).failures).toEqual([
    '0:1: rendered frame rate below 30 fps',
  ]);
});
it('reports quantization only across comparable codec and frame counters', () => {
  const { before, after } = samples(2);
  before[0] = { ...before[0]!, codec: 'video/VP8', qpSum: 100 };
  after[0] = { ...after[0]!, codec: 'video/VP8', qpSum: 12100 };
  expect(screenLoadInterval(2, before, after).streams.find((s) => s.publisher === 0)?.meanQp).toBe(
    20,
  );
  after[0] = { ...after[0]!, codec: 'video/H264' };
  expect(
    screenLoadInterval(2, before, after).streams.find((s) => s.publisher === 0)?.meanQp,
  ).toBeNull();
});
it('rejects duplicate, self and out-of-roster subscriptions', () => {
  const f = samples(2);
  for (const invalid of [f.after[0]!, { ...f.after[0]!, viewer: 0 }, { ...f.after[0]!, viewer: 2 }])
    expect(() => screenLoadInterval(2, f.before, [...f.after, invalid])).toThrow(
      'Invalid or duplicate',
    );
});
it.each([
  [60, 58, true],
  [57, 57, true],
  [60, 56.9, false],
  [51, 58, false],
  [60, 51, false],
])(
  'scores %i decoded and %i presented fps for one 60 fps subscription',
  (decoded, rendered, passed) => {
    const f = samples(2);
    f.after[0] = { ...f.after[0]!, decoded: 10 + decoded * 10, rendered: 10 + rendered * 10 };
    expect(screenLoadInterval(2, f.before, f.after)).toMatchObject({
      minimumFps: 57,
      passed,
      cadencePassed: passed,
    });
  },
);
it('rejects counter resets', () => {
  const f = samples(2);
  f.after[0] = { ...f.after[0]!, time: 1000, bytes: 0 };
  expect(screenLoadInterval(2, f.before, f.after).failures).toContain(
    '0:1: invalid or reset counters',
  );
});
