import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emojiParts, EmojiText } from './EmojiText';
it('keeps joined, skin-tone and flag emoji intact and renders text without HTML', () => {
  expect(
    emojiParts('Hi 👩🏽‍💻 🇭🇷!')
      .filter((part) => part.emoji)
      .map((part) => part.text),
  ).toEqual(['👩🏽‍💻', '🇭🇷']);
  const html = renderToStaticMarkup(createElement(EmojiText, { text: '<img src=x> 👩🏽‍💻' }));
  expect(html).toContain('&lt;img');
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('/emoji/17-b6b55fef/');
  expect(html).toContain('class="emoji-glyph"');
});
