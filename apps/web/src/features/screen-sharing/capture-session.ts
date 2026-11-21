import { runInBackground } from '../../shared/background';
import type { ScreenPublishGrant, ScreenQuality, ScreenSound } from '@tricord/shared';
import { WebScreenCapture, type LocalScreenCapture } from './screen-capture';
import { adoptScreenRenewal, type ScreenRenewalPermit } from './screen-renewal';
import { ScreenContentMonitor } from './screen-content';
import { screenCodecSelection, type ScreenCodecSelection } from './screen-codec';

export class ScreenLifetime {
  readonly generation = Object.freeze({});
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private active = true;
  private revision = 0;
  constructor(
    private deadline: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(deadline) || deadline <= now())
      throw new Error('Screen authority expired.');
    this.schedule();
  }
  inspect = () => {
    if (this.active && this.deadline <= this.now()) this.stop();
    return this.active
      ? Object.freeze({ generation: this.generation, deadline: this.deadline })
      : null;
  };
  onInvalidated = (listener: () => void) => {
    if (this.active) this.listeners.add(listener);
    else listener();
    return () => {
      this.listeners.delete(listener);
    };
  };
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        if (this.inspect()) this.schedule();
      },
      Math.max(1, this.deadline - this.now()),
    );
  }
  renew(permit: ScreenRenewalPermit) {
    if (!this.inspect()) throw new Error('Screen lifetime ended.');
    adoptScreenRenewal(permit, this.generation, this.deadline, this.revision, this.now());
    this.deadline = permit.deadline;
    this.revision = permit.revision;
    this.schedule();
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    const listeners = [...this.listeners];
    this.listeners.clear();
    listeners.forEach((listener) => listener());
  }
}

export class CaptureSession {
  private capture?: LocalScreenCapture;
  private contentMonitor?: ScreenContentMonitor;
  private codecWork?: Promise<ScreenCodecSelection>;
  private codecInput?: {
    quality: ScreenQuality;
    width?: number;
    height?: number;
    frameRate?: number;
  };
  private codecState: ScreenCodecSelection = Object.freeze({
    preferred: null,
    status: 'unavailable',
  });
  private readonly abort = new AbortController();
  private life: ScreenLifetime;
  private closed = false;
  private published = false;
  readonly previewKey = Object.freeze({});
  constructor(
    private readonly options: {
      adapter: WebScreenCapture;
      deadline: number;
      sound: ScreenSound;
      quality: ScreenQuality;
      onEnded(): void;
    },
  ) {
    this.life = new ScreenLifetime(options.deadline);
    this.watch(this.life);
  }
  private watch(life: ScreenLifetime) {
    life.onInvalidated(() => {
      if (this.life === life) this.stop();
    });
  }
  choose(): Promise<void> {
    if (this.closed || this.capture) return Promise.reject(new Error('Screen source ended.'));
    // This call must remain on the Choose source gesture stack.
    const raw = this.options.adapter.start({
      sound: this.options.sound,
      signal: this.abort.signal,
      resolution: this.options.quality.resolution,
      frameRate: this.options.quality.frameRate,
    });
    return raw.then((capture) => {
      if (this.closed || !this.life.inspect()) {
        capture.dispose();
        throw new Error('Screen source ended.');
      }
      this.capture = capture;
      this.contentMonitor = new ScreenContentMonitor(capture.video);
      this.qualifyCodec(this.options.quality);
      runInBackground(capture.ended.then(() => this.stop()));
    });
  }
  private qualifyCodec(quality: ScreenQuality) {
    const { width, height, frameRate } = this.borrow().video.getSettings();
    const prior = this.codecInput;
    if (
      prior &&
      prior.quality === quality &&
      prior.width === width &&
      prior.height === height &&
      prior.frameRate === frameRate
    )
      return;
    this.codecInput = { quality, width, height, frameRate };
    const work = screenCodecSelection(
      quality,
      { width, height, frameRate },
      this.abort.signal,
    ).then((selection) => {
      if (!this.closed && this.codecWork === work) this.codecState = selection;
      return selection;
    });
    this.codecWork = work;
  }
  borrow() {
    if (
      this.closed ||
      !this.life.inspect() ||
      !this.capture ||
      this.capture.video.readyState !== 'live' ||
      (this.capture.audio && this.capture.audio.readyState !== 'live')
    )
      throw new Error('Screen source ended.');
    return this.capture;
  }
  content() {
    return (
      this.contentMonitor?.inspect() ??
      Object.freeze({ kind: 'detail' as const, status: 'pending' as const })
    );
  }
  codec() {
    return this.codecState;
  }
  async codecPreference() {
    if (this.closed) return null;
    if (this.codecInput) this.qualifyCodec(this.codecInput.quality);
    return this.codecWork ? (await this.codecWork).preferred : null;
  }
  lifecycle() {
    this.borrow();
    return this.life;
  }
  commitPublication(
    key: object,
    grant: ScreenPublishGrant,
    deadline: number,
    sourceGeneration: number,
    quality: ScreenQuality = this.options.quality,
  ) {
    this.borrow();
    if (
      this.published ||
      key !== this.previewKey ||
      grant.share.sourceGeneration !== sourceGeneration ||
      grant.share.sound !== this.options.sound ||
      deadline <= Date.now() ||
      grant.share.profile !== quality.profile ||
      grant.share.videoBitrate !== quality.videoBitrate ||
      grant.share.resolution !== quality.resolution ||
      grant.share.frameRate !== quality.frameRate
    )
      throw new Error('Screen publication changed.');
    if (
      quality.profile !== this.options.quality.profile ||
      quality.resolution !== this.options.quality.resolution ||
      quality.frameRate !== this.options.quality.frameRate ||
      quality.videoBitrate !== this.options.quality.videoBitrate
    )
      this.qualifyCodec(quality);
    const previous = this.life,
      publication = new ScreenLifetime(deadline);
    this.life = publication;
    this.published = true;
    this.watch(publication);
    previous.stop();
  }
  stopPreview(key: object) {
    if (!this.published && key === this.previewKey) this.stop();
  }
  stop() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.abort.abort();
      this.contentMonitor?.dispose();
      this.capture?.dispose();
    } finally {
      try {
        this.life.stop();
      } finally {
        this.options.onEnded();
      }
    }
  }
}
