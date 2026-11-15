import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EmojiPicker } from './EmojiPicker';
import { GifPreviews } from './GifPreviews';

describe('opt-in media controls', () => {
  it('renders only consent controls and ordinary links, with no automatic resource requests', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const body = Array.from(
        { length: 100 },
        (_, index) => `https://media.tenor.com/example${index}.gif`,
      ).join(' ');
      const html = renderToStaticMarkup(createElement(GifPreviews, { body }));
      expect(html.match(/Load GIF \(paused\)/g)).toHaveLength(2);
      expect(html.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(2);
      expect(html).toContain('Nothing loads automatically');
      expect(html).toContain('IP address');
      expect(html).toContain('without account cookies or a referrer');
      expect(html).not.toMatch(/<(?:img|iframe|video)\b/);
      expect(html).not.toMatch(/\bsrc=/);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });

  it('does not render controls for code, image syntax or unapproved hosts', () => {
    for (const body of [
      '`https://media.giphy.com/example.gif`',
      '![image](https://media.giphy.com/example.gif)',
      'https://unapproved.example/example.gif',
      '<iframe src="https://unapproved.example/example.gif"></iframe>',
    ])
      expect(renderToStaticMarkup(createElement(GifPreviews, { body }))).toBe('');
  });

  it('has a named keyboard/touch disclosure and can disable emoji insertion', () => {
    const select = vi.fn();
    const enabled = renderToStaticMarkup(createElement(EmojiPicker, { onSelect: select }));
    expect(enabled).toContain('type="button"');
    expect(enabled).toContain('aria-expanded="false"');
    expect(enabled).toContain('Emoji</button>');
    expect(enabled).not.toContain('emoji-picker-panel');
    expect(select).not.toHaveBeenCalled();
    const disabled = renderToStaticMarkup(
      createElement(EmojiPicker, { onSelect: select, disabled: true }),
    );
    expect(disabled).toContain('disabled=""');
    expect(disabled).toContain('aria-expanded="false"');
  });
});
