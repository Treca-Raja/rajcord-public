import type { ScreenShare, ScreenSound } from '@tricord/shared';
import { screenVideoRequest } from './screen-quality';

export const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const record = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid screen response.');
  return value as Record<string, unknown>;
};
export function share(value: unknown): ScreenShare {
  const data = record(value);
  if (
    Object.keys(data).some(
      (key) =>
        ![
          'id',
          'publisherId',
          'sourceGeneration',
          'profile',
          'videoBitrate',
          'resolution',
          'frameRate',
          'sound',
        ].includes(key),
    ) ||
    !uuid(data.id) ||
    !uuid(data.publisherId) ||
    !Number.isSafeInteger(data.sourceGeneration) ||
    (data.sourceGeneration as number) < 1 ||
    !['none', 'tab', 'system', 'application', 'source'].includes(data.sound as string)
  )
    throw new Error('Invalid screen share.');
  const quality = screenVideoRequest({
    revision: 1,
    publisher: {
      profile: data.profile,
      videoBitrate: data.videoBitrate,
      ...(data.resolution !== undefined || data.frameRate !== undefined
        ? { resolution: data.resolution, frameRate: data.frameRate }
        : {}),
    },
    viewer: { profile: 'smooth', videoBitrate: 8000000 },
  }).publisher;
  return Object.freeze({
    ...quality,
    id: data.id,
    publisherId: data.publisherId,
    sourceGeneration: data.sourceGeneration as number,
    sound: data.sound as ScreenSound,
  });
}
