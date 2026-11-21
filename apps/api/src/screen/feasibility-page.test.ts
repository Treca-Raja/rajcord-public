import { afterEach, expect, it, vi } from 'vitest';
import { installFixture } from './feasibility-page';
import { screenImageQuality } from './feasibility-quality';
afterEach(() => vi.unstubAllGlobals());

it('counts frames submitted for presentation even when the browser coalesces callbacks', async () => {
  let next!: VideoFrameRequestCallback;
  const surface = {
    getContext: () => ({}),
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
      next = callback;
      return 1;
    },
  };
  vi.stubGlobal('document', { querySelector: () => surface, createElement: () => surface });
  vi.stubGlobal('navigator', { mediaDevices: {} });
  vi.stubGlobal('window', {});
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      addEventListener = vi.fn();
      getStats = async () => new Map();
    },
  );
  installFixture(screenImageQuality);
  const fixture = Reflect.get(window, 'screenFixture') as {
    create(sender: boolean, codec: string): Promise<void>;
    snapshot(): Promise<{ rendered: number }>;
  };
  await fixture.create(false, 'H264');
  next(0, { presentedFrames: 2 } as VideoFrameCallbackMetadata);
  next(100, { presentedFrames: 8 } as VideoFrameCallbackMetadata);
  expect((await fixture.snapshot()).rendered).toBe(8);
});
it.each(['text', 'static'])(
  'applies the requested %s profile to owned display capture, not just canvas capture',
  async (kind) => {
    const video = { kind: 'video', contentHint: '', stop: vi.fn() },
      audio = { kind: 'audio', stop: vi.fn() };
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => [video, audio] }) },
    });
    vi.stubGlobal('document', {
      querySelector: () => ({ getContext: () => ({}), cancelVideoFrameCallback: vi.fn() }),
      createElement: () => ({ getContext: () => ({}) }),
    });
    vi.stubGlobal('window', {});
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        addEventListener = vi.fn();
        addTransceiver() {
          return { setCodecPreferences: vi.fn() };
        }
      },
    );
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }),
    });
    installFixture(screenImageQuality);
    const fixture = Reflect.get(window, 'screenFixture') as {
      capture(mode: string, kind: string): Promise<void>;
      create(sender: boolean, codec: string): Promise<void>;
    };
    await fixture.capture('display', kind);
    await fixture.create(true, 'VP8');
    expect(video.contentHint).toBe('detail');
  },
);
