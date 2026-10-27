import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageBody, messageParts } from './MessageBody';

const links = (body: string) => messageParts(body).filter((part) => part.href);

describe('chat hyperlinks', () => {
  it('preserves plain text, mentions, emoji and line breaks', () => {
    const body = 'Hello @friend 👋\n  still plain <b>text</b>';
    expect(messageParts(body)).toEqual([{ text: body }]);
    expect(messageParts('')).toEqual([]);
  });

  it('detects multiple explicit web links while preserving all surrounding text', () => {
    const body = 'See https://github.com, then HTTP://example.com/a?q=1&b=2!\nDone.';
    expect(links(body).map((part) => part.href)).toEqual([
      'https://github.com/',
      'http://example.com/a?q=1&b=2',
    ]);
    expect(
      messageParts(body)
        .map((part) => part.text)
        .join(''),
    ).toBe(body);
  });

  it('excludes sentence punctuation and unmatched brackets but keeps balanced URL parentheses', () => {
    expect(
      links('(https://example.com/a_(b)). [https://example.com/x];').map((p) => p.text),
    ).toEqual(['https://example.com/a_(b)', 'https://example.com/x']);
    expect(links('https://example.com/?q=a%20b#section')[0]?.href).toBe(
      'https://example.com/?q=a%20b#section',
    );
  });

  it('supports labeled links including balanced destination parentheses', () => {
    expect(
      messageParts('See [GitHub](https://github.com) and [wiki](https://example.com/a_(b)).'),
    ).toEqual([
      { text: 'See ' },
      { text: 'GitHub', href: 'https://github.com/' },
      { text: ' and ' },
      { text: 'wiki', href: 'https://example.com/a_(b)' },
      { text: '.' },
    ]);
  });

  it('keeps code and image syntax literal', () => {
    expect(
      links('`https://example.com`\n```\nhttps://github.com\n```\n![x](https://example.com)'),
    ).toEqual([]);
    expect(links('```\nhttps://example.com')).toEqual([]);
  });

  it.each([
    'javascript:alert(1)',
    '[bad](javascript:alert(1))',
    '[bad](data:text/html,evil)',
    'file:///etc/passwd',
    'https://',
    'https://[broken',
    'https://user:pass@example.com',
    'https://example.com\\evil',
    'abchttps://example.com',
    'javascript:https://example.com',
    '[bad](https://example.com\u0000evil)',
  ])('leaves unsafe or malformed input as text: %s', (body) => {
    expect(links(body)).toEqual([]);
    expect(
      messageParts(body)
        .map((part) => part.text)
        .join(''),
    ).toBe(body);
  });

  it('escapes user content and renders only secure anchor attributes', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBody, {
        body: '<img src=x onerror=alert(1)> [<script>bad</script>](https://example.com/?q=1&b=2)',
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;</a>');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.com/?q=1&amp;b=2"');
  });
});
