import { SCREEN_PROFILES, SCREEN_VIDEO_BITRATES, type ScreenQuality } from '@tricord/shared';

export class ScreenVideoQualityError extends Error {
  constructor(
    readonly code: 'invalid' | 'unqualified' | 'unsupported' | 'stale' | 'busy' | 'failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export type ScreenVideoRequest = Readonly<{
  revision: number;
  publisher: Readonly<ScreenQuality>;
  viewer: Readonly<ScreenQuality>;
}>;
export type ScreenVideoSource = Readonly<{ width: number; height: number; frameRate: number }>;
export type ScreenVideoEncoding = Readonly<{
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
}>;
export type ScreenVideoPlan = Readonly<{
  qualification: 'experimental-ceilings';
  request: ScreenVideoRequest;
  source: ScreenVideoSource;
  ceiling: Readonly<{ width: number; height: number; frameRate: number }>;
  encoding: ScreenVideoEncoding;
}>;
export type ScreenVideoApplied = Readonly<{ plan: ScreenVideoPlan; encoding: ScreenVideoEncoding }>;
export type ScreenVideoSender = Pick<RTCRtpSender, 'track' | 'getParameters' | 'setParameters'>;

const profiles = {
  low: { width: 854, height: 480, frameRate: 15 },
  high: { width: 1920, height: 1080, frameRate: 30 },
  smooth: { width: 1920, height: 1080, frameRate: 60 },
} as const;
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new ScreenVideoQualityError('invalid', 'Invalid video limit request.');
  return value as Record<string, unknown>;
}
function quality(value: unknown): Readonly<ScreenQuality> {
  const data = object(value, ['profile', 'videoBitrate']);
  if (!(SCREEN_PROFILES as readonly unknown[]).includes(data.profile))
    throw new ScreenVideoQualityError('invalid', 'Invalid video profile.');
  if (data.profile === 'auto' || data.profile === 'ultra' || data.videoBitrate === null)
    throw new ScreenVideoQualityError(
      'unqualified',
      'Choose an explicit supported profile and manual video bitrate. Auto and Ultra are unqualified.',
    );
  if (!(SCREEN_VIDEO_BITRATES as readonly unknown[]).includes(data.videoBitrate))
    throw new ScreenVideoQualityError('invalid', 'Invalid manual video bitrate.');
  return Object.freeze({
    profile: data.profile as ScreenQuality['profile'],
    videoBitrate: data.videoBitrate as ScreenQuality['videoBitrate'],
  });
}
export function screenVideoRequest(value: unknown): ScreenVideoRequest {
  const data = object(value, ['revision', 'publisher', 'viewer']);
  if (!Number.isSafeInteger(data.revision) || (data.revision as number) < 1)
    throw new ScreenVideoQualityError('invalid', 'Invalid video limit revision.');
  return Object.freeze({
    revision: data.revision as number,
    publisher: quality(data.publisher),
    viewer: quality(data.viewer),
  });
}
export function screenVideoSource(settings: MediaTrackSettings): ScreenVideoSource {
  const { width, height, frameRate } = settings;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !width ||
    width < 1 ||
    !height ||
    height < 1 ||
    typeof frameRate !== 'number' ||
    !Number.isFinite(frameRate) ||
    frameRate <= 0
  )
    throw new ScreenVideoQualityError(
      'unqualified',
      'Source dimensions and frame-rate settings are unavailable.',
    );
  return Object.freeze({ width, height, frameRate });
}
export function screenVideoPlan(value: unknown, settings: MediaTrackSettings): ScreenVideoPlan {
  const request = screenVideoRequest(value),
    source = screenVideoSource(settings);
  const publisher = profiles[request.publisher.profile as keyof typeof profiles],
    viewer = profiles[request.viewer.profile as keyof typeof profiles];
  const ceiling = Object.freeze({
    width: Math.min(publisher.width, viewer.width),
    height: Math.min(publisher.height, viewer.height),
    frameRate: Math.min(publisher.frameRate, viewer.frameRate),
  });
  return Object.freeze({
    qualification: 'experimental-ceilings',
    request,
    source,
    ceiling,
    encoding: Object.freeze({
      maxBitrate: Math.min(request.publisher.videoBitrate!, request.viewer.videoBitrate!),
      maxFramerate: Math.min(source.frameRate, ceiling.frameRate),
      scaleResolutionDownBy: Math.max(
        1,
        source.width / ceiling.width,
        source.height / ceiling.height,
      ),
    }),
  });
}
export function sameScreenVideoSource(left: ScreenVideoSource, right: ScreenVideoSource) {
  return (
    left.width === right.width && left.height === right.height && left.frameRate === right.frameRate
  );
}
// This helper performs one transaction. The owning peer serializes it with all RTC work.
export async function applyScreenVideoPlan(
  sender: ScreenVideoSender,
  plan: ScreenVideoPlan,
  boundary: <T>(raw: Promise<T>) => Promise<T>,
  check: () => void,
): Promise<ScreenVideoApplied> {
  check();
  if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function')
    throw new ScreenVideoQualityError(
      'unsupported',
      'Video sender parameter updates are unavailable.',
    );
  const parameters = sender.getParameters();
  if (parameters.encodings?.length !== 1)
    throw new ScreenVideoQualityError('unsupported', 'Exactly one video encoding is required.');
  parameters.encodings[0] = { ...parameters.encodings[0], ...plan.encoding };
  check();
  try {
    await boundary(sender.setParameters(parameters));
  } catch (cause) {
    throw new ScreenVideoQualityError('failed', 'Video parameter update failed.', { cause });
  }
  check();
  const observed = sender.getParameters();
  if (observed.encodings?.length !== 1)
    throw new ScreenVideoQualityError('unsupported', 'Video encoding readback is unavailable.');
  const { maxBitrate, maxFramerate, scaleResolutionDownBy } = observed.encodings[0]!;
  if (
    typeof maxBitrate !== 'number' ||
    !Number.isFinite(maxBitrate) ||
    maxBitrate <= 0 ||
    maxBitrate > plan.encoding.maxBitrate ||
    typeof maxFramerate !== 'number' ||
    !Number.isFinite(maxFramerate) ||
    maxFramerate <= 0 ||
    maxFramerate > plan.encoding.maxFramerate ||
    typeof scaleResolutionDownBy !== 'number' ||
    !Number.isFinite(scaleResolutionDownBy) ||
    scaleResolutionDownBy < 1 ||
    scaleResolutionDownBy + 1e-9 < plan.encoding.scaleResolutionDownBy
  )
    throw new ScreenVideoQualityError('unsupported', 'Native video ceilings were not confirmed.');
  check();
  return Object.freeze({
    plan,
    encoding: Object.freeze({ maxBitrate, maxFramerate, scaleResolutionDownBy }),
  });
}
