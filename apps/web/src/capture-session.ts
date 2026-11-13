import type { ScreenPublishGrant, ScreenQuality, ScreenSound } from '@tricord/shared';
import { WebScreenCapture, type LocalScreenCapture } from './screen-capture';
import { adoptScreenRenewal, type ScreenRenewalPermit } from './screen-renewal';

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
      void capture.ended.then(() => this.stop());
    });
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
  lifecycle() {
    this.borrow();
    return this.life;
  }
  commitPublication(
    key: object,
    grant: ScreenPublishGrant,
    deadline: number,
    sourceGeneration: number,
  ) {
    this.borrow();
    if (
      this.published ||
      key !== this.previewKey ||
      grant.share.sourceGeneration !== sourceGeneration ||
      grant.share.sound !== this.options.sound ||
      deadline <= Date.now() ||
      grant.share.profile !== this.options.quality.profile ||
      grant.share.videoBitrate !== this.options.quality.videoBitrate ||
      grant.share.resolution !== this.options.quality.resolution ||
      grant.share.frameRate !== this.options.quality.frameRate
    )
      throw new Error('Screen publication changed.');
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
