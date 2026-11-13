import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { GifProvidersResponse, GifSearchPage, GifSearchResult } from '@tricord/shared';
import { HttpError, input } from '../auth/validation.js';

export type GifSearchConfig = {
  // GIPHY requires direct browser requests, so approved clients receive this public key.
  giphyApiKey?: string;
  klipyApiKey?: string;
  tenorApiKey?: string;
};

export type GifSearchOptions = {
  guard: (request: FastifyRequest) => Promise<void>;
  config: GifSearchConfig;
  limits: boolean;
  fetcher?: typeof fetch;
};

const pageSize = 12;
const maxBytes = 1024 * 1024;
const timeoutMs = 5000;
const endpoint = 'https://tenor.googleapis.com/v2/search';

export function gifSearchConfig(env: Record<string, string | undefined>): GifSearchConfig {
  const key = (name: string) => {
    const value = env[name]?.trim();
    if (!value) return undefined;
    if (value.length > 512 || /[^\x21-\x7e]/.test(value))
      throw new Error('Invalid GIF provider configuration.');
    return value;
  };
  return {
    giphyApiKey: key('GIPHY_API_KEY'),
    tenorApiKey: key('TENOR_API_KEY'),
    klipyApiKey: key('KLIPY_API_KEY'),
  };
}

function unavailable() {
  return new HttpError(502, 'GIF provider unavailable. Try again later.');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function position(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 262 || !value.startsWith('tenor:'))
    throw new HttpError(400, 'Invalid GIF search cursor.');
  const cursor = value.slice(6);
  if (!/^[A-Za-z0-9_~.+/=-]{1,256}$/.test(cursor) || cursor === '0')
    throw new HttpError(400, 'Invalid GIF search cursor.');
  return cursor;
}

function request(value: unknown): {
  query: string;
  cursor: string | undefined;
} {
  const body = input(value, ['provider', 'query', 'cursor']);
  if (body.provider === 'giphy' || body.provider === 'klipy')
    throw new HttpError(
      409,
      (body.provider === 'giphy' ? 'GIPHY' : 'KLIPY') +
        ' search must be made directly from your browser.',
    );
  if (body.provider !== 'tenor') throw new HttpError(400, 'Choose GIPHY or Tenor.');
  if (
    typeof body.query !== 'string' ||
    body.query.length > 80 ||
    body.query.trim().length < 2 ||
    /\p{Cc}/u.test(body.query)
  )
    throw new HttpError(400, 'Use a GIF search between 2 and 80 characters.');
  return {
    query: body.query.trim(),
    cursor: position(body.cursor),
  };
}

function mediaUrl(value: unknown, still: boolean): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^https:\/\//i.test(value) ||
    /[\s\\#]|\p{Cc}/u.test(value) ||
    /(?:^|\/)(?:\.|%2e){1,2}(?:\/|[?#]|$)/i.test(value)
  )
    return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !/\.(?:gif|webp|png)$/.test(url.pathname) ||
    (!still && !url.pathname.endsWith('.gif'))
  )
    return null;
  const segments = url.pathname.slice(1).split('/');
  if (segments.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..'))
    return null;
  if (url.hostname !== 'media.tenor.com' || segments.length < 2) return null;
  return value;
}

function dimension(value: unknown): number | null {
  const number = typeof value === 'string' && /^[1-9]\d{0,4}$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 && number <= 10000
    ? number
    : null;
}

function item(value: unknown): GifSearchResult | null {
  const source = record(value);
  if (!source || typeof source.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(source.id))
    return null;
  const media = record(source.media_formats);
  const animation = record(media?.gif);
  // Only still-preview formats, never animated tinygif/nanogif renditions.
  const preview = record(
    media?.tinygifpreview ?? media?.nanogifpreview ?? media?.gifpreview ?? media?.preview,
  );
  if (!animation || !preview || (preview.duration !== undefined && preview.duration !== 0))
    return null;
  const url = mediaUrl(animation.url, false);
  const previewUrl = mediaUrl(preview.url, true);
  const dims = Array.isArray(animation.dims) ? animation.dims : [];
  const width = dimension(dims[0]);
  const height = dimension(dims[1]);
  const title =
    typeof source.content_description === 'string' ? source.content_description : source.title;
  if (
    !url ||
    !previewUrl ||
    !width ||
    !height ||
    typeof title !== 'string' ||
    title.length > 200 ||
    /[<>\p{Cc}]/u.test(title)
  )
    return null;
  return { id: source.id, title: title.trim() || 'GIF', url, previewUrl, width, height };
}

function page(value: unknown, cursor?: string): GifSearchPage {
  const source = record(value);
  if (!source || 'error' in source) throw unavailable();
  const results: unknown = source.results;
  if (!Array.isArray(results) || results.length > pageSize) throw unavailable();
  let nextCursor: string | null = null;
  if (typeof source.next !== 'string') throw unavailable();
  if (source.next && source.next !== '0') {
    try {
      position('tenor:' + source.next);
    } catch {
      throw unavailable();
    }
    if (source.next === cursor) throw unavailable();
    nextCursor = 'tenor:' + source.next;
  }
  const items: GifSearchResult[] = [];
  const ids = new Set<string>();
  for (const result of results) {
    const parsed = item(result);
    if (parsed && !ids.has(parsed.id)) {
      ids.add(parsed.id);
      items.push(parsed);
    }
  }
  if (results.length && !items.length) throw unavailable();
  return {
    provider: 'tenor',
    items,
    nextCursor,
    attribution: { label: 'Powered By Tenor', url: 'https://tenor.com/' },
    omittedCount: results.length - items.length,
  };
}

async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
    throw unavailable();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw unavailable();
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const body = new Uint8Array(maxBytes);
  let bytes = 0;
  let complete = false;
  const cancel = () => {
    // Cleanup must not hide the original provider/timeout error.
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        complete = true;
        break;
      }
      if (chunk.value.byteLength > maxBytes - bytes) throw unavailable();
      body.set(chunk.value, bytes);
      bytes += chunk.value.byteLength;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, bytes)),
    ) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export async function searchGifs(
  config: GifSearchConfig,
  body: unknown,
  { fetcher = fetch, signal }: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GifSearchPage> {
  const { query, cursor } = request(body);
  const key = config.tenorApiKey;
  if (!key) throw new HttpError(503, 'This GIF provider is not configured.');
  if (signal?.aborted) throw new HttpError(408, 'GIF search cancelled.');
  const url = new URL(endpoint);
  url.searchParams.set('key', key);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('client_key', 'rajcord');
  url.searchParams.set('contentfilter', 'high');
  url.searchParams.set('media_filter', 'gif,tinygifpreview');
  if (cursor) url.searchParams.set('pos', cursor);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () =>
      reject(
        new HttpError(
          timedOut ? 504 : 408,
          timedOut ? 'GIF provider timed out. Try again later.' : 'GIF search cancelled.',
        ),
      );
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener('abort', fail, { once: true });
  });
  try {
    const result = async () => {
      controller.signal.throwIfAborted();
      const response = await fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      controller.signal.throwIfAborted();
      if (response.redirected) throw unavailable();
      if (response.status === 429)
        throw new HttpError(429, 'GIF provider quota reached. Try again later.');
      if (!response.ok) throw unavailable();
      return page(await json(response, controller.signal), cursor);
    };
    return await Promise.race([result(), aborted]);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

export function registerGifSearch(
  app: FastifyInstance,
  { guard, config, limits, fetcher }: GifSearchOptions,
) {
  app.get(
    '/api/gifs/providers',
    { preHandler: guard, logLevel: 'silent' },
    async (): Promise<GifProvidersResponse> => ({
      providers: [
        {
          id: 'giphy',
          label: 'GIPHY',
          enabled: !!config.giphyApiKey,
          ...(config.giphyApiKey ? { publicKey: config.giphyApiKey } : {}),
        },
        { id: 'tenor', label: 'Tenor', enabled: !!config.tenorApiKey },
        {
          id: 'klipy',
          label: 'KLIPY',
          enabled: !!config.klipyApiKey,
          ...(config.klipyApiKey ? { publicKey: config.klipyApiKey } : {}),
        },
      ],
    }),
  );
  app.post(
    '/api/gifs/search',
    {
      preHandler: guard,
      logLevel: 'silent',
      config: { rateLimit: limits ? { max: 60, timeWindow: 60000 } : false },
    },
    async (req, reply) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const closed = () => {
        if (!reply.raw.writableFinished) abort();
      };
      req.raw.once('aborted', abort);
      reply.raw.once('close', closed);
      try {
        if (req.raw.aborted) controller.abort();
        return await searchGifs(config, req.body, { fetcher, signal: controller.signal });
      } finally {
        req.raw.off('aborted', abort);
        reply.raw.off('close', closed);
      }
    },
  );
}
