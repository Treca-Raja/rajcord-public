import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fetchGiphyPage, fetchKlipyPage, GifSearch } from './GifSearch';

vi.mock('./Auth', () => ({ useAuth: () => ({ request: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());
it('offers separate GIPHY/KLIPY tabs, attribution and no retired Tenor choice', () => {
  const html = renderToStaticMarkup(
    createElement(GifSearch, { open: true, onClose: () => {}, onSend: async () => {} }),
  );
  expect(html).toContain('Search GIPHY');
  expect(html).toContain('maxLength="50"');
  expect(html).toContain('Powered By GIPHY');
  expect(html).not.toContain('Tenor');
  expect(html).toContain('role="tablist"');
  expect(html).toContain('>KLIPY</button>');
});
it('contacts KLIPY directly and surfaces provider failures without a server fallback', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    fetchKlipyPage('fixture-public', 'wave', null, new AbortController().signal),
  ).rejects.toThrow('KLIPY is busy');
  expect(new URL(String(fetcher.mock.calls[0]?.[0])).origin).toBe('https://api.klipy.com');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
it('contacts GIPHY directly without credentials/referrer or redirects and enforces a response budget', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('x'.repeat(1024 * 1024 + 1), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    fetchGiphyPage('public-fixture-key', 'cats', null, new AbortController().signal),
  ).rejects.toThrow('too large');
  const [url, options] = fetcher.mock.calls[0]!;
  expect(new URL(String(url)).origin).toBe('https://api.giphy.com');
  expect(options).toMatchObject({
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  });
});
it('surfaces provider and invalid response failures instead of returning empty successes', async () => {
  for (const response of [
    new Response('{}', { status: 429 }),
    new Response('oops', { headers: { 'content-type': 'application/json' } }),
    new Response('html', { headers: { 'content-type': 'text/html' } }),
  ]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    await expect(
      fetchGiphyPage('public-fixture-key', 'cats', null, new AbortController().signal),
    ).rejects.toThrow();
  }
});
