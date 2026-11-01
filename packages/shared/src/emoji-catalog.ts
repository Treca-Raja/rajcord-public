import compact from 'emojibase-data/en/compact.json' with { type: 'json' };

export interface EmojiEntry {
  emoji: string;
  name: string;
  group: number;
  keywords: string;
  base?: string;
  tones?: number[];
}
interface SourceEmoji {
  unicode: string;
  label: string;
  group?: number;
  tags?: string[];
  skins?: SourceEmoji[];
}
export const emojiGroups = [
  'Smileys & emotion',
  'People & body',
  'Animals & nature',
  'Food & drink',
  'Travel & places',
  'Activities',
  'Objects',
  'Symbols',
  'Flags',
  'Components',
] as const;
const source: SourceEmoji[] = compact;
function normalize(emoji: string) {
  return emoji.replace(/(\p{Emoji_Presentation})\uFE0F/gu, '$1');
}
function item(entry: SourceEmoji, base: string): EmojiEntry {
  return {
    emoji: normalize(entry.unicode),
    name: entry.label.charAt(0).toUpperCase() + entry.label.slice(1),
    group: entry.group!,
    keywords: [entry.label, ...(entry.tags ?? [])].join(' ').toLowerCase(),
    base,
    tones: [...entry.unicode]
      .map((character) => character.codePointAt(0)!)
      .filter((point) => point >= 0x1f3fb && point <= 0x1f3ff)
      .map((point) => point - 0x1f3fa),
  };
}
export const emojiCatalog: EmojiEntry[] = source
  .filter((entry) => entry.group !== undefined)
  .flatMap((entry) => [
    item(entry, normalize(entry.unicode)),
    ...(entry.skins ?? []).map((skin) => item(skin, normalize(entry.unicode))),
  ]);
