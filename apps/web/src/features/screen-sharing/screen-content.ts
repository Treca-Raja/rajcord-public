export type ScreenContentKind = 'detail' | 'motion';
export type ScreenContentState = Readonly<{
  kind: ScreenContentKind;
  status: 'pending' | 'available' | 'unsupported' | 'error' | 'closed';
}>;

export class ScreenMotionDetector {
  private previous?: Uint8Array;
  private kind: ScreenContentKind = 'detail';
  private movingSince?: number;
  private stillSince?: number;
  private timestamp = -Infinity;
  sample(rgba: Uint8ClampedArray, timestamp: number): ScreenContentKind {
    if (
      !rgba.length ||
      rgba.length % 4 ||
      !Number.isFinite(timestamp) ||
      timestamp <= this.timestamp
    )
      throw new Error('Invalid screen motion sample.');
    const current = new Uint8Array(rgba.length / 4);
    let changed = 0;
    for (let pixel = 0; pixel < current.length; pixel++) {
      const offset = pixel * 4;
      current[pixel] = (rgba[offset]! * 77 + rgba[offset + 1]! * 150 + rgba[offset + 2]! * 29) >> 8;
      if (
        this.previous?.length === current.length &&
        Math.abs(current[pixel]! - this.previous[pixel]!) > 12
      )
        changed++;
    }
    const continuous =
      this.previous?.length === current.length && timestamp - this.timestamp <= 2500;
    if (!continuous) {
      this.movingSince = this.stillSince = undefined;
    } else if (changed / current.length >= 0.15) {
      this.stillSince = undefined;
      this.movingSince ??= timestamp;
      if (timestamp - this.movingSince >= 400) this.kind = 'motion';
    } else {
      this.movingSince = undefined;
      this.stillSince ??= timestamp;
      if (timestamp - this.stillSince >= 2000) this.kind = 'detail';
    }
    this.previous = current;
    this.timestamp = timestamp;
    return this.kind;
  }
}

// One 64x36 local analysis surface per consented source, independent of viewer count.
// Pixels are used only for motion classification and are never exposed or persisted.
export class ScreenContentMonitor {
  private state: ScreenContentState = Object.freeze({ kind: 'detail', status: 'pending' });
  private detector = new ScreenMotionDetector();
  private video?: HTMLVideoElement;
  private canvas?: HTMLCanvasElement;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private readonly track: MediaStreamTrack) {
    if (
      typeof document === 'undefined' ||
      typeof document.createElement !== 'function' ||
      typeof MediaStream === 'undefined'
    ) {
      this.state = Object.freeze({ kind: 'detail', status: 'unsupported' });
      return;
    }
    try {
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = new MediaStream([track]);
      this.canvas = document.createElement('canvas');
      this.canvas.width = 64;
      this.canvas.height = 36;
      if (!this.canvas.getContext('2d', { willReadFrequently: true }))
        throw new Error('Screen analysis context unavailable.');
      this.set('detail', 'pending');
      void this.video.play().then(
        () => {
          if (!this.closed) this.schedule();
        },
        () => this.fail(),
      );
    } catch {
      this.fail();
    }
  }
  inspect = () => this.state;
  private set(kind: ScreenContentKind, status: ScreenContentState['status']) {
    if (this.closed) return;
    this.state = Object.freeze({ kind, status });
    if ('contentHint' in this.track) this.track.contentHint = kind;
  }
  private schedule() {
    this.timer = setTimeout(() => {
      if (this.closed || !this.video) return;
      this.sample(performance.now());
    }, 200);
  }
  private sample(now: number) {
    if (this.closed || this.track.readyState !== 'live') return;
    try {
      if (this.video!.readyState >= 2) {
        const context = this.canvas!.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(this.video!, 0, 0, 64, 36);
        this.set(this.detector.sample(context.getImageData(0, 0, 64, 36).data, now), 'available');
      }
      this.schedule();
    } catch {
      this.fail();
    }
  }
  private release() {
    clearTimeout(this.timer);
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.video = this.canvas = undefined;
  }
  private fail() {
    if (this.closed) return;
    this.set('detail', 'error');
    this.release();
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.state = Object.freeze({ kind: this.state.kind, status: 'closed' });
    this.release();
    this.detector = new ScreenMotionDetector();
  }
}
