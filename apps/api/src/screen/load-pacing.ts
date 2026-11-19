import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from '../voice/browser-harness.js';

type EventRow = {
  name: string;
  ph: string;
  ts: number;
  args?: { rtp_timestamp?: number; timestamp?: number };
};
const gaps = (times: number[]) =>
  times.slice(1).map((time, index) => (time - times[index]!) / 1000);
function distribution(ms: number[]) {
  if (!ms.length) return null;
  ms.sort((a, b) => a - b);
  return {
    count: ms.length,
    p50Ms: ms[Math.floor(ms.length * 0.5)],
    p95Ms: ms[Math.floor(ms.length * 0.95)],
    maxMs: ms.at(-1),
  };
}

// Only retain event times and temporary RTP timestamps from the owned publisher.
// Join to presented frames so voice packets, padding and other viewers cannot enter a link's sample.
export async function tracePublisherPacing(
  publisher: Browser,
  viewers: readonly Browser[],
  durationMs = 10000,
) {
  const capture: number[] = [],
    encoded = new Map<number, number>();
  const enqueue = new Map<number, number>(),
    send = new Map<number, number>();
  let encodes = 0;
  function first(map: Map<number, number>, stamp: number | undefined, time: number) {
    if (typeof stamp !== 'number' || !Number.isInteger(stamp)) return;
    const key = stamp >>> 0;
    map.set(key, Math.min(map.get(key) ?? Infinity, time));
  }
  let complete!: (lost: boolean) => void;
  const completed = new Promise<boolean>((resolve) => {
    complete = resolve;
  });
  const onTrace = (message: MessageEvent) => {
    const event = JSON.parse(String(message.data));
    if (event.method === 'Tracing.tracingComplete')
      complete(event.params.dataLossOccurred === true);
    if (event.method !== 'Tracing.dataCollected') return;
    for (const row of event.params.value as EventRow[]) {
      if (row.name === 'VideoCaptureController::OnFrameReadyInBuffer' && row.ph === 'X')
        capture.push(row.ts);
      if (row.name === 'VCMEncodedFrameCallback::Encoded' && row.ph === 'I') {
        encodes++;
        first(encoded, row.args?.timestamp, row.ts);
      }
      if (
        row.name === 'TaskQueuePacedSender::EnqueuePackets::Loop' &&
        (row.ph === 'X' || row.ph === 'I')
      )
        first(enqueue, row.args?.rtp_timestamp, row.ts);
      if (row.name === 'PacketRouter::SendPacket' && row.ph === 'X')
        first(send, row.args?.rtp_timestamp, row.ts);
    }
  };
  publisher.ws.addEventListener('message', onTrace);
  try {
    await Promise.all(viewers.map((viewer) => viewer.js('window.screenLoad.traceFrames(true)')));
    await publisher.call('Tracing.start', {
      categories:
        '-*,webrtc,media,video,video_and_image_capture,disabled-by-default-webrtc,disabled-by-default-video_and_image_capture',
      transferMode: 'ReportEvents',
    });
    await delay(durationMs);
    await publisher.call('Tracing.end');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const dataLost = await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Publisher timing trace did not finish.')),
          15000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    const stampsByViewer = await Promise.all(
      viewers.map(
        async (viewer) => (await viewer.js('window.screenLoad.traceFrames(false)')) as number[],
      ),
    );
    const owners = new Map<number, number>();
    for (const [viewer, stamps] of stampsByViewer.entries())
      for (const stamp of stamps) {
        if (owners.has(stamp) && owners.get(stamp) !== viewer)
          throw new Error('Ambiguous publisher trace: viewers share an RTP timestamp.');
        owners.set(stamp, viewer);
      }
    const ordered = [...enqueue.keys()].sort((a, b) => a - b);
    const successor = new Map(
      ordered.map((stamp, i) => [stamp, ordered[(i + 1) % ordered.length]!]),
    );
    const links = stampsByViewer.map((stamps) => {
      const pacerGaps: number[] = [],
        sendGaps: number[] = [],
        waiting: number[] = [];
      let matched = 0;
      let previous: { stamp: number; queued: number; sent: number } | undefined;
      for (const stamp of stamps) {
        const queued = enqueue.get(stamp),
          sent = send.get(stamp);
        if (queued === undefined || sent === undefined || sent < queued) continue;
        matched++;
        waiting.push((sent - queued) / 1000);
        // Exclude a gap if any other RTP timestamp was enqueued between its endpoints.
        // This retains long capture gaps without counting missed viewer callbacks as sender stalls.
        if (
          previous &&
          successor.get(previous.stamp) === stamp &&
          queued >= previous.queued &&
          sent >= previous.sent
        ) {
          pacerGaps.push((queued - previous.queued) / 1000);
          sendGaps.push((sent - previous.sent) / 1000);
        }
        previous = { stamp, queued, sent };
      }
      return {
        matched,
        pacerInputGap: distribution(pacerGaps),
        firstPacketSendGap: distribution(sendGaps),
        firstPacketPacerWait: distribution(waiting),
      };
    });
    return {
      dataLost,
      captureGap: distribution(gaps(capture.sort((a, b) => a - b))),
      encodes,
      distinctEncoderTimestamps: encoded.size,
      firstEncodeCompletionGap: distribution(gaps([...encoded.values()].sort((a, b) => a - b))),
      links,
    };
  } finally {
    publisher.ws.removeEventListener('message', onTrace);
  }
}
