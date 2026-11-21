import type { ScreenQuality } from '@tricord/shared';
import { screenVideoPlan } from './screen-quality';

export type ScreenCodecSelection = Readonly<{
  preferred: string | null;
  status:
    'reported-efficient' | 'browser-default' | 'unavailable' | 'error' | 'timeout' | 'cancelled';
}>;

export function screenCodecContentType(codec: RTCRtpCodec) {
  return codec.mimeType + (codec.sdpFmtpLine ? ';' + codec.sdpFmtpLine : '');
}

function h264Level(codec: RTCRtpCodec) {
  const match = /(?:^|;)\s*profile-level-id=[0-9a-f]{4}([0-9a-f]{2})(?:;|$)/i.exec(
    codec.sdpFmtpLine ?? '',
  );
  return match ? parseInt(match[1]!, 16) : 0;
}

// Capability reports are estimates, not physical hardware qualification. Never
// force a software codec or remove a receiver's interoperable fallback codecs.
export async function screenCodecSelection(
  quality: ScreenQuality,
  settings: MediaTrackSettings,
  signal: AbortSignal,
): Promise<ScreenCodecSelection> {
  const selection = (
    status: ScreenCodecSelection['status'],
    preferred: ScreenCodecSelection['preferred'] = null,
  ) => Object.freeze({ preferred, status });
  if (signal.aborted) return selection('cancelled');
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaCapabilities?.encodingInfo ||
    typeof RTCRtpSender === 'undefined' ||
    typeof RTCRtpSender.getCapabilities !== 'function'
  )
    return selection('unavailable');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  try {
    const candidates = (RTCRtpSender.getCapabilities('video')?.codecs ?? [])
      .filter((codec) => codec.mimeType.toLowerCase() === 'video/h264')
      .sort((a, b) => h264Level(b) - h264Level(a));
    if (!candidates.length) return selection('unavailable');
    const { source, encoding } = screenVideoPlan(
      { revision: 1, publisher: quality, viewer: quality },
      settings,
    );
    const width = Math.round(source.width / encoding.scaleResolutionDownBy);
    const height = Math.round(source.height / encoding.scaleResolutionDownBy);
    const result = await Promise.race([
      Promise.allSettled(
        candidates.map(async (codec) => {
          const contentType = screenCodecContentType(codec);
          const info = await navigator.mediaCapabilities.encodingInfo({
            type: 'webrtc',
            video: {
              contentType,
              width,
              height,
              bitrate: encoding.maxBitrate,
              framerate: encoding.maxFramerate,
            },
          });
          return info.supported && info.smooth && info.powerEfficient ? contentType : null;
        }),
      ).then((results) => {
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value)
            return selection('reported-efficient', result.value);
        }
        return selection(
          results.every((result) => result.status === 'rejected') ? 'error' : 'browser-default',
        );
      }),
      new Promise<ScreenCodecSelection>((resolve) => {
        timer = setTimeout(() => resolve(selection('timeout')), 300);
      }),
      new Promise<ScreenCodecSelection>((resolve) => {
        cancel = () => resolve(selection('cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
      }),
    ]);
    return signal.aborted ? selection('cancelled') : result;
  } catch {
    return selection('error');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
