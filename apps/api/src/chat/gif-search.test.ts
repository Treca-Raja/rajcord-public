import { afterEach, describe, expect, it, vi } from 'vitest';
import { gifSearchConfig, searchGifs } from './gif-search.js';
import {
  buildGiphySearchUrl,
  parseGiphySearchPage,
} from '../../../../packages/shared/src/gif-search.js';

const config = {
  giphyApiKey: 'fixture-public-giphy-key',
  tenorApiKey: 'fixture-private-tenor-key',
};
const giphyItem = () => ({
  id: 'public_giphy_id',
  title: 'A friendly wave',
  images: {
    original: {
      url: 'https://media2.giphy.com/media/public_giphy_id/giphy.gif?cid=public&rid=giphy.gif&ct=g',
      width: '480',
      height: '270',
    },
    fixed_width_small_still: {
      url: 'https://media1.giphy.com/media/public_giphy_id/100w_s.gif?cid=public&rid=100w_s.gif&ct=g',
      width: '100',
      height: '56',
    },
  },
});
const giphy = (data: unknown[] = [giphyItem()], offset = 0, total = data.length) => ({
  data,
  meta: { status: 200, msg: 'OK' },
  pagination: { offset, count: data.length, total_count: total },
});
const tenorItem = () => ({
  id: '1234567890123456789',
  title: 'Wave',
  content_description: 'A friendly wave',
  media_formats: {
    gif: {
      url: 'https://media.tenor.com/public-id/AAAAC/friendly-wave.gif',
      dims: [480, 270],
      duration: 2,
    },
    preview: {
      url: 'https://media.tenor.com/public-id/AAAAD/friendly-wave.png',
      dims: [480, 270],
      duration: 0,
    },
  },
});
const tenor = (results: unknown[] = [tenorItem()], next = '') => ({ results, next });
const response = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
  });
const mocked = (body: unknown) => vi.fn<typeof fetch>(async () => response(body));
const run = (fetcher: typeof fetch, body: unknown = { provider: 'tenor', query: 'hello' }) =>
  searchGifs(config, body, { fetcher });

afterEach(() => vi.useRealTimers());

it('parses only synthetic optional configuration', () => {
  expect(gifSearchConfig({})).toEqual({
    giphyApiKey: undefined,
    tenorApiKey: undefined,
    klipyApiKey: undefined,
  });
  expect(
    gifSearchConfig({ GIPHY_API_KEY: ' fixture-public ', TENOR_API_KEY: ' fixture-private ' }),
  ).toEqual({
    giphyApiKey: 'fixture-public',
    tenorApiKey: 'fixture-private',
    klipyApiKey: undefined,
  });
  for (const value of ['key\nsecret', 'a'.repeat(513)])
    expect(() => gifSearchConfig({ TENOR_API_KEY: value })).toThrow(
      'Invalid GIF provider configuration.',
    );
  expect(gifSearchConfig({ KLIPY_API_KEY: ' fixture-klipy ' }).klipyApiKey).toBe('fixture-klipy');
  expect(() => gifSearchConfig({ KLIPY_API_KEY: 'invalid\nkey' })).toThrow();
});

it.each([{}, config])('never proxies GIPHY, regardless of key configuration', async (keys) => {
  const fetcher = mocked(giphy());
  await expect(
    searchGifs(keys, { provider: 'giphy', query: 'hello' }, { fetcher }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: 'GIPHY search must be made directly from your browser.',
  });
  expect(fetcher).not.toHaveBeenCalled();
});

describe('direct-browser GIPHY helpers', () => {
  it('builds only the fixed search endpoint with bounded pagination and unmodified query terms', () => {
    const url = new URL(buildGiphySearchUrl(config.giphyApiKey, '  hello & wave  ', 'giphy:12'));
    expect(url.origin + url.pathname).toBe('https://api.giphy.com/v1/gifs/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      api_key: config.giphyApiKey,
      q: '  hello & wave  ',
      limit: '12',
      rating: 'pg',
      offset: '12',
    });
    expect(new URL(buildGiphySearchUrl('fixture', 'a'.repeat(50))).searchParams.has('offset')).toBe(
      false,
    );
  });

  it.each(['', ' ', 'x', 'a'.repeat(51), 'new\nline'])(
    'rejects invalid browser queries: %j',
    (query) => {
      expect(() => buildGiphySearchUrl('fixture', query)).toThrow(
        'Use a GIPHY search between 2 and 50 characters.',
      );
    },
  );
  it.each(['', ' ', 'key\nsecret', 'a'.repeat(513)])(
    'rejects invalid public keys without echoing them: %j',
    (key) => {
      expect(() => buildGiphySearchUrl(key, 'hello')).toThrow('GIPHY is not configured.');
    },
  );
  it.each([
    '',
    'giphy:0',
    'giphy:01',
    'giphy:5000',
    'giphy:1&key=secret',
    'tenor:12',
    'giphy:' + '1'.repeat(100),
  ])('rejects malformed or cross-provider cursors: %s', (cursor) => {
    expect(() => buildGiphySearchUrl('fixture', 'hello', cursor)).toThrow(
      'Invalid GIPHY search cursor.',
    );
    expect(() => parseGiphySearchPage(giphy(), cursor)).toThrow('Invalid GIPHY search cursor.');
  });

  it('preserves stable IDs, result ordering, exact media hosts and every query parameter', () => {
    const first = giphyItem();
    const second = { ...giphyItem(), id: 'another_giphy_id' };
    const result = parseGiphySearchPage(giphy([first, second], 12, 50), 'giphy:12');
    expect(result).toEqual({
      provider: 'giphy',
      items: [
        {
          id: first.id,
          title: first.title,
          url: first.images.original.url,
          previewUrl: first.images.fixed_width_small_still.url,
          width: 480,
          height: 270,
        },
        {
          id: second.id,
          title: second.title,
          url: second.images.original.url,
          previewUrl: second.images.fixed_width_small_still.url,
          width: 480,
          height: 270,
        },
      ],
      nextCursor: 'giphy:14',
      attribution: { label: 'Powered By GIPHY', url: 'https://giphy.com/' },
      omittedCount: 0,
    });
  });

  it.each([
    'media.giphy.com',
    'i.giphy.com',
    ...Array.from({ length: 5 }, (_, i) => `media${i}.giphy.com`),
  ])('allows only the explicitly approved CDN host without normalizing it: %s', (host) => {
    const entry = giphyItem();
    entry.images.original.url = `https://${host}/media/public_giphy_id/giphy.gif?cid=unchanged%2Fvalue&x=1&x=2`;
    expect(parseGiphySearchPage(giphy([entry])).items[0]?.url).toBe(entry.images.original.url);
  });

  it.each([
    'https://evil.invalid/media/id/giphy.gif',
    'https://media.giphy.com.evil.invalid/media/id/giphy.gif',
    'https://media5.giphy.com/media/id/giphy.gif',
    'https://media99.giphy.com/media/id/giphy.gif',
    'https://user:password@media.giphy.com/media/id/giphy.gif',
    'http://media.giphy.com/media/id/giphy.gif',
    'https:media.giphy.com/media/id/giphy.gif',
    'https://media.giphy.com:444/media/id/giphy.gif',
    'https://media.giphy.com/media/id/giphy.gif#fragment',
    'https://media.giphy.com/media/id/giphy.gif#',
    'https://media.giphy.com/media/id/giphy.svg',
    'https://media.giphy.com/media/id/giphy.gif.html',
    'https://media.giphy.com/media/id/%2e%2e/id/giphy.gif',
    'https://media.giphy.com/media/id/../id/giphy.gif',
    'https://media.tenor.com/id/AAAAC/wave.gif',
    'javascript:alert(1)',
  ])('fails the whole GIPHY page rather than filtering unsafe media: %s', (url) => {
    const bad = giphyItem();
    bad.images.original.url = url;
    expect(() => parseGiphySearchPage(giphy([giphyItem(), { ...bad, id: 'bad' }]))).toThrow(
      'Invalid GIPHY search response.',
    );
  });

  it.each([
    null,
    {},
    { id: '<script>' },
    { ...giphyItem(), title: '<script>HTML</script>' },
    { ...giphyItem(), title: 'a'.repeat(201) },
    { ...giphyItem(), title: 'control\u0000' },
  ])('rejects every malformed entry without returning a partial success: %j', (entry) => {
    expect(() => parseGiphySearchPage(giphy([giphyItem(), entry]))).toThrow(
      'Invalid GIPHY search response.',
    );
  });
  it('rejects malformed dimensions, animated thumbnails, duplicate IDs and oversized pages', () => {
    for (const width of ['0', '-1', '1.2', '1e3', '10001']) {
      const entry = giphyItem();
      entry.images.original.width = width;
      expect(() => parseGiphySearchPage(giphy([entry]))).toThrow('Invalid GIPHY search response.');
    }
    const animated = giphyItem();
    animated.images.fixed_width_small_still.url = animated.images.original.url;
    for (const entries of [
      [animated],
      [giphyItem(), giphyItem()],
      Array.from({ length: 13 }, giphyItem),
    ])
      expect(() => parseGiphySearchPage(giphy(entries))).toThrow('Invalid GIPHY search response.');
  });
  it.each([
    null,
    [],
    {},
    { ...giphy(), data: {} },
    { ...giphy(), error: 'private upstream error' },
    { ...giphy(), meta: { status: 403, msg: 'private upstream error' } },
    { ...giphy(), pagination: { offset: 1, count: 1, total_count: 2 } },
    { ...giphy(), pagination: { offset: 0, count: 2, total_count: 2 } },
    { ...giphy(), pagination: { offset: 0, count: 1, total_count: '2' } },
  ])('rejects malformed envelopes safely: %j', (body) => {
    expect(() => parseGiphySearchPage(body)).toThrow('Invalid GIPHY search response.');
  });
  it('distinguishes real empty results, quota exhaustion and the final supported offset', () => {
    expect(parseGiphySearchPage(giphy([]))).toMatchObject({
      items: [],
      nextCursor: null,
      omittedCount: 0,
    });
    expect(
      parseGiphySearchPage(giphy([giphyItem()], 4999, 6000), 'giphy:4999').nextCursor,
    ).toBeNull();
    expect(() =>
      parseGiphySearchPage({ ...giphy(), meta: { status: 429, msg: 'secret' } }),
    ).toThrow('GIPHY quota reached. Try again later.');
  });
});

describe('server-side Tenor', () => {
  it('accepts v2 still thumbnails with two-segment CDN paths and omitted duration without rewriting URLs', async () => {
    const url = 'https://media.tenor.com/lvhETqpBuVgAAAAM/hello.gif?foo=1&bar=%2F';
    const previewUrl = 'https://media.tenor.com/lvhETqpBuVgAAAAe/hello.png?foo=2&bar=%2F';
    const fetcher = mocked(
      tenor([
        {
          id: 'tenor-fixture',
          content_description: 'Fixture Tenor wave',
          media_formats: {
            gif: { url, dims: [1, 1] },
            tinygifpreview: { url: previewUrl, dims: [1, 1] },
          },
        },
      ]),
    );
    expect((await run(fetcher)).items).toEqual([
      { id: 'tenor-fixture', title: 'Fixture Tenor wave', url, previewUrl, width: 1, height: 1 },
    ]);
  });

  it.each(['tinygifpreview', 'nanogifpreview', 'gifpreview', 'preview'])(
    'accepts the returned static %s URL with optional zero duration',
    async (format) => {
      for (const metadata of [{}, { duration: 0 }]) {
        const previewUrl = 'https://media.tenor.com/opaque-preview-id/hello.png?preserve=%2f';
        const entry = {
          id: 'tenor-fixture',
          title: 'Title fallback',
          media_formats: {
            gif: { url: 'https://media.tenor.com/opaque-id/hello.gif', dims: [1, 1] },
            [format]: { url: previewUrl, ...metadata },
          },
        };
        expect((await run(mocked(tenor([entry])))).items[0]).toMatchObject({
          title: 'Title fallback',
          previewUrl,
        });
      }
    },
  );

  it('prefers the tiny still preview without manufacturing a URL or choosing animated renditions', async () => {
    const entry = tenorItem();
    const tiny = 'https://media.tenor.com/tiny-preview-id/hello.png?keep=true';
    const payload = {
      ...entry,
      media_formats: {
        ...entry.media_formats,
        tinygifpreview: { url: tiny },
        nanogifpreview: { url: 'https://media.tenor.com/nano-preview-id/hello.png' },
        tinygif: { url: entry.media_formats.gif.url, duration: 2 },
      },
    };
    expect((await run(mocked(tenor([payload])))).items[0]?.previewUrl).toBe(tiny);
    await expect(
      run(
        mocked(
          tenor([
            {
              ...entry,
              media_formats: {
                gif: entry.media_formats.gif,
                tinygif: { url: entry.media_formats.gif.url, duration: 0 },
              },
            },
          ]),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('uses the fixed endpoint and current schema with a documented single-frame preview', async () => {
    const fetcher = mocked(tenor([tenorItem()], 'CAoQ-abc=='));
    const result = await run(fetcher, { provider: 'tenor', query: 'hello', cursor: 'tenor:12.5' });
    expect(result.items[0]).toEqual({
      id: '1234567890123456789',
      title: 'A friendly wave',
      url: 'https://media.tenor.com/public-id/AAAAC/friendly-wave.gif',
      previewUrl: 'https://media.tenor.com/public-id/AAAAD/friendly-wave.png',
      width: 480,
      height: 270,
    });
    expect(result.nextCursor).toBe('tenor:CAoQ-abc==');
    const [target, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(target));
    expect(url.origin + url.pathname).toBe('https://tenor.googleapis.com/v2/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      key: config.tenorApiKey,
      q: 'hello',
      limit: '12',
      client_key: 'rajcord',
      contentfilter: 'high',
      media_filter: 'gif,tinygifpreview',
      pos: '12.5',
    });
    expect(init).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    expect(JSON.stringify(result)).not.toContain('fixture-');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects missing Tenor configuration before fetching', async () => {
    const fetcher = mocked({});
    await expect(
      searchGifs({}, { provider: 'tenor', query: 'hello' }, { fetcher }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { provider: 'other', query: 'hello' },
    { provider: 'tenor', query: '' },
    { provider: 'tenor', query: ' ' },
    { provider: 'tenor', query: 'x' },
    { provider: 'tenor', query: 'a'.repeat(81) },
    { provider: 'tenor', query: 'new\nline' },
    { provider: 'tenor', query: 42 },
    { provider: 'tenor', query: 'hello', url: 'https://evil.invalid' },
    ...[
      null,
      '',
      'tenor:0',
      'giphy:12',
      'tenor:https://evil.invalid',
      'tenor:12?key=bad',
      'tenor:' + 'a'.repeat(257),
    ].map((cursor) => ({ provider: 'tenor', query: 'hello', cursor })),
  ])('rejects invalid requests without fetching: %j', async (body) => {
    const fetcher = mocked({});
    await expect(run(fetcher, body)).rejects.toMatchObject({ statusCode: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('accepts 80 characters and reports partial malformed Tenor entries explicitly', async () => {
    const result = await run(mocked(tenor([tenorItem(), null, { id: 'bad' }])), {
      provider: 'tenor',
      query: 'a'.repeat(80),
    });
    expect(result.items).toHaveLength(1);
    expect(result.omittedCount).toBe(2);
    await expect(run(mocked(tenor([null])))).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each([
    {},
    { ...tenor(), next: undefined },
    { ...tenor(), next: 'a'.repeat(257) },
    { ...tenor(), next: 'https://evil.invalid' },
    { ...tenor(), next: '12' },
    { ...tenor(), error: { message: 'fixture-private-key' } },
    { results: Array.from({ length: 13 }, tenorItem), next: '' },
  ])('rejects malformed envelopes and cursors: %j', async (body) => {
    await expect(
      run(mocked(body), { provider: 'tenor', query: 'hello', cursor: 'tenor:12' }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each([
    'https://evil.invalid/id/AAAAC/wave.gif',
    'https://media.tenor.com.evil.invalid/id/AAAAC/wave.gif',
    'https://user:password@media.tenor.com/id/AAAAC/wave.gif',
    'https://media.tenor.com:8443/id/AAAAC/wave.gif',
    'https://media.tenor.com/id/AAAAC/wave.gif#fragment',
    'https://media.tenor.com/id/AAAAC/wave.gif.js',
    'https://media.tenor.com/id/AAAAC/wave.svg',
    'https://media.giphy.com/media/id/giphy.gif',
    'https:media.tenor.com/id/wave.gif',
    'https://media.tenor.com/id/../id/wave.gif',
    'https://media.tenor.com/id/%2e%2e/id/wave.gif',
    'https://media.tenor.com/id/wave.gif#',
    'https://media.tenor.com/id/wave.gif.html',
    'https://media.tenor.com/id/wave.svg',
    'https://user:password@media.tenor.com/id/wave.gif',
    'https://media.tenor.com.evil.invalid/id/wave.gif',
  ])('rejects unsafe Tenor media: %s', async (url) => {
    const entry = tenorItem();
    entry.media_formats.gif.url = url;
    await expect(run(mocked(tenor([entry])))).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each(['tinygifpreview', 'nanogifpreview', 'gifpreview', 'preview'])(
    'rejects nonzero or malformed static-preview duration for %s',
    async (format) => {
      for (const duration of [1, -1, null, '0']) {
        const entry = tenorItem();
        const changed = {
          ...entry,
          media_formats: {
            gif: entry.media_formats.gif,
            [format]: { ...entry.media_formats.preview, duration },
          },
        };
        await expect(run(mocked(tenor([changed])))).rejects.toMatchObject({ statusCode: 502 });
      }
    },
  );
  it.each([301, 302, 307, 400, 401, 403, 404, 500, 503])(
    'sanitizes upstream HTTP %i',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        response(
          { error: 'fixture-private-key and query' },
          {
            status,
            headers: { location: 'https://evil.invalid/?key=fixture-private-key' },
          },
        ),
      );
      await expect(run(fetcher)).rejects.toMatchObject({
        statusCode: 502,
        message: 'GIF provider unavailable. Try again later.',
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it('rejects already-followed redirects and exposes safe quota failures', async () => {
    const redirected = response(tenor());
    Object.defineProperty(redirected, 'redirected', { value: true });
    await expect(run(vi.fn<typeof fetch>(async () => redirected))).rejects.toMatchObject({
      statusCode: 502,
    });
    await expect(
      run(vi.fn<typeof fetch>(async () => response({ secret: 'private' }, { status: 429 }))),
    ).rejects.toMatchObject({
      statusCode: 429,
      message: 'GIF provider quota reached. Try again later.',
    });
  });
  it.each(['text/html', 'text/plain', 'image/gif', 'application/javascript', 'application/jsonp'])(
    'rejects unsafe Content-Type %s',
    async (contentType) => {
      await expect(
        run(
          vi.fn<typeof fetch>(async () =>
            response(tenor(), { headers: { 'content-type': contentType } }),
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 502 });
    },
  );
  it('sanitizes invalid JSON, UTF-8, stream errors and network errors', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>(
        async () =>
          new Response('private key and query', {
            headers: { 'content-type': 'application/json' },
          }),
      ),
      vi.fn<typeof fetch>(
        async () =>
          new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
      ),
      vi.fn<typeof fetch>(async () => {
        throw new Error('https://tenor.googleapis.com/?key=fixture-private-key&q=private-query');
      }),
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.error(new Error('private-key'));
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    ])
      await expect(run(fetcher)).rejects.toMatchObject({
        statusCode: 502,
        message: 'GIF provider unavailable. Try again later.',
      });
  });
  it.each(['1048577', '-1', 'Infinity', '1e9'])(
    'rejects unsafe declared byte length %s',
    async (length) => {
      await expect(
        run(
          vi.fn<typeof fetch>(async () =>
            response(tenor(), { headers: { 'content-length': length } }),
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 502 });
    },
  );
  it('enforces the streamed 1 MiB cap even when Content-Length lies and cancels reading', async () => {
    const cancel = vi.fn();
    let count = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        count++;
        c.enqueue(new Uint8Array(512 * 1024));
      },
      cancel,
    });
    await expect(
      run(
        vi.fn<typeof fetch>(
          async () =>
            new Response(stream, {
              headers: { 'content-type': 'application/json', 'content-length': '1' },
            }),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(count).toBeLessThanOrEqual(4);
  });
  it('accepts valid streamed JSON exactly at the byte cap', async () => {
    const body = new Uint8Array(1024 * 1024).fill(32);
    body.set(new TextEncoder().encode(JSON.stringify(tenor())));
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(body.slice(0, 100));
          c.enqueue(body.slice(100));
          c.close();
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    expect((await run(vi.fn<typeof fetch>(async () => upstream))).items).toHaveLength(1);
  });
  it('times out a stalled fetch even if the implementation ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const assertion = expect(run(fetcher)).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it('times out and cancels a stalled response stream', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const assertion = expect(run(fetcher)).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels work on disconnect, including before a request begins', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const assertion = expect(
      searchGifs(
        config,
        { provider: 'tenor', query: 'hello' },
        { fetcher, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ statusCode: 408 });
    controller.abort();
    await assertion;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    const unused = mocked(tenor());
    await expect(
      searchGifs(
        config,
        { provider: 'tenor', query: 'hello' },
        { fetcher: unused, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ statusCode: 408 });
    expect(unused).not.toHaveBeenCalled();
  });
});
