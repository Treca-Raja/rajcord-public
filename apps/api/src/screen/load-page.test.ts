import { afterEach, expect, it, vi } from 'vitest';
import { installScreenLoadSource } from './load-page';
import type { ScreenLoadMicrophone } from './load-metrics';

afterEach(() => vi.unstubAllGlobals());

it('attributes inbound voice tracks and waits for every screen peer to close on Stop', async () => {
  const microphone = { id: 'remote-mic' };
  const source = { readyState: 'live' };
  const media = {
    getUserMedia: async () => ({ getVideoTracks: () => [source] }),
    getDisplayMedia: async () => ({}),
  };
  class Peer {
    connectionState = 'connected';
    stats = new Map();
    async getStats() {
      return this.stats;
    }
  }
  const page = { RTCPeerConnection: Peer };
  vi.stubGlobal('window', page);
  vi.stubGlobal('navigator', { mediaDevices: media });
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
    },
  );
  vi.stubGlobal('document', {
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector === 'audio[data-voice-audio]'
        ? [
            {
              dataset: { voiceAudio: 'account-1' },
              srcObject: { getAudioTracks: () => [microphone] },
            },
          ]
        : [],
  });
  installScreenLoadSource(0, true);
  const fixture = Reflect.get(page, 'screenLoad') as {
    markVoicePeers(): void;
    collect(
      owners: Record<string, number>,
      accounts: string[],
    ): Promise<{ voice: ScreenLoadMicrophone[] }>;
    stopped(): boolean;
  };
  const voice = new page.RTCPeerConnection();
  voice.stats.set('inbound-audio', {
    type: 'inbound-rtp',
    kind: 'audio',
    trackIdentifier: microphone.id,
    bytesReceived: 123,
  });
  expect(fixture.stopped()).toBe(false);
  fixture.markVoicePeers();
  const client = await fixture.collect({}, ['account-0', 'account-1']);
  expect(client.voice).toMatchObject([
    { publisher: 1, trackId: microphone.id, bytesReceived: 123 },
  ]);
  expect(fixture.stopped()).toBe(true);

  const screen = new page.RTCPeerConnection();
  // A viewer has no local capture to stop.
  expect(fixture.stopped()).toBe(false);
  screen.connectionState = 'closed';
  expect(fixture.stopped()).toBe(true);
  const second = new page.RTCPeerConnection();
  await media.getDisplayMedia();
  second.connectionState = 'closed';
  expect(fixture.stopped()).toBe(false);
  source.readyState = 'ended';
  second.connectionState = 'disconnected';
  expect(fixture.stopped()).toBe(false);
  second.connectionState = 'closed';
  expect(fixture.stopped()).toBe(true);
  expect(voice.connectionState).toBe('connected');
});
