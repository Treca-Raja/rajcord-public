import { afterEach, expect, it, vi } from 'vitest';
import { screenCodecSelection } from './screen-codec';
const trackSettings = { width: 1280, height: 720, frameRate: 60 };
const quality = {
  profile: 'smooth' as const,
  videoBitrate: 8000000 as const,
  resolution: 720 as const,
  frameRate: 60 as const,
};
const fixture = (encodingInfo: ReturnType<typeof vi.fn>) => {
  vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo } });
  vi.stubGlobal('RTCRtpSender', {
    getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }),
  });
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('prefers H264 only for reported supported, smooth and power-efficient encoding of the requested stream', async () => {
  const query = vi.fn(async () => ({ supported: true, smooth: true, powerEfficient: true }));
  fixture(query);
  expect(await screenCodecSelection(quality, trackSettings, new AbortController().signal)).toEqual({
    preferred: 'video/H264',
    status: 'reported-efficient',
  });
  expect(query).toHaveBeenCalledWith({
    type: 'webrtc',
    video: { contentType: 'video/H264', width: 1280, height: 720, bitrate: 8000000, framerate: 60 },
  });
});
it('checks exact H264 configurations and prefers the higher supported hardware level', async () => {
  const formats = ['42001f', '640032', '4d001f'].map((id) => ({
    mimeType: 'video/H264',
    sdpFmtpLine: 'packetization-mode=1;profile-level-id=' + id,
  }));
  fixture(
    vi.fn(async ({ video }) => ({
      supported: true,
      smooth: true,
      powerEfficient: video.contentType.includes('packetization-mode=1'),
    })),
  );
  vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: formats }) });
  expect(
    (await screenCodecSelection(quality, trackSettings, new AbortController().signal)).preferred,
  ).toBe('video/H264;packetization-mode=1;profile-level-id=640032');
});
it.each([
  { sourceWidth: 2560, sourceHeight: 1080, expectedWidth: 2560 },
  { sourceWidth: 1440, sourceHeight: 2160, expectedWidth: 720 },
])(
  'qualifies the actual publisher geometry for a $sourceWidth by $sourceHeight source',
  async ({ sourceWidth, sourceHeight, expectedWidth }) => {
    const query = vi.fn(async ({ video }) => ({
      supported: true,
      smooth: true,
      powerEfficient: video.width <= 1920,
    }));
    fixture(query);
    const selected = await screenCodecSelection(
      { ...quality, resolution: 1080 },
      { width: sourceWidth, height: sourceHeight, frameRate: 60 },
      new AbortController().signal,
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({ width: expectedWidth, height: 1080, framerate: 60 }),
      }),
    );
    expect(selected.preferred).toBe(expectedWidth > 1920 ? null : 'video/H264');
  },
);
it.each(['supported', 'smooth', 'powerEfficient'])(
  'preserves browser defaults when %s is false',
  async (field) => {
    fixture(
      vi.fn(async () => ({ supported: true, smooth: true, powerEfficient: true, [field]: false })),
    );
    expect(
      await screenCodecSelection(quality, trackSettings, new AbortController().signal),
    ).toEqual({
      preferred: null,
      status: 'browser-default',
    });
  },
);
it('bounds delayed queries and never adopts a late efficiency report', async () => {
  vi.useFakeTimers();
  let resolve!: (value: unknown) => void;
  fixture(
    vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
  );
  const pending = screenCodecSelection(quality, trackSettings, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(300);
  expect(await pending).toEqual({ preferred: null, status: 'timeout' });
  resolve({ supported: true, smooth: true, powerEfficient: true });
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels pending qualification on source stop and handles unsupported/rejected queries explicitly', async () => {
  fixture(vi.fn(() => new Promise(() => {})));
  const abort = new AbortController();
  const pending = screenCodecSelection(quality, trackSettings, abort.signal);
  abort.abort();
  expect(await pending).toEqual({ preferred: null, status: 'cancelled' });
  fixture(
    vi.fn(async () => {
      throw new Error('Owned capability failure');
    }),
  );
  expect(
    (await screenCodecSelection(quality, trackSettings, new AbortController().signal)).status,
  ).toBe('error');
  vi.stubGlobal('RTCRtpSender', undefined);
  expect(
    (await screenCodecSelection(quality, trackSettings, new AbortController().signal)).status,
  ).toBe('unavailable');
});
