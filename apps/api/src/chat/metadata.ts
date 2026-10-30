import { chatMetadataLimits, normalizedChatName } from '@tricord/shared';
import { HttpError } from '../auth/validation.js';

export function chatName(value: unknown, limit: number, label: string) {
  const result = normalizedChatName(value, limit);
  if (!result)
    throw new HttpError(
      400,
      `${label} must contain 1–${limit} Unicode characters without control characters.`,
    );
  return result;
}

export function channelTopic(value: unknown) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'Invalid channel topic.');
  const topic = value.normalize('NFC').trim();
  if (
    [...topic].length > chatMetadataLimits.topic ||
    /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(topic)
  )
    throw new HttpError(400, 'Topics support up to 500 characters without control characters.');
  return topic;
}

export function metadataPosition(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > chatMetadataLimits.position
  )
    throw new HttpError(400, 'Order must be a whole number between 0 and 2147483647.');
  return value;
}

export function checkMetadataRevision(value: unknown, current: unknown) {
  if (value === undefined)
    throw new HttpError(409, 'Refresh channel details before changing them.');
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value))
    throw new HttpError(400, 'Invalid metadata revision.');
  if (BigInt(value) !== BigInt(String(current)))
    throw new HttpError(409, 'These details changed. Reload them before saving again.');
}
