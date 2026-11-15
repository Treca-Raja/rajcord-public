import { safeHttpUrl, klipyMediaHosts } from '@tricord/shared';
import { messageParts } from './MessageBody';

export const gifLimits = {
  bytes: 5 * 1024 * 1024,
  width: 2048,
  height: 2048,
  frames: 300,
  // At most 64 MiB of estimated RGBA work across the entire animation.
  decodedPixels: 16 * 1024 * 1024,
  deadlineMs: 15_000,
  previews: 2,
  candidates: 2,
} as const;

const gifHosts = new Set([
  ...klipyMediaHosts,
  'media.giphy.com',
  'i.giphy.com',
  'media.tenor.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
]);

export function approvedGifUrl(value: string): string | undefined {
  const safe = safeHttpUrl(value);
  if (!safe) return;
  const url = new URL(safe);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    !gifHosts.has(url.hostname) ||
    !/\.gif$/i.test(url.pathname)
  )
    return;
  url.hash = '';
  return url.href;
}

export function gifCandidates(body: string): string[] {
  // Only bare pasted links: skip code and entire Markdown destinations, including nested brackets.
  const syntax = /```[\s\S]*?(?:```|$)|`[^`\n]*`|!?\[[^[\]\n]+\]\(/g;
  const plain: string[] = [];
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = syntax.exec(body))) {
    plain.push(body.slice(offset, match.index));
    if (match[0].endsWith('](')) {
      let depth = 1;
      while (syntax.lastIndex < body.length && body[syntax.lastIndex] !== '\n' && depth) {
        const character = body[syntax.lastIndex++]!;
        if (character === '(') depth++;
        if (character === ')') depth--;
      }
    }
    offset = syntax.lastIndex;
  }
  plain.push(body.slice(offset));
  const candidates = new Set<string>();
  for (const text of plain) {
    for (const part of messageParts(text)) {
      const url = part.href && approvedGifUrl(part.href);
      if (url) candidates.add(url);
      if (candidates.size === gifLimits.candidates) return [...candidates];
    }
  }
  return [...candidates];
}

export type GifFailure =
  | 'consent'
  | 'url'
  | 'unsupported'
  | 'capacity'
  | 'transport'
  | 'bytes'
  | 'invalid'
  | 'dimensions'
  | 'frames'
  | 'pixels'
  | 'deadline'
  | 'decode'
  | 'stopped';

const explanations: Record<GifFailure, string> = {
  consent: 'Choose Load GIF before contacting the media provider. The text link still works.',
  url: 'Only direct HTTPS .gif links on the approved GIPHY, KLIPY and Tenor CDNs can be previewed.',
  unsupported: 'This browser has no supported native GIF decoder. Use the text link instead.',
  capacity: 'Two GIF previews are already loaded. Stop/unload one before loading another.',
  transport:
    'The provider could not be contacted safely (network, CORS, or redirect restrictions). Use the text link instead.',
  bytes: 'This GIF exceeds the 5 MiB download limit. Use the text link instead.',
  invalid: 'The response is not a valid GIF. Use the text link instead.',
  dimensions: 'This GIF exceeds the 2048 × 2048 dimension limit. Use the text link instead.',
  frames: 'This GIF exceeds the 300-frame limit. Use the text link instead.',
  pixels:
    'This GIF exceeds the 16,777,216 cumulative decoded-pixel safety limit. Use the text link instead.',
  deadline: 'Loading or decoding took longer than 15 seconds. Use the text link or retry.',
  decode: 'The native decoder could not safely decode this GIF. Use the text link instead.',
  stopped: 'GIF preview unloaded. The text link still works.',
};

export class GifPreviewError extends Error {
  constructor(public readonly code: GifFailure) {
    super(explanations[code]);
    this.name = 'GifPreviewError';
  }
}

export interface GifFrame {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly duration: number | null;
  close(): void;
}

export interface GifDecoder {
  readonly tracks: {
    readonly ready: Promise<unknown>;
    readonly selectedTrack: { readonly frameCount: number } | null;
  };
  decode(options: { frameIndex: number; completeFramesOnly: true }): Promise<{ image: GifFrame }>;
  close(): void;
}

export interface GifDecoderConstructor {
  new (options: { data: Uint8Array; type: 'image/gif'; preferAnimation: true }): GifDecoder;
  isTypeSupported(type: string): Promise<boolean>;
}

function isGifDecoderConstructor(value: unknown): value is GifDecoderConstructor {
  if (
    typeof value !== 'function' ||
    !('isTypeSupported' in value) ||
    typeof value.isTypeSupported !== 'function' ||
    !('prototype' in value)
  )
    return false;
  const prototype: unknown = value.prototype;
  return (
    prototype !== null &&
    typeof prototype === 'object' &&
    'decode' in prototype &&
    typeof prototype.decode === 'function' &&
    'close' in prototype &&
    typeof prototype.close === 'function'
  );
}

export function nativeGifDecoder(scope: object = globalThis): GifDecoderConstructor | undefined {
  if (!('ImageDecoder' in scope)) return;
  const candidate: unknown = scope.ImageDecoder;
  if (isGifDecoderConstructor(candidate)) return candidate;
}

export interface GifPreviewBudget {
  readonly active: number;
  acquire(): (() => void) | undefined;
}

export function createGifPreviewBudget(): GifPreviewBudget {
  let active = 0;
  return {
    get active() {
      return active;
    },
    acquire() {
      if (active >= gifLimits.previews) return;
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
      };
    },
  };
}

export const clientGifBudget = createGifPreviewBudget();

export function validateGifMetadata(width: number, height: number, frames: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new GifPreviewError('invalid');
  if (width > gifLimits.width || height > gifLimits.height) throw new GifPreviewError('dimensions');
  if (!Number.isSafeInteger(frames) || frames < 1) throw new GifPreviewError('invalid');
  if (frames > gifLimits.frames) throw new GifPreviewError('frames');
  if (width * height * frames > gifLimits.decodedPixels) throw new GifPreviewError('pixels');
}

function inspectGif(bytes: Uint8Array): { width: number; height: number; frames: number } {
  if (
    bytes.length < 13 ||
    !['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))
  )
    throw new GifPreviewError('invalid');
  const word = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
  const width = word(6);
  const height = word(8);
  validateGifMetadata(width, height, 1);
  let offset = 13;
  let frames = 0;
  const skip = (count: number) => {
    if (offset + count > bytes.length) throw new GifPreviewError('invalid');
    offset += count;
  };
  const colorTable = (packed: number) => {
    if (packed & 0x80) skip(3 * 2 ** ((packed & 7) + 1));
  };
  const subBlocks = () => {
    while (true) {
      if (offset >= bytes.length) throw new GifPreviewError('invalid');
      const size = bytes[offset++]!;
      if (!size) return;
      skip(size);
    }
  };
  colorTable(bytes[10]!);
  while (offset < bytes.length) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) {
      if (!frames || offset !== bytes.length) throw new GifPreviewError('invalid');
      return { width, height, frames };
    }
    if (marker === 0x21) {
      skip(1);
      subBlocks();
    } else if (marker === 0x2c) {
      const descriptor = offset;
      skip(9);
      const frameWidth = word(descriptor + 4);
      const frameHeight = word(descriptor + 6);
      validateGifMetadata(frameWidth, frameHeight, 1);
      if (word(descriptor) + frameWidth > width || word(descriptor + 2) + frameHeight > height)
        throw new GifPreviewError('invalid');
      // Check every descriptor before native decoding, not just the logical screen header.
      validateGifMetadata(width, height, ++frames);
      colorTable(bytes[descriptor + 8]!);
      skip(1);
      subBlocks();
    } else throw new GifPreviewError('invalid');
  }
  throw new GifPreviewError('invalid');
}

function abortReason(signal: AbortSignal): GifPreviewError {
  return signal.reason instanceof GifPreviewError ? signal.reason : new GifPreviewError('stopped');
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLate?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let aborted = signal.aborted;
    const abort = () => {
      aborted = true;
      reject(abortReason(signal));
    };
    if (aborted) reject(abortReason(signal));
    else signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (aborted) disposeLate?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function downloadGif(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (
    !response.ok ||
    response.redirected ||
    response.type === 'opaque' ||
    response.type === 'opaqueredirect'
  )
    throw new GifPreviewError('transport');
  if (Number(response.headers.get('content-length')) > gifLimits.bytes)
    throw new GifPreviewError('bytes');
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'image/gif')
    throw new GifPreviewError('invalid');
  if (!response.body) throw new GifPreviewError('invalid');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) {
        complete = true;
        break;
      }
      total += result.value.byteLength;
      if (total > gifLimits.bytes) throw new GifPreviewError('bytes');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export interface GifMetadata {
  width: number;
  height: number;
  frames: number;
  delayMs: number;
}

export interface GifPreviewDependencies {
  fetch: typeof fetch;
  decoder: GifDecoderConstructor | undefined;
  budget: GifPreviewBudget;
}

type PaintGifFrame = (frame: GifFrame) => void;

export class GifPreviewSession {
  private readonly controller = new AbortController();
  private release: (() => void) | undefined;
  private decoder: GifDecoder | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private metadata: GifMetadata | undefined;
  private disposed = false;
  private started = false;
  private loaded = false;
  private decoding = false;

  constructor(
    private readonly url: string,
    private readonly dependencies: GifPreviewDependencies = {
      fetch: (...args) => globalThis.fetch(...args),
      decoder: nativeGifDecoder(),
      budget: clientGifBudget,
    },
  ) {}

  async load(consent: boolean, paint: PaintGifFrame): Promise<GifMetadata> {
    if (!consent) throw new GifPreviewError('consent');
    const url = approvedGifUrl(this.url);
    if (!url) throw new GifPreviewError('url');
    if (!this.dependencies.decoder) throw new GifPreviewError('unsupported');
    if (this.started || this.disposed) throw new GifPreviewError('stopped');
    this.release = this.dependencies.budget.acquire();
    if (!this.release) throw new GifPreviewError('capacity');
    this.started = true;
    this.startDeadline();
    let failure: GifFailure = 'decode';
    try {
      if (
        !(await abortable(
          this.dependencies.decoder.isTypeSupported('image/gif'),
          this.controller.signal,
        ))
      )
        throw new GifPreviewError('unsupported');
      failure = 'transport';
      const response = await abortable(
        this.dependencies.fetch(url, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
          cache: 'no-store',
          signal: this.controller.signal,
        }),
        this.controller.signal,
        cancelBody,
      );
      let bytes: Uint8Array;
      try {
        bytes = await downloadGif(response, this.controller.signal);
      } finally {
        if (!response.body?.locked) cancelBody(response);
      }
      failure = 'invalid';
      const inspected = inspectGif(bytes);
      const { width, height } = inspected;
      failure = 'decode';
      this.decoder = new this.dependencies.decoder({
        data: bytes,
        type: 'image/gif',
        preferAnimation: true,
      });
      await abortable(this.decoder.tracks.ready, this.controller.signal);
      const frames = this.decoder.tracks.selectedTrack?.frameCount ?? 0;
      validateGifMetadata(width, height, frames);
      if (frames !== inspected.frames) throw new GifPreviewError('decode');
      this.metadata = { width, height, frames, delayMs: 100 };
      this.metadata.delayMs = await this.paintFrame(0, paint);
      this.loaded = true;
      return { ...this.metadata };
    } catch (error) {
      const failureError = this.controller.signal.aborted
        ? abortReason(this.controller.signal)
        : error instanceof GifPreviewError
          ? error
          : new GifPreviewError(failure);
      this.dispose();
      throw failureError;
    } finally {
      clearTimeout(this.deadline);
    }
  }

  async frame(index: number, paint: PaintGifFrame): Promise<number> {
    if (this.disposed || !this.loaded || !this.metadata) throw new GifPreviewError('stopped');
    if (this.decoding) throw new GifPreviewError('decode');
    this.startDeadline();
    try {
      return await this.paintFrame(index, paint);
    } catch (error) {
      const failure = this.controller.signal.aborted
        ? abortReason(this.controller.signal)
        : error instanceof GifPreviewError
          ? error
          : new GifPreviewError('decode');
      this.dispose();
      throw failure;
    } finally {
      clearTimeout(this.deadline);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.deadline);
    this.controller.abort(new GifPreviewError('stopped'));
    try {
      this.decoder?.close();
    } finally {
      this.decoder = undefined;
      this.metadata = undefined;
      this.loaded = false;
      this.release?.();
      this.release = undefined;
    }
  }

  private startDeadline(): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      this.controller.abort(new GifPreviewError('deadline'));
    }, gifLimits.deadlineMs);
  }

  private async paintFrame(index: number, paint: PaintGifFrame): Promise<number> {
    if (
      !this.decoder ||
      !this.metadata ||
      this.decoding ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.metadata.frames
    )
      throw new GifPreviewError('decode');
    this.decoding = true;
    try {
      const { image } = await abortable(
        this.decoder.decode({ frameIndex: index, completeFramesOnly: true }),
        this.controller.signal,
        (late) => late.image.close(),
      );
      try {
        if (this.controller.signal.aborted) throw abortReason(this.controller.signal);
        validateGifMetadata(image.displayWidth, image.displayHeight, this.metadata.frames);
        if (
          image.displayWidth !== this.metadata.width ||
          image.displayHeight !== this.metadata.height
        )
          throw new GifPreviewError('decode');
        paint(image);
        const duration = image.duration;
        return duration !== null && Number.isFinite(duration) ? Math.max(20, duration / 1000) : 100;
      } finally {
        image.close();
      }
    } finally {
      this.decoding = false;
    }
  }
}
