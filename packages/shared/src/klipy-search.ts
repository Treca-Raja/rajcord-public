import type { GifSearchPage, GifSearchResult } from './gif-search.js';

export const klipyMediaHosts = [
  'static.klipy.com',
  'static1.klipy.com',
  'static2.klipy.com',
] as const;

function invalid(): never {
  throw new Error('Invalid KLIPY search response.');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function cursorValue(value: string): string {
  if (!/^klipy:[A-Za-z0-9_~.+/=-]{1,256}$/.test(value) || value === 'klipy:0')
    throw new Error('Invalid KLIPY search cursor.');
  return value.slice(6);
}
export function buildKlipySearchUrl(key: string, query: string, cursor?: string): string {
  if (!key || key.length > 512 || /[^\x21-\x7e]/.test(key))
    throw new Error('KLIPY is not configured.');
  if (query.trim().length < 2 || query.length > 80 || /\p{Cc}/u.test(query))
    throw new Error('Use a KLIPY search between 2 and 80 characters.');
  const url = new URL('https://api.klipy.com/v2/search');
  url.searchParams.set('key', key);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '12');
  url.searchParams.set('media_filter', 'gif,preview');
  if (cursor) url.searchParams.set('pos', cursorValue(cursor));
  return url.href;
}
function mediaUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('https://') ||
    /[\s\\#]|\p{Cc}/u.test(value) ||
    /(?:^|\/)(?:\.|%2e){1,2}(?:\/|[?#]|$)/i.test(value)
  )
    return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !klipyMediaHosts.some((host) => host === url.hostname) ||
    !/^\/[A-Za-z0-9_./%-]+\.gif$/.test(url.pathname)
  )
    return invalid();
  return value;
}
function dimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10000)
    return invalid();
  return value;
}
export function parseKlipySearchPage(value: unknown, cursor?: string): GifSearchPage {
  const current = cursor ? cursorValue(cursor) : undefined;
  const source = record(value);
  if ('error' in source || !Array.isArray(source.results) || source.results.length > 12)
    return invalid();
  const ids = new Set<string>();
  const items = source.results.map((value: unknown): GifSearchResult => {
    const entry = record(value);
    if (
      typeof entry.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id) ||
      ids.has(entry.id)
    )
      return invalid();
    ids.add(entry.id);
    const title = entry.content_description ?? entry.title;
    if (typeof title !== 'string' || title.length > 200 || /[<>\p{Cc}]/u.test(title))
      return invalid();
    const formats = record(entry.media_formats);
    const gif = record(formats.gif);
    const preview = record(formats.preview);
    if (preview.duration !== undefined && preview.duration !== 0) return invalid();
    if (!Array.isArray(gif.dims) || gif.dims.length !== 2) return invalid();
    if (
      !Array.isArray(preview.dims) ||
      preview.dims.length !== 2 ||
      dimension(preview.dims[0]) > 1024 ||
      dimension(preview.dims[1]) > 1024
    )
      return invalid();
    if (
      preview.size !== undefined &&
      (typeof preview.size !== 'number' ||
        !Number.isSafeInteger(preview.size) ||
        preview.size < 1 ||
        preview.size > 1024 * 1024)
    )
      return invalid();
    return {
      id: entry.id,
      title: title.trim() || 'GIF',
      url: mediaUrl(gif.url),
      previewUrl: mediaUrl(preview.url),
      width: dimension(gif.dims[0]),
      height: dimension(gif.dims[1]),
    };
  });
  let nextCursor: string | null = null;
  if (typeof source.next !== 'string' && typeof source.next !== 'number') return invalid();
  if (typeof source.next === 'number' && (!Number.isFinite(source.next) || source.next < 0))
    return invalid();
  if (source.next !== undefined && source.next !== '' && source.next !== '0' && source.next !== 0) {
    const next = String(source.next);
    cursorValue('klipy:' + next);
    if (next === current || !items.length) return invalid();
    nextCursor = 'klipy:' + next;
  }
  return {
    provider: 'klipy',
    items,
    nextCursor,
    omittedCount: 0,
    attribution: { label: 'Powered by KLIPY', url: 'https://klipy.com/' },
  };
}
