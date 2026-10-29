import { expect, it } from 'vitest';
import { safeHttpUrl } from './http-url.js';

it('allows only explicit HTTP(S) destinations for rendering and desktop browser launches', () => {
  expect(safeHttpUrl('HTTPS://example.com/a')).toBe('https://example.com/a');
  expect(safeHttpUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///tmp/x',
    '//example.com',
    ' https://example.com',
    'https://example.com\n',
    'https://example.com/\u0000',
    'https://user@example.com',
    'https://',
    'https://example.com\\x',
    'https:///example.com',
    'mailto:friend@example.com',
  ]) {
    expect(safeHttpUrl(url)).toBeUndefined();
  }
});
