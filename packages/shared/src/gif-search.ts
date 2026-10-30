export type GifProvider = 'giphy' | 'tenor' | 'klipy';

export type GifSearchRequest = {
  provider: GifProvider;
  query: string;
  cursor?: string;
};

export type GifSearchResult = {
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
};

export type GifSearchPage = {
  provider: GifProvider;
  items: GifSearchResult[];
  nextCursor: string | null;
  attribution: { label: string; url: string };
  omittedCount: number;
};

export type GifProvidersResponse = {
  providers: (
    | { id: 'giphy' | 'klipy'; label: string; enabled: boolean; publicKey?: string }
    | { id: 'tenor'; label: string; enabled: boolean; publicKey?: never }
  )[];
};

const giphyMediaHosts = new Set([
  'media.giphy.com',
  'i.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
]);

function giphyCursor(cursor: unknown): number {
  if (cursor === undefined) return 0;
  if (
    typeof cursor !== 'string' ||
    !/^giphy:[1-9]\d{0,3}$/.test(cursor) ||
    Number(cursor.slice(6)) > 4999
  )
    throw new Error('Invalid GIPHY search cursor.');
  return Number(cursor.slice(6));
}

export function buildGiphySearchUrl(publicKey: string, query: string, cursor?: string): string {
  if (
    typeof publicKey !== 'string' ||
    !publicKey.length ||
    publicKey.length > 512 ||
    /[^\x21-\x7e]/.test(publicKey)
  )
    throw new Error('GIPHY is not configured.');
  if (
    typeof query !== 'string' ||
    query.trim().length < 2 ||
    query.length > 50 ||
    /\p{Cc}/u.test(query)
  )
    throw new Error('Use a GIPHY search between 2 and 50 characters.');
  const offset = giphyCursor(cursor);
  const url = new URL('https://api.giphy.com/v1/gifs/search');
  url.searchParams.set('api_key', publicKey);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '12');
  url.searchParams.set('rating', 'pg');
  if (offset) url.searchParams.set('offset', String(offset));
  return url.href;
}

function giphyInvalid(): never {
  throw new Error('Invalid GIPHY search response.');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return giphyInvalid();
  return value as Record<string, unknown>;
}

function giphyMediaUrl(value: unknown, still: boolean): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^https:\/\//i.test(value) ||
    /[\s\\#]|\p{Cc}/u.test(value) ||
    /(?:^|\/)(?:\.|%2e){1,2}(?:\/|[?#]|$)/i.test(value)
  )
    return giphyInvalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return giphyInvalid();
  }
  const segments = url.pathname.slice(1).split('/');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !giphyMediaHosts.has(url.hostname) ||
    segments[0] !== 'media' ||
    segments.length < 3 ||
    segments.length > 4 ||
    segments.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..') ||
    (still ? !/_s\.(?:gif|webp|png)$/.test(url.pathname) : !url.pathname.endsWith('.gif'))
  )
    return giphyInvalid();
  // GIPHY requires media URLs, including their host and query, to remain unchanged.
  return value;
}

function giphyDimension(value: unknown): number {
  const number = typeof value === 'string' && /^[1-9]\d{0,4}$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 10000)
    return giphyInvalid();
  return number;
}

export function parseGiphySearchPage(value: unknown, cursor?: string): GifSearchPage {
  const offset = giphyCursor(cursor);
  const source = object(value);
  const meta = object(source.meta);
  if (meta.status === 429) throw new Error('GIPHY quota reached. Try again later.');
  if (
    meta.status !== 200 ||
    'error' in source ||
    !Array.isArray(source.data) ||
    source.data.length > 12
  )
    return giphyInvalid();
  const pagination = object(source.pagination);
  if (
    pagination.offset !== offset ||
    pagination.count !== source.data.length ||
    typeof pagination.total_count !== 'number' ||
    !Number.isSafeInteger(pagination.total_count) ||
    pagination.total_count < 0
  )
    return giphyInvalid();
  const ids = new Set<string>();
  const items = source.data.map((value: unknown): GifSearchResult => {
    const entry = object(value);
    if (
      typeof entry.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.title !== 'string' ||
      entry.title.length > 200 ||
      /[<>\p{Cc}]/u.test(entry.title)
    )
      return giphyInvalid();
    ids.add(entry.id);
    const images = object(entry.images);
    const original = object(images.original);
    const still = object(images.fixed_width_small_still);
    return {
      id: entry.id,
      title: entry.title.trim() || 'GIF',
      url: giphyMediaUrl(original.url, false),
      previewUrl: giphyMediaUrl(still.url, true),
      width: giphyDimension(original.width),
      height: giphyDimension(original.height),
    };
  });
  const next = offset + items.length;
  return {
    provider: 'giphy',
    items,
    nextCursor:
      items.length && next < pagination.total_count && next <= 4999 ? 'giphy:' + next : null,
    attribution: { label: 'Powered By GIPHY', url: 'https://giphy.com/' },
    omittedCount: 0,
  };
}
