export type ScreenLoadSample = Readonly<{
  publisher: number;
  viewer: number;
  time: number;
  bytes: number;
  decoded: number;
  packetsLost?: number;
  nackCount?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  qpSum?: number;
  codec?: string;
  rendered: number;
  direct: boolean;
  freezes: number | null;
  width: number;
  height: number;
}>;

const intervalDelta = (before: number | undefined, after: number | undefined) =>
  before !== undefined &&
  after !== undefined &&
  Number.isFinite(before) &&
  Number.isFinite(after) &&
  before >= 0 &&
  after >= before
    ? after - before
    : null;
const meanMs = (seconds: number | null, count: number | null) =>
  seconds !== null && count !== null && count > 0 ? (seconds * 1000) / count : null;
export type ScreenLoadMicrophone = {
  publisher: number | null;
  trackId?: string;
  bytesReceived?: number;
};
export function screenMicrophoneFailures(
  activeMicrophones: number,
  listener: number,
  before: readonly ScreenLoadMicrophone[],
  after: readonly ScreenLoadMicrophone[],
) {
  const failures: string[] = [];
  for (let publisher = 0; publisher < activeMicrophones; publisher++) {
    if (publisher === listener) continue;
    const first = before.filter((row) => row.publisher === publisher);
    const last = after.filter((row) => row.publisher === publisher);
    if (
      first.length !== 1 ||
      last.length !== 1 ||
      !first[0]!.trackId ||
      first[0]!.trackId !== last[0]!.trackId ||
      (intervalDelta(first[0]!.bytesReceived, last[0]!.bytesReceived) ?? 0) <= 0
    )
      failures.push(
        `Microphone ${publisher} did not advance on the same track at listener ${listener}.`,
      );
  }
  return failures;
}
export type ScreenPublisherCounters = {
  peer: number;
  frames: number;
  packetsSent?: number;
  totalEncodeTime?: number;
  totalPacketSendDelay?: number;
  roundTripTime?: number;
};
export function screenPublisherInterval(
  before: readonly ScreenPublisherCounters[],
  after: readonly ScreenPublisherCounters[],
) {
  return after.map((row) => {
    const previous = before.find((item) => item.peer === row.peer);
    return {
      peer: row.peer,
      meanPacketSendDelayMs: meanMs(
        intervalDelta(previous?.totalPacketSendDelay, row.totalPacketSendDelay),
        intervalDelta(previous?.packetsSent, row.packetsSent),
      ),
      meanEncodeMs: meanMs(
        intervalDelta(previous?.totalEncodeTime, row.totalEncodeTime),
        intervalDelta(previous?.frames, row.frames),
      ),
      roundTripMs: row.roundTripTime === undefined ? null : row.roundTripTime * 1000,
    };
  });
}

export function screenLoadWorkload(env: Readonly<Record<string, string | undefined>>) {
  const mesh = env.TRICORD_SCREEN_LOAD_ALL_TO_ALL ?? '0';
  if (mesh !== '0' && mesh !== '1')
    throw new Error('TRICORD_SCREEN_LOAD_ALL_TO_ALL must be 0 or 1.');
  const count = Number(env.TRICORD_SCREEN_LOAD_CLIENTS ?? (mesh === '1' ? 20 : 10));
  const publishers = env.TRICORD_SCREEN_LOAD_PUBLISHERS,
    viewers = env.TRICORD_SCREEN_LOAD_VIEWERS;
  if (
    (publishers === undefined) !== (viewers === undefined) ||
    (mesh === '1' && publishers !== undefined)
  )
    throw new Error(
      'Set both publisher and viewer counts for a custom audience, or select all-to-all alone.',
    );
  const audience =
    mesh === '1'
      ? undefined
      : {
          publishers: Number(publishers ?? 1),
          viewers: Number(viewers ?? Math.min(2, count - 1)),
        };
  return { count, audience, rounds: screenLoadRounds(count, audience) };
}

export function screenLoadRounds(
  participants: number,
  audience?: { publishers: number; viewers: number },
) {
  if (!Number.isInteger(participants) || participants < 2 || participants > 20)
    throw new Error('The local capacity fixture supports 2 through 20 participants.');
  const rounds: { publisher: number; viewer: number }[][] = [];
  if (audience) {
    const { publishers, viewers } = audience;
    if (
      ![publishers, viewers].every((n) => Number.isSafeInteger(n) && n > 0) ||
      publishers * (1 + viewers) > participants
    )
      throw new Error('Each publisher needs a separate audience within the voice room.');
    for (let slot = 0; slot < viewers; slot++)
      rounds.push(
        Array.from({ length: publishers }, (_, publisher) => ({
          publisher,
          viewer: publishers + slot * publishers + publisher,
        })),
      );
  } else {
    for (let offset = 1; offset < participants; offset++)
      rounds.push(
        Array.from({ length: participants }, (_, viewer) => ({
          publisher: (viewer + offset) % participants,
          viewer,
        })),
      );
  }
  return rounds;
}

// Test-only acceptance: every directed subscription must pass independently.
export function screenLoadInterval(
  participants: number,
  before: readonly ScreenLoadSample[],
  after: readonly ScreenLoadSample[],
  frameRate: 30 | 60 = 60,
  routes = screenLoadRounds(participants).flat(),
) {
  if (!Number.isInteger(participants) || participants < 2)
    throw new Error('At least two stress participants are required.');
  const failures: string[] = [];
  const minimumFps = frameRate === 60 ? 57 : frameRate;
  let cadencePassed = true;
  const expected = new Set(routes.map(({ publisher, viewer }) => publisher + ':' + viewer));
  const index = (samples: readonly ScreenLoadSample[]) => {
    const result = new Map<string, ScreenLoadSample>();
    for (const sample of samples) {
      const key = sample.publisher + ':' + sample.viewer;
      if (
        ![sample.publisher, sample.viewer].every(
          (value) => Number.isInteger(value) && value >= 0 && value < participants,
        ) ||
        sample.publisher === sample.viewer ||
        result.has(key)
      )
        throw new Error('Invalid or duplicate stress subscription.');
      result.set(key, sample);
      if (!expected.has(key)) failures.push(key + ': unexpected subscription');
    }
    return result;
  };
  const first = index(before),
    last = index(after);
  const streams: {
    publisher: number;
    viewer: number;
    decodedFps: number;
    renderedFps: number;
    bitrate: number;
    freezeDelta: number | null;
    meanJitterBufferDelayMs: number | null;
    direct1080p: boolean;
    meanQp: number | null;
  }[] = [];
  for (const { publisher, viewer } of routes) {
    const key = publisher + ':' + viewer,
      a = first.get(key),
      b = last.get(key);
    if (!a || !b) {
      failures.push(key + ': missing subscription');
      continue;
    }
    const seconds = (b.time - a.time) / 1000;
    if (
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      ![a.bytes, b.bytes, a.decoded, b.decoded, a.rendered, b.rendered].every(
        (value) => Number.isFinite(value) && value >= 0,
      ) ||
      b.bytes < a.bytes ||
      b.decoded < a.decoded ||
      b.rendered < a.rendered
    ) {
      failures.push(key + ': invalid or reset counters');
      continue;
    }
    const decoded = b.decoded - a.decoded,
      rendered = b.rendered - a.rendered;
    streams.push({
      publisher,
      viewer,
      decodedFps: decoded / seconds,
      renderedFps: rendered / seconds,
      meanJitterBufferDelayMs: meanMs(
        intervalDelta(a.jitterBufferDelay, b.jitterBufferDelay),
        intervalDelta(a.jitterBufferEmittedCount, b.jitterBufferEmittedCount),
      ),
      bitrate: ((b.bytes - a.bytes) * 8) / seconds,
      freezeDelta:
        a.freezes !== null &&
        b.freezes !== null &&
        Number.isFinite(a.freezes) &&
        Number.isFinite(b.freezes) &&
        a.freezes >= 0 &&
        b.freezes >= a.freezes
          ? b.freezes - a.freezes
          : null,
      direct1080p: [a, b].every(
        (sample) => sample.direct && sample.width === 1920 && sample.height === 1080,
      ),
      meanQp:
        decoded > 0 &&
        a.codec &&
        a.codec === b.codec &&
        a.qpSum !== undefined &&
        Number.isFinite(a.qpSum) &&
        b.qpSum !== undefined &&
        Number.isFinite(b.qpSum) &&
        b.qpSum >= a.qpSum
          ? (b.qpSum - a.qpSum) / decoded
          : null,
    });
    if ([a, b].some((sample) => sample.width !== 1920 || sample.height !== 1080))
      failures.push(key + ': resolution below 1920x1080');
    if (!a.direct || !b.direct) failures.push(key + ': direct route unavailable');
    // Preserve the 30 fps profile's existing interval endpoint allowance.
    const required =
      frameRate === 60 ? seconds * minimumFps : Math.max(1, Math.floor(seconds * minimumFps) - 1);
    if (decoded < required || rendered < required) cadencePassed = false;
    if (decoded < required)
      failures.push(key + ': decoded frame rate below ' + minimumFps + ' fps');
    if (rendered < required)
      failures.push(key + ': rendered frame rate below ' + minimumFps + ' fps');
    if (b.bytes === a.bytes) failures.push(key + ': no video payload');
    if (
      a.freezes === null ||
      b.freezes === null ||
      !Number.isFinite(a.freezes) ||
      !Number.isFinite(b.freezes) ||
      a.freezes < 0 ||
      b.freezes < a.freezes
    )
      failures.push(key + ': freeze measurement unavailable or reset');
    else if (b.freezes !== a.freezes) failures.push(key + ': video froze');
  }
  return {
    passed: failures.length === 0,
    minimumFps,
    cadencePassed: cadencePassed && streams.length === routes.length && routes.length > 0,
    expectedSubscriptions: routes.length,
    streams,
    failures,
  };
}

type RecoveryStream = Pick<
  ReturnType<typeof screenLoadInterval>['streams'][number],
  'viewer' | 'bitrate' | 'renderedFps' | 'freezeDelta' | 'direct1080p'
>;
type RecoverySample = { elapsedMs: number; result: { streams: readonly RecoveryStream[] } };
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
function recoveryWindow(samples: readonly RecoverySample[], index: number, restoredAtMs: number) {
  return index < 1
    ? null
    : [
        Math.max(0, samples[index - 1]!.elapsedMs - restoredAtMs),
        samples[index]!.elapsedMs - restoredAtMs,
      ];
}

export const sharedUplinkIntervals = 27;
export function screenSharedUplinkResults(
  samples: readonly RecoverySample[],
  cap: number | null,
  restoredAtMs: number,
) {
  if (samples.length !== sharedUplinkIntervals) return null;
  const baseline = samples.slice(0, 3).flatMap((sample) => sample.result.streams);
  if (
    samples.slice(0, 3).some((sample) => sample.result.streams.length !== 1) ||
    !baseline.every((row) => row.direct1080p && row.bitrate > 0)
  )
    return null;
  const baselineBitrate = median(baseline.map((row) => row.bitrate));
  const totals = (rows: readonly RecoverySample[]) =>
    rows.map((sample) => {
      const links = sample.result.streams;
      return links.length === 2 && links.every((row) => row.direct1080p && row.bitrate > 0)
        ? links[0]!.bitrate + links[1]!.bitrate
        : null;
    });
  const joined = totals(samples.slice(4, 9)),
    restored = totals(samples.slice(-3));
  if (joined.some((n) => n === null) || restored.some((n) => n === null)) return null;
  const twoViewerMedian = median(joined.map(Number)),
    restoredMedian = median(restored.map(Number));
  const recoveredIndex = samples.findIndex(
    (sample, i) =>
      i >= 9 &&
      sample.result.streams.length === 2 &&
      sample.result.streams.every((row) => row.direct1080p && row.bitrate >= 0.9 * baselineBitrate),
  );
  return {
    baselineBitrate,
    twoViewerMedian,
    restoredMedian,
    aggregateLimitObserved:
      cap === null ? null : twoViewerMedian <= cap * 1.02 && restoredMedian > cap * 1.02,
    recoveryWindowMs: recoveryWindow(samples, recoveredIndex, restoredAtMs),
  };
}
export function screenRecoveryResults(
  samples: readonly RecoverySample[],
  viewers: readonly number[],
  impairedViewer: number,
  restoredAtMs: number,
) {
  // Three baseline windows, two throttled windows, then eight recovery windows.
  if (samples.length !== 13) return null;
  const links = viewers.map((viewer) => {
    const rows = samples.map((sample) =>
      sample.result.streams.find((row) => row.viewer === viewer),
    );
    const baseline = rows.slice(0, 3);
    const valid = baseline.every(
      (row) => row && row.bitrate > 0 && row.renderedFps > 0 && row.direct1080p,
    );
    const baselineBitrate = valid ? median(baseline.map((row) => row!.bitrate)) : null;
    const baselineFps = valid ? median(baseline.map((row) => row!.renderedFps)) : null;
    return { viewer, rows, baselineBitrate, baselineFps };
  });
  const healthy = links
    .filter((link) => link.viewer !== impairedViewer)
    .map((link) => ({
      viewer: link.viewer,
      baselineBitrate: link.baselineBitrate,
      baselineFps: link.baselineFps,
      passed:
        link.baselineBitrate === null || link.baselineFps === null
          ? null
          : link.rows
              .slice(3)
              .every(
                (row) =>
                  row &&
                  row.direct1080p &&
                  row.freezeDelta === 0 &&
                  row.bitrate >= 0.9 * link.baselineBitrate! &&
                  row.renderedFps >= 0.9 * link.baselineFps!,
              ),
    }));
  const target = links.find((link) => link.viewer === impairedViewer);
  const baselineBitrate = target?.baselineBitrate ?? null;
  const recoveredIndex =
    baselineBitrate === null
      ? -1
      : target!.rows.findIndex(
          (row, i) => i >= 5 && row?.direct1080p && row.bitrate >= baselineBitrate * 0.9,
        );
  return {
    healthy,
    baselineBitrate,
    recovered: baselineBitrate === null ? null : recoveredIndex >= 0,
    recoveryWindowMs: recoveryWindow(samples, recoveredIndex, restoredAtMs),
  };
}
