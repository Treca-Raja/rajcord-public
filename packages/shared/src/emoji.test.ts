import { expect, it } from 'vitest';
import { chatEmoji, isChatEmoji } from './emoji.js';
import { emojiCatalog, emojiGroups } from './emoji-catalog.js';

it('covers the full named Unicode 17 catalog, including flags, tones, joined sequences and modern faces', () => {
  expect(emojiCatalog).toHaveLength(3953);
  expect(emojiGroups).toHaveLength(10);
  expect(new Set(emojiCatalog.map((entry) => entry.emoji)).size).toBe(emojiCatalog.length);
  for (const emoji of ['🇭🇷', '👍🏽', '👩🏽‍💻', '🫩', '🪼', '🫶🏿', '❤️‍🔥']) {
    expect(emojiCatalog.some((entry) => entry.emoji === emoji)).toBe(true);
    expect(isChatEmoji(emoji)).toBe(true);
  }
  for (const entry of emojiCatalog) {
    expect(entry.name).not.toBe('');
    expect(isChatEmoji(entry.emoji)).toBe(true);
    expect([...entry.emoji].length).toBeLessThanOrEqual(32);
  }
  for (const emoji of chatEmoji) expect(isChatEmoji(emoji)).toBe(true);
});
it('rejects arbitrary text, combined separate emoji and invalid/oversized reactions', () => {
  for (const value of [
    'hello',
    '😀😀',
    '<script>',
    ' https://example.com ',
    '',
    '👍'.repeat(100),
    null,
    1,
  ])
    expect(isChatEmoji(value)).toBe(false);
});
