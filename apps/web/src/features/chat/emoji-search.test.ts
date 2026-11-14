import { expect, it } from 'vitest';
import { emojiCatalog } from '@tricord/shared/emoji-catalog';
import { searchEmoji, categorizedEmoji, emojiWindow } from './emoji-search';

it('searches names and keywords across the full catalog, including flags and skin tone variants', () => {
  expect(searchEmoji(emojiCatalog, 'croatia', 'all').some((entry) => entry.emoji === '🇭🇷')).toBe(
    true,
  );
  expect(
    searchEmoji(emojiCatalog, 'woman technologist medium skin tone', 'all').some(
      (entry) => entry.emoji === '👩🏽‍💻',
    ),
  ).toBe(true);
  expect(
    searchEmoji(emojiCatalog, '  THUMBS UP  ', 'all').some((entry) => entry.emoji === '👍'),
  ).toBe(true);
  expect(searchEmoji(emojiCatalog, 'no_such_emoji_123', 'all')).toEqual([]);
  expect(searchEmoji(emojiCatalog, '', '8').every((entry) => entry.group === 8)).toBe(true);
});
it('browses base families by category and tone without variant spam or unbounded DOM rows', () => {
  const people = categorizedEmoji(emojiCatalog, '', '1', 0);
  expect(people.some((entry) => entry.emoji === '👍')).toBe(true);
  expect(people.some((entry) => entry.emoji === '👍🏽')).toBe(false);
  expect(categorizedEmoji(emojiCatalog, '', '1', 3).some((entry) => entry.emoji === '👍🏽')).toBe(
    true,
  );
  expect(
    categorizedEmoji(emojiCatalog, 'woman technologist medium skin tone', 'all', 0).some(
      (entry) => entry.emoji === '👩🏽‍💻',
    ),
  ).toBe(true);
  for (const offset of [0, 100, 1000, 5000]) {
    const window = emojiWindow(3953, offset);
    expect(window.end - window.start).toBeLessThanOrEqual(80);
    expect(window.start % 8).toBe(0);
    expect(window.height).toBeGreaterThan(10000);
  }
});
