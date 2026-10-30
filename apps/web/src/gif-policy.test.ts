import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvedGifUrl,
  createGifPreviewBudget,
  gifCandidates,
  gifLimits,
  GifPreviewSession,
  nativeGifDecoder,
  validateGifMetadata,
  type GifDecoder,
  type GifDecoderConstructor,
  type GifFrame,
  type GifPreviewDependencies,
} from './gif-policy';

const url = 'https://media.giphy.com/media/example/giphy.gif';
it('accepts only the documented KLIPY media hosts and preserves delivery parameters', () => {
  for (const host of ['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com']) {
    const link = `https://${host}/ii/fixture/animation.gif?delivery=a%2Fb`;
    expect(approvedGifUrl(link)).toBe(link);
    expect(gifCandidates(link)).toEqual([link]);
  }
  expect(approvedGifUrl('https://static.klipy.com.evil.invalid/animation.gif')).toBeUndefined();
  expect(approvedGifUrl('https://api.klipy.com/animation.gif')).toBeUndefined();
});

function gifBytes(width = 16, height = 16, frames = 3): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    ...new TextEncoder().encode('GIF89a'),
    width & 255,
    width >> 8,
    height & 255,
    height >> 8,
    0,
    0,
    0,
    ...Array.from({ length: frames }, () => [
      0x2c,
      0,
      0,
      0,
      0,
      width & 255,
      width >> 8,
      height & 255,
      height >> 8,
      0,
      2,
      1,
      0,
      0,
    ]).flat(),
    0x3b,
  ]);
}

function gifResponse(bytes = gifBytes(), headers: HeadersInit = {}): Response {
  return new Response(bytes, { headers: { 'content-type': 'image/gif', ...headers } });
}

function fixture(
  options: {
    width?: number;
    height?: number;
    frames?: number;
    response?: () => Response;
    decode?: (index: number) => Promise<{ image: GifFrame }>;
  } = {},
) {
  const width = options.width ?? 16;
  const height = options.height ?? 16;
  const images: GifFrame[] = [];
  const closes: ReturnType<typeof vi.fn>[] = [];
  let liveFrames = 0;
  let peakFrames = 0;
  const makeFrame = () => {
    liveFrames++;
    peakFrames = Math.max(peakFrames, liveFrames);
    const close = vi.fn(() => {
      liveFrames--;
    });
    const image: GifFrame = {
      displayWidth: width,
      displayHeight: height,
      duration: 40_000,
      close,
    };
    images.push(image);
    closes.push(close);
    return { image };
  };
  const decode = vi.fn((index: number) =>
    options.decode ? options.decode(index) : Promise.resolve(makeFrame()),
  );
  const closeDecoder = vi.fn();
  class Decoder implements GifDecoder {
    static isTypeSupported = vi.fn(async () => true);
    readonly tracks = {
      ready: Promise.resolve(),
      selectedTrack: { frameCount: options.frames ?? 3 },
    };
    decode({ frameIndex }: { frameIndex: number; completeFramesOnly: true }) {
      return decode(frameIndex);
    }
    close() {
      closeDecoder();
    }
  }
  const fetcher = vi.fn<typeof fetch>(async () =>
    options.response
      ? options.response()
      : gifResponse(gifBytes(width, height, options.frames ?? 3)),
  );
  const budget = createGifPreviewBudget();
  const dependencies: GifPreviewDependencies = { fetch: fetcher, decoder: Decoder, budget };
  return {
    dependencies,
    fetcher,
    budget,
    Decoder,
    decode,
    closeDecoder,
    images,
    closes,
    makeFrame,
    get peakFrames() {
      return peakFrames;
    },
    get liveFrames() {
      return liveFrames;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pasted GIF policy', () => {
  it.each([
    url,
    'https://i.giphy.com/example.gif',
    'https://media.tenor.com/example/tenor.gif',
    'HTTPS://MEDIA.GIPHY.COM/example.GIF',
  ])('allows only direct approved CDN links: %s', (value) => {
    expect(approvedGifUrl(value)).toBe(new URL(value).href);
  });

  it.each([
    'http://media.giphy.com/example.gif',
    'https://giphy.com/example.gif',
    'https://tenor.com/example.gif',
    'https://media5.giphy.com/example.gif',
    'https://media.giphy.com.evil.example/example.gif',
    'https://evilmedia.giphy.com/example.gif',
    'https://media.giphy.com:8443/example.gif',
    'https://name:password@media.giphy.com/example.gif',
    'https://media.giphy.com@evil.example/example.gif',
    'https://media.giphy.com./example.gif',
    'https://media.giphy.com/example.webp',
    'https://media.giphy.com/example.gif/extra',
    'https://media.giphy.com/example%2egif',
    'https://media.giphy.com/example.gif\\other',
    'https://media.giphy.com/example.gif\n',
    'data:image/gif;base64,abc',
    'javascript:alert(1)',
    '//media.giphy.com/example.gif',
  ])('rejects unapproved or ambiguous sources: %s', (value) => {
    expect(approvedGifUrl(value)).toBeUndefined();
  });

  it('deduplicates direct links, trims punctuation and caps message candidates at two', () => {
    const other = 'https://media.tenor.com/other.gif';
    const body = `(${url}). ${url}#first ${url}#second ${other}! https://i.giphy.com/third.gif`;
    expect(gifCandidates(body)).toEqual([url, other]);
    expect(
      gifCandidates(Array.from({ length: 100 }, (_, i) => `${url}?n=${i}`).join(' ')),
    ).toHaveLength(2);
  });

  it('does not turn code, Markdown images or labeled links into embeds', () => {
    for (const body of [
      `\`${url}\``,
      `\`\`\`\n${url}\n\`\`\``,
      `\`\`\`\n${url}`,
      `![image](${url})`,
      `![image](${url}?q=(nested(value)))`,
      `[link](${url})`,
      `[${url}](${url})`,
      `[incomplete](${url}`,
      `word${url}`,
      `javascript:${url}`,
    ])
      expect(gifCandidates(body)).toEqual([]);
    expect(gifCandidates(`![image](${url})\n${url}`)).toEqual([url]);
    expect(gifCandidates(`[incomplete](${url}\n${url}`)).toEqual([url]);
  });

  it('allows only exact provider API/media origins for explicit search and previews', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const content = html.match(/content="(default-src[^"]+)"/)?.[1];
    expect(content).toBeDefined();
    const connect = content
      ?.split(';')
      .find((directive) => directive.trim().startsWith('connect-src'));
    expect(connect?.match(/https:\/\/\S+/g)).toEqual([
      'https://api.giphy.com',
      'https://api.klipy.com',
      'https://static.klipy.com',
      'https://static1.klipy.com',
      'https://static2.klipy.com',
      'https://media.giphy.com',
      'https://i.giphy.com',
      'https://media.tenor.com',
      'https://media0.giphy.com',
      'https://media1.giphy.com',
      'https://media2.giphy.com',
      'https://media3.giphy.com',
      'https://media4.giphy.com',
    ]);
    expect(content).not.toMatch(/(?:\shttps:;|\shttps:\s|\*)/);
    expect(content).toContain("img-src 'self' data:");
    expect(content).not.toContain('api.tenor.com');
    expect(content).not.toContain('tenor.googleapis.com');
  });
});

describe('native decoder and safety limits', () => {
  it('guards missing and incomplete native decoder implementations', () => {
    expect(nativeGifDecoder({})).toBeUndefined();
    expect(nativeGifDecoder({ ImageDecoder: {} })).toBeUndefined();
    expect(nativeGifDecoder({ ImageDecoder: class {} })).toBeUndefined();
    const f = fixture();
    expect(nativeGifDecoder({ ImageDecoder: f.Decoder })).toBe(f.Decoder);
  });

  it('enforces dimensions, frame count and a conservative cumulative pixel limit', () => {
    expect(() => validateGifMetadata(2048, 2048, 4)).not.toThrow();
    expect(() => validateGifMetadata(16, 16, 300)).not.toThrow();
    expect(() => validateGifMetadata(2049, 1, 1)).toThrow('dimension limit');
    expect(() => validateGifMetadata(1, 2049, 1)).toThrow('dimension limit');
    expect(() => validateGifMetadata(1, 1, 301)).toThrow('300-frame limit');
    expect(() => validateGifMetadata(2048, 2048, 5)).toThrow('cumulative decoded-pixel');
    for (const values of [
      [0, 1, 1],
      [1, -1, 1],
      [1.5, 1, 1],
      [1, 1, 0],
      [1, 1, Infinity],
      [NaN, 1, 1],
    ])
      expect(() => validateGifMetadata(values[0]!, values[1]!, values[2]!)).toThrow('valid GIF');
  });

  it('constructing, denied consent and unsupported decoding never fetch', async () => {
    const f = fixture();
    const session = new GifPreviewSession(url, f.dependencies);
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(session.load(false, vi.fn())).rejects.toMatchObject({ code: 'consent' });
    expect(f.budget.active).toBe(0);
    await expect(
      new GifPreviewSession(url, { ...f.dependencies, decoder: undefined }).load(true, vi.fn()),
    ).rejects.toMatchObject({ code: 'unsupported' });
    f.Decoder.isTypeSupported.mockResolvedValue(false);
    await expect(session.load(true, vi.fn())).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.budget.active).toBe(0);
  });

  it('rejects unsafe URLs before decoder or network activity', async () => {
    const f = fixture();
    await expect(
      new GifPreviewSession('https://unapproved.example/a.gif', f.dependencies).load(true, vi.fn()),
    ).rejects.toMatchObject({ code: 'url' });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.Decoder.isTypeSupported).not.toHaveBeenCalled();
  });

  it('fetches only after consent with explicit privacy and redirect restrictions', async () => {
    const f = fixture();
    const session = new GifPreviewSession(url, f.dependencies);
    const paint = vi.fn();
    expect(await session.load(true, paint)).toEqual({
      width: 16,
      height: 16,
      frames: 3,
      delayMs: 40,
    });
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
    expect(paint).toHaveBeenCalledTimes(1);
    expect(f.closes[0]).toHaveBeenCalledTimes(1);
    expect(f.budget.active).toBe(1);
    session.dispose();
    expect(f.closeDecoder).toHaveBeenCalledTimes(1);
    expect(f.budget.active).toBe(0);
  });

  it('retains no decoded frames and closes each frame even when drawing fails', async () => {
    const f = fixture();
    const session = new GifPreviewSession(url, f.dependencies);
    await session.load(true, vi.fn());
    for (let index = 0; index < 12; index++) await session.frame(index % 3, vi.fn());
    expect(f.liveFrames).toBe(0);
    expect(f.peakFrames).toBe(1);
    expect(f.closes.every((close) => close.mock.calls.length === 1)).toBe(true);
    await expect(
      session.frame(0, () => {
        throw new Error('canvas unavailable');
      }),
    ).rejects.toMatchObject({
      code: 'decode',
    });
    expect(f.liveFrames).toBe(0);
    expect(f.closeDecoder).toHaveBeenCalledTimes(1);
    expect(f.budget.active).toBe(0);
  });

  it('preflights a real GIF including its palette, extension and compressed image blocks', async () => {
    const bytes = new Uint8Array(
      Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
    );
    const f = fixture({ width: 1, height: 1, frames: 1, response: () => gifResponse(bytes) });
    const session = new GifPreviewSession(url, f.dependencies);
    await expect(session.load(true, vi.fn())).resolves.toMatchObject({
      width: 1,
      height: 1,
      frames: 1,
    });
    session.dispose();
  });

  it('checks individual frame descriptors before giving bytes to the native decoder', async () => {
    const bytes = gifBytes(16, 16, 1);
    bytes[18] = 1;
    bytes[19] = 8;
    const f = fixture({ response: () => gifResponse(bytes) });
    await expect(
      new GifPreviewSession(url, f.dependencies).load(true, vi.fn()),
    ).rejects.toMatchObject({
      code: 'dimensions',
    });
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.closeDecoder).not.toHaveBeenCalled();
    expect(f.budget.active).toBe(0);
  });

  it('rejects truncated GIF structure before native decoding', async () => {
    const f = fixture({ response: () => gifResponse(gifBytes().slice(0, -1)) });
    await expect(
      new GifPreviewSession(url, f.dependencies).load(true, vi.fn()),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.budget.active).toBe(0);
  });

  it.each([
    { width: 2049, height: 1, frames: 1, code: 'dimensions', decodes: 0 },
    { width: 1, height: 2049, frames: 1, code: 'dimensions', decodes: 0 },
    { width: 16, height: 16, frames: 301, code: 'frames', decodes: 0 },
    { width: 2048, height: 2048, frames: 5, code: 'pixels', decodes: 0 },
  ])('rejects unsafe metadata before any frame decode: $code', async (options) => {
    const f = fixture(options);
    await expect(
      new GifPreviewSession(url, f.dependencies).load(true, vi.fn()),
    ).rejects.toMatchObject({
      code: options.code,
    });
    expect(f.decode).toHaveBeenCalledTimes(options.decodes);
    expect(f.budget.active).toBe(0);
  });
});

describe('client budget, cancellation and safe transport fallback', () => {
  it('reserves at most two loading/loaded previews and releases slots idempotently', async () => {
    const f = fixture();
    const sessions = Array.from({ length: 3 }, () => new GifPreviewSession(url, f.dependencies));
    const first = sessions[0]!;
    const second = sessions[1]!;
    const third = sessions[2]!;
    const pending = [first.load(true, vi.fn()), second.load(true, vi.fn())];
    expect(f.budget.active).toBe(2);
    await expect(third.load(true, vi.fn())).rejects.toMatchObject({ code: 'capacity' });
    await Promise.all(pending);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    first.dispose();
    first.dispose();
    expect(f.budget.active).toBe(1);
    await third.load(true, vi.fn());
    expect(f.budget.active).toBe(2);
    second.dispose();
    third.dispose();
    expect(f.budget.active).toBe(0);
  });

  it('falls back explicitly on network/CORS/redirect failure and releases the budget', async () => {
    const f = fixture();
    f.fetcher.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      new GifPreviewSession(url, f.dependencies).load(true, vi.fn()),
    ).rejects.toMatchObject({
      code: 'transport',
      message: expect.stringContaining('CORS'),
    });
    expect(f.budget.active).toBe(0);
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { response: () => new Response(null, { status: 403 }), code: 'transport' },
    { response: () => gifResponse(gifBytes(), { 'content-type': 'text/html' }), code: 'invalid' },
    { response: () => gifResponse(new Uint8Array([1, 2, 3])), code: 'invalid' },
    {
      response: () => gifResponse(gifBytes(), { 'content-length': String(gifLimits.bytes + 1) }),
      code: 'bytes',
    },
    { response: () => gifResponse(new Uint8Array(gifLimits.bytes + 1)), code: 'bytes' },
  ])('rejects unusable transport/body without decoding: $code', async (options) => {
    const f = fixture(options);
    await expect(
      new GifPreviewSession(url, f.dependencies).load(true, vi.fn()),
    ).rejects.toMatchObject({
      code: options.code,
    });
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.budget.active).toBe(0);
  });

  it('bounds streamed bytes even without Content-Length and cancels the stream', async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    const f = fixture({
      response: () => new Response(stream, { headers: { 'content-type': 'image/gif' } }),
    });
    await expect(
      new GifPreviewSession(url, f.dependencies).load(true, vi.fn()),
    ).rejects.toMatchObject({ code: 'bytes' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pulls).toBeLessThanOrEqual(7);
    expect(stream.locked).toBe(false);
    expect(f.budget.active).toBe(0);
  });

  it('unload/revocation aborts in-progress download, cancels and unlocks its stream', async () => {
    const cancel = vi.fn();
    let began: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        began?.();
      },
      cancel,
    });
    const f = fixture({
      response: () => new Response(stream, { headers: { 'content-type': 'image/gif' } }),
    });
    const session = new GifPreviewSession(url, f.dependencies);
    const loading = session.load(true, vi.fn());
    await started;
    session.dispose();
    await expect(loading).rejects.toMatchObject({ code: 'stopped' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(f.budget.active).toBe(0);
    expect(f.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('closes late decoded frames on stop without drawing or keeping their budget', async () => {
    let resolve: ((result: { image: GifFrame }) => void) | undefined;
    const pending = new Promise<{ image: GifFrame }>((done) => {
      resolve = done;
    });
    const f = fixture({ decode: () => pending });
    const session = new GifPreviewSession(url, f.dependencies);
    const paint = vi.fn();
    const loading = session.load(true, paint);
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce());
    session.dispose();
    await expect(loading).rejects.toMatchObject({ code: 'stopped' });
    const frame = f.makeFrame();
    resolve?.(frame);
    await Promise.resolve();
    expect(frame.image.close).toHaveBeenCalledOnce();
    expect(paint).not.toHaveBeenCalled();
    expect(f.budget.active).toBe(0);
    expect(f.closeDecoder).toHaveBeenCalledOnce();
  });

  it('enforces one total 15-second deadline across request and initial decode', async () => {
    vi.useFakeTimers();
    const f = fixture({ decode: () => new Promise(() => undefined) });
    f.fetcher.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(gifResponse()), 10_000);
        }),
    );
    const session = new GifPreviewSession(url, f.dependencies);
    const loading = session.load(true, vi.fn());
    const rejected = expect(loading).rejects.toMatchObject({ code: 'deadline' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.decode).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.budget.active).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(f.budget.active).toBe(0);
    expect(f.closeDecoder).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a hung download and cancels its stream', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const f = fixture({
      response: () => new Response(stream, { headers: { 'content-type': 'image/gif' } }),
    });
    const loading = new GifPreviewSession(url, f.dependencies).load(true, vi.fn());
    const rejected = expect(loading).rejects.toMatchObject({ code: 'deadline' });
    await vi.advanceTimersByTimeAsync(gifLimits.deadlineMs);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(f.budget.active).toBe(0);
  });

  it('cleans up a decoder rejection and rejects future frames after disposal', async () => {
    const f = fixture({
      decode: async () => {
        throw new Error('invalid GIF frame');
      },
    });
    const session = new GifPreviewSession(url, f.dependencies);
    await expect(session.load(true, vi.fn())).rejects.toMatchObject({ code: 'decode' });
    await expect(session.frame(0, vi.fn())).rejects.toMatchObject({ code: 'stopped' });
    expect(f.closeDecoder).toHaveBeenCalledOnce();
    expect(f.budget.active).toBe(0);
  });

  it('releases late fetch responses after unload without starting a decoder', async () => {
    let resolve: ((response: Response) => void) | undefined;
    const f = fixture();
    f.fetcher.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const session = new GifPreviewSession(url, f.dependencies);
    const loading = session.load(true, vi.fn());
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    session.dispose();
    await expect(loading).rejects.toMatchObject({ code: 'stopped' });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    resolve?.(response);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.budget.active).toBe(0);
  });

  it('serializes frame decoding without leaking deadline timers on concurrent calls', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const session = new GifPreviewSession(url, f.dependencies);
    await session.load(true, vi.fn());
    let resolve: ((result: { image: GifFrame }) => void) | undefined;
    f.decode.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const rendering = session.frame(1, vi.fn());
    await expect(session.frame(2, vi.fn())).rejects.toMatchObject({ code: 'decode' });
    expect(f.decode).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    resolve?.(f.makeFrame());
    await rendering;
    session.dispose();
    expect(f.liveFrames).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.budget.active).toBe(0);
  });

  it('recognizes the structural native constructor without requiring DOM type declarations', () => {
    const decoder: GifDecoderConstructor = fixture().Decoder;
    expect(typeof decoder.isTypeSupported).toBe('function');
  });
});
