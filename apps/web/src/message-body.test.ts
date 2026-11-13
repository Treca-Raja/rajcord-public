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

  it('supports nested destination parentheses without leaving partial Markdown links', () => {
    expect(messageParts('[wiki](https://example.com/a_(b_(c)))')).toEqual([
      { text: 'wiki', href: 'https://example.com/a_(b_(c))' },
    ]);
  });

  it.each([
    '[space](https://example.com/a b)',
    '[title](https://example.com "title")',
    '[missing](https://example.com/a_(b)',
    '[bad](https://example.com/a_(javascript:alert(1)) trailing)',
    '![image](https://example.com/a_(b_(c)))',
  ])('keeps unsupported or incomplete Markdown literal: %s', (body) => {
    expect(messageParts(body)).toEqual([{ text: body }]);
  });

  it('continues link detection on the next line after incomplete Markdown', () => {
    expect(links('[broken](https://example.com\nhttps://github.com')).toEqual([
      { text: 'https://github.com', href: 'https://github.com/' },
    ]);
  });

  it.each(['*', '**', '_', '__', '~~', '**_'])('excludes paired emphasis markers: %s', (marker) => {
    const closing = [...marker].reverse().join('');
    const body = marker + 'https://example.com/path' + closing + '.';
    expect(links(body)).toEqual([
      { text: 'https://example.com/path', href: 'https://example.com/path' },
    ]);
    expect(
      messageParts(body)
        .map((part) => part.text)
        .join(''),
    ).toBe(body);
  });

  it('preserves legitimate trailing URL markers when they are not paired formatting', () => {
    for (const suffix of ['*', '~', '_', '%2A', '?q=x_']) {
      const url = 'https://example.com/path' + suffix;
      expect(links(url)).toEqual([{ text: url, href: url }]);
    }
    expect(links('**https://example.com/path_**')).toEqual([
      { text: 'https://example.com/path_', href: 'https://example.com/path_' },
    ]);
  });

  it('preserves maximum-length repeated brackets and malformed link prefixes', () => {
    for (const body of ['['.repeat(4000), '[x]('.repeat(1000)]) {
      expect(links(body)).toEqual([]);
      expect(
        messageParts(body)
          .map((part) => part.text)
          .join(''),
      ).toBe(body);
    }
  });

  it('shows the actual normalized destination in titles for URL labels and Unicode domains', () => {
    for (const [body, destination] of [
      ['[https://paypal.com](https://evil.example)', 'https://evil.example/'],
      ['https://ex\u0430mple.com', 'https://xn--exmple-4nf.com/'],
    ]) {
      const html = renderToStaticMarkup(createElement(MessageBody, { body: body! }));
      expect(html).toContain('title="' + destination + '"');
      expect(html).toContain('href="' + destination + '"');
    }
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
