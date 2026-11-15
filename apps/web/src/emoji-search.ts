import type { EmojiEntry } from '@tricord/shared/emoji-catalog';

export const emojiColumns = 8;
export const emojiRowHeight = 42;
export function emojiWindow(length: number, scrollTop: number, viewportHeight = 252) {
  const startRow = Math.max(0, Math.floor(scrollTop / emojiRowHeight) - 1);
  const endRow = Math.min(
    Math.ceil(length / emojiColumns),
    Math.ceil((scrollTop + viewportHeight) / emojiRowHeight) + 1,
  );
  return {
    start: startRow * emojiColumns,
    end: endRow * emojiColumns,
    offset: startRow * emojiRowHeight,
    height: Math.ceil(length / emojiColumns) * emojiRowHeight,
  };
}
export function categorizedEmoji(
  catalog: EmojiEntry[],
  query: string,
  group: string,
  tone: number,
) {
  if (query.trim()) {
    const matches = searchEmoji(catalog, query, 'all');
    return /skin|tone|light|medium|dark/i.test(query)
      ? matches
      : matches.filter(
          (entry) => !entry.tones?.length || entry.tones.every((value) => value === tone),
        );
  }
  const families = new Map<string, EmojiEntry[]>();
  for (const entry of catalog) {
    if (entry.group >= 9 || (group !== 'all' && String(entry.group) !== group)) continue;
    const base = entry.base ?? entry.emoji;
    const family = families.get(base) ?? [];
    family.push(entry);
    families.set(base, family);
  }
  return [...families.values()].map(
    (family) =>
      (tone
        ? family.find(
            (entry) => entry.tones?.length && entry.tones.every((value) => value === tone),
          )
        : undefined) ??
      family.find((entry) => !entry.tones?.length) ??
      family[0]!,
  );
}
export function searchEmoji(catalog: EmojiEntry[], query: string, group: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return catalog.filter(
    (entry) =>
      (!words.length && group !== 'all' ? String(entry.group) === group : true) &&
      words.every((word) => entry.keywords.includes(word) || entry.emoji === word),
  );
}
