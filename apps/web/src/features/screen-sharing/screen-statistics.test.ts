import { expect, it } from 'vitest';
import { ScreenStatistics } from './screen-statistics';

const report = (time: number, patch: Record<string, unknown> = {}, inbound = false) =>
  new Map([
    [
      'video',
      {
        id: 'video',
        timestamp: time,
        type: inbound ? 'inbound-rtp' : 'outbound-rtp',
        kind: 'video',
        bytesSent: time * 100,
        bytesReceived: time * 100,
        framesEncoded: time * 0.03,
        framesDecoded: time * 0.03,
        totalEncodeTime: time * 0.00015,
        totalDecodeTime: time * 0.00015,
        packetsReceived: time,
        packetsLost: time * 0.01,
        freezeCount: 2,
        frameWidth: 1280,
        frameHeight: 720,
        qualityLimitationReason: 'none',
        codecId: 'codec',
        ...patch,
      },
    ],
    [
      'remote',
      {
        id: 'remote',
        timestamp: time,
        type: 'remote-inbound-rtp',
        localId: 'video',
        packetsLost: time * 0.01,
        packetsReceived: time,
        roundTripTime: 0.05,
      },
    ],
    [
      'transport',
      { id: 'transport', timestamp: time, type: 'transport', selectedCandidatePairId: 'pair' },
    ],
    [
      'pair',
      {
        id: 'pair',
        timestamp: time,
        type: 'candidate-pair',
        localCandidateId: 'local',
        remoteCandidateId: 'distant',
        currentRoundTripTime: 0.1,
      },
    ],
    [
      'local',
      {
        id: 'local',
        timestamp: time,
        type: 'local-candidate',
        candidateType: 'host',
        address: 'private-address',
      },
    ],
    [
      'distant',
      {
        id: 'distant',
        timestamp: time,
        type: 'remote-candidate',
        candidateType: 'relay',
        address: 'private-address',
      },
    ],
    ['codec', { id: 'codec', timestamp: time, type: 'codec', mimeType: 'video/VP8' }],
  ]) as unknown as RTCStatsReport;

it('measures interval rates, work and loss without exposing candidate or source identities', () => {
  const statistics = new ScreenStatistics();
  expect(statistics.sample(report(1000), 'outbound')).toMatchObject({ bitrate: null, fps: null });
  const sample = statistics.sample(report(3000), 'outbound');
  expect(sample).toMatchObject({
    bitrate: 800000,
    fps: 30,
    width: 1280,
    height: 720,
    roundTripTime: 0.05,
    route: 'relay',
    codec: 'video/VP8',
  });
  expect(sample?.workMsPerFrame).toBeCloseTo(5);
  expect(sample?.loss).toBeCloseTo(20 / 2020);
  expect(Object.isFrozen(sample)).toBe(true);
  expect(JSON.stringify(sample)).not.toContain('private-address');
});

it.each([
  ['outbound', 'totalPacketSendDelay', 'packetsSent', 'meanPacketSendDelayMs'],
  ['inbound', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'meanJitterBufferDelayMs'],
] as const)(
  'measures %s delay per packet or emitted frame over the current interval',
  (direction, delay, count, field) => {
    const stats = new ScreenStatistics();
    const sample = (time: number, seconds: number, events: number) =>
      stats.sample(
        report(time, { [delay]: seconds, [count]: events }, direction === 'inbound'),
        direction,
      )?.[field];
    expect(sample(1000, 1, 100)).toBeNull();
    expect(sample(2000, 1.5, 120)).toBe(25);
    expect(sample(3000, 1.5, 120)).toBeNull();
    expect(sample(4000, 0.1, 1)).toBeNull();
  },
);

it('reports counter resets, replaced streams, missing stats and long intervals as unknown', () => {
  const statistics = new ScreenStatistics();
  statistics.sample(report(1000), 'outbound');
  expect(
    statistics.sample(report(2000, { bytesSent: 1, framesEncoded: 1 }), 'outbound'),
  ).toMatchObject({ bitrate: null, fps: null });
  expect(statistics.sample(report(25000), 'outbound')).toMatchObject({ bitrate: null, fps: null });
  expect(statistics.sample(report(26000, { id: 'replacement' }), 'outbound')?.bitrate).toBeNull();
  expect(statistics.sample(new Map() as unknown as RTCStatsReport, 'outbound')).toBeNull();
});

it('does not treat a static screen as a freeze and measures receiver freeze increments', () => {
  const statistics = new ScreenStatistics();
  statistics.sample(report(1000, { framesDecoded: 1 }, true), 'inbound');
  expect(statistics.sample(report(3000, { framesDecoded: 1 }, true), 'inbound')).toMatchObject({
    fps: 0,
    freezes: 0,
  });
  expect(statistics.sample(report(5000, { freezeCount: 3 }, true), 'inbound')?.freezes).toBe(1);
});

it('reports source cadence only for the linked outbound video source', () => {
  const rows = new Map(report(1000, { mediaSourceId: 'source' }));
  rows.set('source', { type: 'media-source', kind: 'video', framesPerSecond: 60 });
  const stats = new ScreenStatistics();
  expect(stats.sample(rows as RTCStatsReport, 'outbound')?.sourceFps).toBe(60);
  rows.delete('source');
  expect(stats.sample(rows as RTCStatsReport, 'outbound')?.sourceFps).toBeNull();
});

it('measures receiver rendering and drops independently of decoding, including unsupported and reset counters', () => {
  const stats = new ScreenStatistics();
  expect(
    stats.sample(report(1000, { framesRendered: 20, framesDropped: 2 }, true), 'inbound')
      ?.renderedFps,
  ).toBeNull();
  expect(
    stats.sample(report(3000, { framesRendered: 70, framesDropped: 4 }, true), 'inbound'),
  ).toMatchObject({
    fps: 30,
    renderedFps: 25,
    receiverDroppedFrames: 2,
    sourceFps: null,
  });
  expect(
    stats.sample(report(4000, { framesRendered: 0, framesDropped: 0 }, true), 'inbound'),
  ).toMatchObject({
    renderedFps: null,
    receiverDroppedFrames: null,
  });
  expect(stats.sample(report(5000, {}, true), 'inbound')?.receiverDroppedFrames).toBeNull();
});

it('does not invent unsupported values or include invalid numbers', () => {
  const statistics = new ScreenStatistics();
  const sample = statistics.sample(
    report(1000, { frameWidth: NaN, qualityLimitationReason: 'unknown', codecId: 'missing' }),
    'outbound',
  );
  expect(sample).toMatchObject({ width: null, limitation: null, codec: null });
});

it('measures retransmission cost and codec-local quantization without inventing hardware support', () => {
  const statistics = new ScreenStatistics();
  statistics.sample(report(1000, { qpSum: 300, retransmittedBytesSent: 500 }), 'outbound');
  const sample = statistics.sample(
    report(3000, {
      qpSum: 900,
      retransmittedBytesSent: 1500,
      targetBitrate: 2000000,
      powerEfficientEncoder: false,
    }),
    'outbound',
  );
  expect(sample).toMatchObject({
    qpMean: 10,
    retransmitBitrate: 4000,
    targetBitrate: 2000000,
    powerEfficientEncoder: false,
  });
  expect(statistics.sample(report(5000, { qpSum: 1 }), 'outbound')).toMatchObject({
    qpMean: null,
    powerEfficientEncoder: null,
  });
});
