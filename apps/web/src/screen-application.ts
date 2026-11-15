import { ScreenRuntime, type ScreenRuntimeAttachment } from './screen-runtime';
import { WebScreenCapture } from './screen-capture';
import { createScreenReceiveLane } from './screen-receiver';
import { publicScreenIceServers } from './screen-ice';
import { ScreenCall } from './screen-call';
import type { VoiceController } from './voice-controller';

export type ScreenApplication = ReturnType<typeof createScreenApplication>;
export function createScreenApplication() {
  const capture = new WebScreenCapture(navigator.mediaDevices, {
    desktop: !!window.tricordDesktop,
    tabAudio: 'consented-selected-tab',
  });
  const elements = new Set<(element: HTMLVideoElement) => void>();
  const incoming = createScreenReceiveLane({
    iceServers: publicScreenIceServers,
    createRtc: (config) => new RTCPeerConnection(config),
    createStream: (tracks) => new MediaStream([...tracks]),
    createElement: () => {
      const element = document.createElement('video');
      element.playsInline = true;
      element.muted = true;
      element.dataset.screenPlayback = 'true';
      element.setAttribute('aria-label', 'Shared screen');
      for (const listener of elements) listener(element);
      return element;
    },
    onError: (error) => console.error('Screen playback failed:', error.message),
  });
  const runtime = new ScreenRuntime({
    capture,
    incoming,
    sessionTransport: true,
    onError: (error) =>
      console.error(
        'Screen controls unavailable:',
        error instanceof Error ? error.message : 'Unknown failure',
      ),
  });
  return Object.freeze({
    runtime,
    createCall: (attachment: ScreenRuntimeAttachment, voice: VoiceController) =>
      new ScreenCall({
        attachment,
        voice,
        capture,
        element: (listener) => {
          elements.add(listener);
          return () => {
            elements.delete(listener);
          };
        },
      }),
  });
}
