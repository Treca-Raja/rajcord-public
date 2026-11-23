import type { DesktopScreenBridge, NativeScreenCommand } from '@tricord/shared';
import { expect, it, vi } from 'vitest';
import { screenSdp } from '../../../../api/src/screen/signaling-fixture';
import { ObsPeer } from './obs-peer';

it('applies quality changed during negotiation using the native canvas instead of the preview', async () => {
  const closeEvents = vi.fn();
  const invoke = vi.fn(async (request: NativeScreenCommand) =>
    request.op === 'open' ? screenSdp('offer', false) : '',
  );
  const bridge = { nativeCommand: invoke, onNativeEvent: () => closeEvents } as Pick<
    DesktopScreenBridge,
    'nativeCommand' | 'onNativeEvent'
  >;
  const peer = new ObsPeer(bridge, {}, 'tag', 'link', () => 45000);
  const track = {
    kind: 'video',
    getSettings: () => ({ width: 854, height: 478, frameRate: 15 }),
  } as MediaStreamTrack;
  const { sender } = peer.addTransceiver(track, { direction: 'sendonly' });
  const params = sender.getParameters();
  params.encodings = [{ maxFramerate: 60, maxBitrate: 12000000 }];
  await sender.setParameters(params);
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  params.encodings = [{ maxFramerate: 15, maxBitrate: 1500000, scaleResolutionDownBy: 2 }];
  await sender.setParameters(params);
  expect(invoke.mock.calls.map(([req]) => req.op)).toEqual(['open', 'local']);
  await peer.setRemoteDescription({ type: 'answer', sdp: screenSdp('answer', false) });
  expect(invoke).toHaveBeenLastCalledWith({
    op: 'quality',
    tag: 'tag',
    linkId: 'link',
    video: { width: 960, height: 540, fps: 15, bitrate: 1500000 },
  });
  await peer.renew(44000);
  peer.close();
  peer.close();
  expect(closeEvents).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.map(([req]) => req.op)).toEqual([
    'open',
    'local',
    'answer',
    'quality',
    'lease',
    'close',
  ]);
});
