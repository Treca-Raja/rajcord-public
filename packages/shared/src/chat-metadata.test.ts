import { expect, it } from 'vitest';
import { normalizedChatName } from './chat-metadata.js';

it('preserves readable Unicode and emoji while normalizing whitespace and uniqueness', () => {
  expect(normalizedChatName('  Cafe\u0301   🎮 Night  ', 80)).toEqual({
    name: 'Café 🎮 Night',
    key: 'café 🎮 night',
  });
  expect(normalizedChatName('CAFÉ 🎮 NIGHT', 80)?.key).toBe(
    normalizedChatName('Café 🎮 Night', 80)?.key,
  );
  expect(normalizedChatName('👩‍💻 friends', 80)?.name).toBe('👩‍💻 friends');
});

it('counts Unicode code points rather than UTF-16 code units', () => {
  expect(normalizedChatName('🎮'.repeat(80), 80)).toBeDefined();
  expect(normalizedChatName('🎮'.repeat(81), 80)).toBeUndefined();
  expect(normalizedChatName('a'.repeat(48), 48)).toBeDefined();
  expect(normalizedChatName('a'.repeat(49), 48)).toBeUndefined();
});

it('rejects empty names, invisible-only names, controls, bidi overrides and lone surrogates', () => {
  for (const name of ['', '   ', '\u200b', '\u0301', 'hidden\u0000name', 'ab\u202ecd', '\ud800'])
    expect(normalizedChatName(name, 80)).toBeUndefined();
  expect(normalizedChatName(null, 80)).toBeUndefined();
});
