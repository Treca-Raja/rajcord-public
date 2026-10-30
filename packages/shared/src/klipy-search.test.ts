import { expect, it } from 'vitest';
import { buildKlipySearchUrl, parseKlipySearchPage } from './klipy-search.js';

const item = (id = '1') => ({
  id,
  content_description: 'Fixture wave',
  media_formats: {
    gif: { url: 'https://static.klipy.com/ii/fixture/wave.gif?delivery=a%2Fb', dims: [320, 240] },
    preview: {
      url: 'https://static1.klipy.com/ii/fixture/still.gif?delivery=unchanged',
      dims: [96, 72],
      duration: 0,
      size: 1024,
    },
  },
});
it('uses only the fixed browser endpoint and keeps the original query and opaque cursor', () => {
  const url = new URL(buildKlipySearchUrl('fixture-public', '  wave & smile!  ', 'klipy:12.5'));
  expect(url.origin + url.pathname).toBe('https://api.klipy.com/v2/search');
  expect(url.searchParams.get('q')).toBe('  wave & smile!  ');
  expect(url.searchParams.get('pos')).toBe('12.5');
  expect(url.searchParams.get('media_filter')).toBe('gif,preview');
  expect(url.searchParams.get('limit')).toBe('12');
  expect(() => buildKlipySearchUrl('fixture', 'hi', 'giphy:12')).toThrow('cursor');
  expect(() => buildKlipySearchUrl('fixture', 'x'.repeat(81))).toThrow('80');
});
it('preserves every result in provider order and leaves delivery URLs unchanged', () => {
  const a = item('2'),
    b = item('1');
  const result = parseKlipySearchPage({ results: [a, b], next: '24' });
  expect(result.items.map((entry) => entry.id)).toEqual(['2', '1']);
  expect(result.items[0]?.url).toBe(a.media_formats.gif.url);
  expect(result.items[0]?.previewUrl).toBe(a.media_formats.preview.url);
  expect(result.nextCursor).toBe('klipy:24');
  expect(result.omittedCount).toBe(0);
});
it('rejects the whole malformed page rather than silently filtering provider results', () => {
  for (const value of [
    { results: [item(), item()], next: '' },
    { results: [item()], next: '12' },
    { results: [item()], next: null },
    { results: [item()], next: Infinity },
    { results: Array.from({ length: 13 }, (_, index) => item(String(index))), next: '' },
  ])
    expect(() => parseKlipySearchPage(value, 'klipy:12')).toThrow();
});
it('rejects unsafe media, animated thumbnails and over-budget still previews', () => {
  for (const change of [
    (entry: ReturnType<typeof item>) => {
      entry.media_formats.gif.url = 'https://evil.invalid/x.gif';
    },
    (entry: ReturnType<typeof item>) => {
      entry.media_formats.gif.url = 'https://static.klipy.com@evil.invalid/x.gif';
    },
    (entry: ReturnType<typeof item>) => {
      entry.media_formats.preview.duration = 1;
    },
    (entry: ReturnType<typeof item>) => {
      entry.media_formats.preview.dims = [2000, 2000];
    },
    (entry: ReturnType<typeof item>) => {
      entry.media_formats.preview.size = 1024 * 1024 + 1;
    },
  ]) {
    const entry = item();
    change(entry);
    expect(() => parseKlipySearchPage({ results: [entry], next: '' })).toThrow();
  }
});
it('accepts empty results and both documented terminal cursor representations', () => {
  for (const next of ['', '0', 0])
    expect(parseKlipySearchPage({ results: [], next }).nextCursor).toBeNull();
});
