import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { delta, type Counters } from './feasibility-metrics.js';
import type { screenImageQuality } from './feasibility-quality.js';

export type Page = { js(expression: string): Promise<unknown> };
type Rtp = Record<string, number | string | boolean>;
type Snapshot = {
  audioRms: number | null;
  time: number;
  rtp: Rtp[];
  rendered: number;
  draws: number;
  connection: string;
  route: { state: string; localType: string; remoteType: string } | null;
};
const invoke = (page: Page, method: string, ...args: unknown[]) =>
  page.js(
    'window.screenFixture.' +
      method +
      '(' +
      args.map((value) => JSON.stringify(value)).join(',') +
      ')',
  );
const snapshot = async (page: Page) => (await invoke(page, 'snapshot')) as Snapshot;

function counter(value: Snapshot, type: string, kind: string): Counters {
  const item = value.rtp.find((s) => s.type === type && s.kind === kind);
  if (!item) throw new Error('Required RTP stats absent: ' + type + '/' + kind);
  const number = (key: string) =>
    typeof item[key] === 'number' ? (item[key] as number) : undefined;
  return {
    time: value.time,
    bytes: number(type === 'outbound-rtp' ? 'bytesSent' : 'bytesReceived') ?? 0,
    frames: number(type === 'outbound-rtp' ? 'framesEncoded' : 'framesDecoded'),
    width: number('frameWidth'),
    height: number('frameHeight'),
    workSeconds: number(type === 'outbound-rtp' ? 'totalEncodeTime' : 'totalDecodeTime'),
  };
}

export async function runScenario(
  publisher: Page,
  receiver: Page,
  settings: {
    mode: 'canvas' | 'display';
    codec: string;
    content: string;
    hint?: string;
    phaseMs: number;
    bitrates?: number[];
    source?: Page;
  },
) {
  const started = performance.now();
  const bitrates = settings.bitrates ?? [2000000, 8000000];
  const phases = [];
  let last: unknown;
  let cleanup: unknown;
  try {
    if (settings.source) await invoke(settings.source, 'startSource', settings.content);
    const tracks = await invoke(publisher, 'capture', settings.mode, settings.content);
    assert.deepEqual(
      (tracks as string[]).slice().sort(),
      ['audio', 'video'],
      'Picture AND source audio tracks required',
    );
    if (settings.source) await invoke(settings.source, 'startTonePlayback');
    await invoke(
      publisher,
      'create',
      true,
      settings.codec,
      settings.hint ?? 'auto',
      null,
      bitrates[0],
    );
    await invoke(receiver, 'create', false, settings.codec, settings.hint ?? 'auto');
    const offer = (await invoke(publisher, 'offer')) as { sdp: string };
    const answer = (await invoke(receiver, 'answer', offer)) as { sdp: string };
    await invoke(publisher, 'accept', answer);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      for (const [from, to] of [
        [publisher, receiver],
        [receiver, publisher],
      ] as const) {
        const ice = (await invoke(from, 'ice')) as { candidates: unknown[] };
        await invoke(to, 'addIce', ice.candidates);
      }
      const value = await snapshot(receiver);
      if (
        value.connection === 'connected' &&
        value.rtp.some((s) => s.kind === 'audio' && Number(s.bytesReceived) > 0) &&
        value.rtp.some((s) => s.kind === 'video' && Number(s.framesDecoded) > 0)
      ) {
        ready = true;
        break;
      }
      await delay(100);
    }
    assert.ok(ready, 'Direct video/audio did not arrive within the bounded setup interval');
    await invoke(receiver, 'play');
    if (settings.content === 'static') await invoke(settings.source ?? publisher, 'freezeSource');
    const decodedVideoAndAudioStartupMs = performance.now() - started;
    for (const bits of bitrates) {
      assert.equal(
        await invoke(publisher, 'cap', bits, settings.hint ?? 'auto', settings.content),
        bits,
      );
      await delay(2000);
      const before = {
        sent: await snapshot(publisher),
        received: await snapshot(receiver),
        source: settings.source
          ? ((await invoke(settings.source, 'sourceStats')) as { time: number; draws: number })
          : null,
      };
      await delay(settings.phaseMs);
      const after = {
        sent: await snapshot(publisher),
        received: await snapshot(receiver),
        source: settings.source
          ? ((await invoke(settings.source, 'sourceStats')) as { time: number; draws: number })
          : null,
      };
      last = { before, after };
      const qualitySamples = [];
      const frameIds = new Set<number>();
      const sampleCount = settings.content === 'static' ? 1 : 5;
      for (
        let attempt = 0;
        attempt < sampleCount * 2 && qualitySamples.length < sampleCount;
        attempt++
      ) {
        if (attempt) await delay(150);
        const sample = (await invoke(receiver, 'quality', settings.content)) as {
          status: string;
          frame: number;
          width: number;
          height: number;
        } & ReturnType<typeof screenImageQuality>;
        assert.equal(
          sample.status,
          'available',
          'Decoded image must align with its synthetic reference frame',
        );
        assert.ok(Number.isFinite(sample.blockSsim), 'Image fidelity measurement required');
        if (settings.hint === 'fixed')
          assert.ok(
            sample.width === 1920 && sample.height === 1080,
            'Fixed-format fidelity comparison requires a native 1080p picture',
          );
        if (!frameIds.has(sample.frame)) {
          frameIds.add(sample.frame);
          qualitySamples.push(sample);
        }
      }
      assert.equal(
        qualitySamples.length,
        sampleCount,
        'Distinct matched frames required for the image comparison',
      );
      const sentVideo = delta(
        counter(before.sent, 'outbound-rtp', 'video'),
        counter(after.sent, 'outbound-rtp', 'video'),
      );
      const receivedVideo = delta(
        counter(before.received, 'inbound-rtp', 'video'),
        counter(after.received, 'inbound-rtp', 'video'),
      );
      const receivedAudio = delta(
        counter(before.received, 'inbound-rtp', 'audio'),
        counter(after.received, 'inbound-rtp', 'audio'),
      );
      const beforeAudio = before.received.rtp.find(
        (s) => s.type === 'inbound-rtp' && s.kind === 'audio',
      )!;
      const afterAudio = after.received.rtp.find(
        (s) => s.type === 'inbound-rtp' && s.kind === 'audio',
      )!;
      const energy =
        typeof afterAudio.totalAudioEnergy === 'number' &&
        typeof beforeAudio.totalAudioEnergy === 'number'
          ? afterAudio.totalAudioEnergy - beforeAudio.totalAudioEnergy
          : null;
      assert.ok(
        settings.content === 'static'
          ? Number(counter(after.received, 'inbound-rtp', 'video').frames) > 0
          : receivedVideo.bitsPerSecond > 0 && Number(receivedVideo.fps) > 0,
        'Decoded video required; only static sources may have no new frames',
      );
      assert.ok(receivedAudio.bitsPerSecond > 0, 'Received audio bytes required');
      assert.ok(
        (energy !== null && energy > 0) || Number(after.received.audioRms) > 0,
        'Non-silent decoded synthetic source audio required',
      );
      assert.ok(
        after.received.route &&
          ['host', 'srflx', 'prflx'].includes(after.received.route.localType) &&
          ['host', 'srflx', 'prflx'].includes(after.received.route.remoteType),
        'Selected route must be direct, with no relay',
      );
      phases.push({
        videoCapBitsPerSecond: bits,
        imageQuality: qualitySamples[0],
        qualitySamples,
        sentVideo,
        receivedVideo,
        receivedAudio,
        decodedAudioEnergyDelta: energy,
        decodedAudioRms: after.received.audioRms,
        renderedFps:
          ((after.received.rendered - before.received.rendered) * 1000) /
          (after.received.time - before.received.time),
        sourceDrawFps:
          before.source && after.source
            ? ((after.source.draws - before.source.draws) * 1000) /
              (after.source.time - before.source.time)
            : settings.mode === 'canvas'
              ? ((after.sent.draws - before.sent.draws) * 1000) /
                (after.sent.time - before.sent.time)
              : null,
        before,
        after,
      });
    }
    const byCap = [...phases].sort((a, b) => a.videoCapBitsPerSecond - b.videoCapBitsPerSecond);
    return {
      mode: settings.mode,
      requested: { width: 1920, height: 1080, fps: 60 },
      codec: settings.codec,
      content: settings.content,
      degradationPreference:
        settings.hint === 'fixed'
          ? 'maintain-framerate-and-resolution'
          : settings.hint === 'detail' ||
              ((settings.hint ?? 'auto') === 'auto' &&
                ['text', 'static'].includes(settings.content))
            ? 'maintain-resolution'
            : 'maintain-framerate',
      renderMetric:
        'Frames submitted for composition, from requestVideoFrameCallback metadata.presentedFrames.',
      decodedVideoAndAudioStartupMs,
      sdpBytes: { offer: Buffer.byteLength(offer.sdp), answer: Buffer.byteLength(answer.sdp) },
      phases,
      highToLowVideoByteRateRatio:
        byCap.length > 1 && byCap[0]!.receivedVideo.bitsPerSecond > 0
          ? byCap.at(-1)!.receivedVideo.bitsPerSecond / byCap[0]!.receivedVideo.bitsPerSecond
          : null,
      qualification:
        'measurement-only; zero-gain synthetic audio inspection, local processes, no approved FPS/audio/resource budgets',
    };
  } catch (error) {
    throw Object.assign(error as Error, { screenEvidence: { mode: settings.mode, phases, last } });
  } finally {
    const results = await Promise.allSettled([
      invoke(publisher, 'stop'),
      invoke(receiver, 'stop'),
      ...(settings.source ? [invoke(settings.source, 'stop')] : []),
    ]);
    cleanup = results.map((result) =>
      result.status === 'fulfilled' ? result.value : { error: 'Fixture cleanup failed' },
    );
    assert.ok(
      results.every(
        (result) =>
          result.status === 'fulfilled' &&
          Object.values(result.value as Record<string, boolean>).every(Boolean),
      ),
      'Fixture tracks, peers and elements must be disposed: ' + JSON.stringify(cleanup),
    );
  }
}
