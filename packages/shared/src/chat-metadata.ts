export const chatMetadataLimits = {
  channelName: 80,
  categoryName: 48,
  topic: 500,
  position: 2147483647,
} as const;

export function normalizedChatName(
  value: unknown,
  limit: number,
): { name: string; key: string } | undefined {
  if (typeof value !== 'string') return;
  const name = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (
    !name ||
    [...name].length > limit ||
    /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name) ||
    !/[\p{L}\p{N}\p{P}\p{S}]/u.test(name)
  )
    return;
  return { name, key: name.toLowerCase().normalize('NFC') };
}
