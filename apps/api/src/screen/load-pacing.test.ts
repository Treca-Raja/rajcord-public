import { expect, it, vi } from 'vitest';
import type { Browser } from '../voice/browser-harness.js';
import { tracePublisherPacing } from './load-pacing.js';

it('matches each viewer to its own first packets and excludes callback gaps and retransmissions', async () => {
  const ws = new EventTarget();
  const emit = (method: string, params: object) =>
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method, params }) }));
  const publisher = {
    ws,
    call: async (method: string) => {
      if (method !== 'Tracing.end') return {};
      const value = [1000, 2500, 5500, 7000, 1234567].flatMap((stamp, i) => {
        const ts = 1e6 + i * 17000;
        return [
          { name: 'VCMEncodedFrameCallback::Encoded', ph: 'I', ts, args: { timestamp: stamp } },
          {
            name: 'TaskQueuePacedSender::EnqueuePackets::Loop',
            ph: 'X',
            ts,
            args: { rtp_timestamp: stamp },
          },
          {
            name: 'PacketRouter::SendPacket',
            ph: 'X',
            ts: ts + 4000,
            args: { rtp_timestamp: stamp },
          },
          {
            name: 'PacketRouter::SendPacket',
            ph: 'X',
            ts: ts + 600,
            args: { rtp_timestamp: stamp },
          },
        ];
      });
      emit('Tracing.dataCollected', { value });
      emit('Tracing.tracingComplete', { dataLossOccurred: false });
      return {};
    },
  };
  const viewer = {
    js: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([1000, 2500, 7000, 1234567]),
  };
  const report = await tracePublisherPacing(
    publisher as unknown as Browser,
    [viewer as unknown as Browser],
    0,
  );
  expect(report.links[0]).toMatchObject({
    matched: 4,
    pacerInputGap: { count: 2, p95Ms: 17 },
    firstPacketSendGap: { count: 2, p95Ms: 17 },
    firstPacketPacerWait: { count: 4, p95Ms: 0.6 },
  });
  expect(report.captureGap).toBeNull();
  expect(report.dataLost).toBe(false);
});
