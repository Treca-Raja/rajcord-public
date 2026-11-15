import {
  ScreenCaptureError,
  type CaptureEnd,
  type CaptureErrorCode,
  type CaptureSound,
  type LocalScreenCapture,
  type WebScreenCapture,
} from './screen-capture';

// A verified local adapter rotates epoch on authorization/session/lease generation loss.
// This is an ownership seam, not a bearer grant or an implementation of authentication.
export type PreviewAuthorizationSnapshot = Readonly<{ epoch: object; deadline: number }>;
export type PreparedPreviewAuthorization = PreviewAuthorizationSnapshot & {
  // Idempotent local disposal of this preparation only, including obsolete late results.
  dispose(): void;
};
export type PreviewAuthorizationSource = {
  prepare(request: {
    sound: CaptureSound;
    signal: AbortSignal;
  }): Promise<PreparedPreviewAuthorization>;
  inspect(): PreviewAuthorizationSnapshot | null;
  // Revokes current and pending preparations on session/lease/authorization generation loss.
  onInvalidated(listener: () => void): () => void;
};
export type PreviewEnd = CaptureEnd | 'expired' | 'authorization-lost' | 'failed';
export type ScreenPreviewState = Readonly<
  | {
      phase: 'idle' | 'disposed';
      reason?: PreviewEnd;
      error?: Readonly<{ code: CaptureErrorCode; message: string }>;
    }
  | { phase: 'preparing' | 'ready' | 'choosing'; sound: CaptureSound }
  // Local metadata only. This owner never attaches playback or publishes the stream.
  | { phase: 'preview'; sound: CaptureSound; capture: LocalScreenCapture }
>;
type Completion = { resolve: () => void; reject: (error: ScreenCaptureError) => void };
type Attempt = {
  sound: CaptureSound;
  abort: AbortController;
  authorization?: PreparedPreviewAuthorization;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  prepare: Completion;
  start?: Completion;
  started: boolean;
  capture?: LocalScreenCapture;
  remove: (() => void)[];
};
type Capture = Pick<WebScreenCapture, 'start' | 'stop' | 'dispose'>;

export class ScreenPreviewOwner {
  private attempt?: Attempt;
  private preparing = false;
  private picking = false;
  private disposed = false;
  private finishing = false;
  private state: ScreenPreviewState = Object.freeze({ phase: 'idle' });
  private listeners = new Set<(state: ScreenPreviewState) => void>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly options: {
      capture: Capture;
      authorization?: PreviewAuthorizationSource;
      onError: (error: ScreenCaptureError) => void;
      now?: () => number;
      prepareTimeoutMs?: number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.prepareTimeoutMs ?? 60000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2147483647)
      throw new ScreenCaptureError('invalid', 'Invalid preview preparation timeout.');
    this.unsubscribe =
      options.authorization?.onInvalidated(() => this.end('authorization-lost')) ?? (() => {});
  }
  subscribe(listener: (state: ScreenPreviewState) => void) {
    if (this.disposed) throw new ScreenCaptureError('disposed', 'Screen preview was disposed.');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  inspect(): ScreenPreviewState {
    if (this.attempt && this.attempt.deadline <= this.now()) this.end('expired');
    else if (this.attempt?.authorization) this.authorized(this.attempt);
    return this.state;
  }
  private notify() {
    for (const listener of this.listeners) listener(this.state);
  }
  private valid(
    value: PreviewAuthorizationSnapshot | null | undefined,
  ): value is PreviewAuthorizationSnapshot {
    return (
      !!value &&
      typeof value.epoch === 'object' &&
      value.epoch !== null &&
      Number.isSafeInteger(value.deadline)
    );
  }
  private authorized(attempt: Attempt) {
    if (this.attempt !== attempt || this.disposed || !attempt.authorization) return false;
    let current: PreviewAuthorizationSnapshot | null;
    try {
      current = this.options.authorization!.inspect();
    } catch (cause) {
      this.end(
        'authorization-lost',
        new ScreenCaptureError('failed', 'Preview authorization is unavailable.', { cause }),
      );
      return false;
    }
    if (this.attempt !== attempt) return false;
    if (!this.valid(current) || current.epoch !== attempt.authorization.epoch) {
      this.end('authorization-lost');
      return false;
    }
    attempt.deadline = Math.min(attempt.deadline, current.deadline);
    if (attempt.deadline <= this.now()) {
      this.end('expired');
      return false;
    }
    this.deadline(attempt);
    return true;
  }
  private deadline(attempt: Attempt) {
    clearTimeout(attempt.timer);
    attempt.timer = setTimeout(
      () => {
        if (this.attempt === attempt) this.authorized(attempt);
      },
      Math.min(2147483647, Math.max(1, attempt.deadline - this.now())),
    );
  }
  prepare(request: { sound: CaptureSound; signal?: AbortSignal }): Promise<void> {
    if (this.disposed)
      return Promise.reject(new ScreenCaptureError('disposed', 'Screen preview was disposed.'));
    if (this.finishing || this.attempt || this.preparing || this.picking)
      return Promise.reject(
        new ScreenCaptureError('busy', 'Finish the current preview operation first.'),
      );
    if (!request || (request.sound !== 'none' && request.sound !== 'tab'))
      return Promise.reject(
        new ScreenCaptureError('invalid', 'Choose source sound or video only explicitly.'),
      );
    if (request.signal?.aborted)
      return Promise.reject(new ScreenCaptureError('cancelled', 'Screen preview was cancelled.'));
    if (!this.options.authorization)
      return Promise.reject(
        new ScreenCaptureError('unsupported', 'Preview authorization is unavailable.'),
      );
    let resolve!: () => void, reject!: (error: ScreenCaptureError) => void;
    const result = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const attempt: Attempt = {
      sound: request.sound,
      abort: new AbortController(),
      deadline: this.now() + this.timeoutMs,
      prepare: { resolve, reject },
      started: false,
      remove: [],
    };
    this.attempt = attempt;
    const abort = () => {
      if (this.attempt === attempt) this.end('cancelled');
    };
    request.signal?.addEventListener('abort', abort, { once: true });
    attempt.remove.push(() => request.signal?.removeEventListener('abort', abort));
    attempt.timer = setTimeout(() => {
      if (this.attempt === attempt) this.end('expired');
    }, this.timeoutMs);
    this.preparing = true;
    this.state = Object.freeze({ phase: 'preparing', sound: attempt.sound });
    let pending: Promise<PreparedPreviewAuthorization>;
    try {
      pending = this.options.authorization.prepare({
        sound: attempt.sound,
        signal: attempt.abort.signal,
      });
    } catch (cause) {
      this.preparing = false;
      this.end('failed', this.failure(cause, 'Preview authorization failed.'));
      return result;
    }
    void pending.then(
      (handle) => {
        this.preparing = false;
        if (this.attempt !== attempt) {
          this.obsolete(handle);
          return;
        }
        try {
          const prepared = Object.freeze({
            epoch: handle.epoch,
            deadline: handle.deadline,
            dispose: handle.dispose.bind(handle),
          });
          attempt.authorization = prepared;
          if (attempt.deadline <= this.now()) {
            this.end('expired');
            return;
          }
          if (!this.valid(prepared)) {
            this.end('failed', new ScreenCaptureError('invalid', 'Invalid preview authorization.'));
            return;
          }
          attempt.deadline = prepared.deadline;
          if (!this.authorized(attempt)) return;
        } catch (cause) {
          if (!attempt.authorization) this.obsolete(handle);
          this.end('failed', this.failure(cause, 'Preview authorization failed.'));
          return;
        }
        this.state = Object.freeze({ phase: 'ready', sound: attempt.sound });
        resolve();
        this.notify();
      },
      (cause) => {
        this.preparing = false;
        if (this.attempt === attempt)
          this.end('failed', this.failure(cause, 'Preview authorization failed.'));
      },
    );
    this.notify();
    return result;
  }
  start(): Promise<void> {
    const attempt = this.attempt;
    if (this.disposed)
      return Promise.reject(new ScreenCaptureError('disposed', 'Screen preview was disposed.'));
    if (!attempt || this.state.phase !== 'ready')
      return Promise.reject(
        new ScreenCaptureError('invalid', 'Prepare authorization before choosing a source.'),
      );
    if (!this.authorized(attempt))
      return Promise.reject(new ScreenCaptureError('denied', 'Preview authorization ended.'));
    let resolve!: () => void, reject!: (error: ScreenCaptureError) => void;
    const result = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    attempt.start = { resolve, reject };
    attempt.started = true;
    this.picking = true;
    this.state = Object.freeze({ phase: 'choosing', sound: attempt.sound });
    let pending: Promise<LocalScreenCapture>;
    try {
      // No await or authorization preparation may precede this gesture-bound call.
      pending = this.options.capture.start({ sound: attempt.sound, signal: attempt.abort.signal });
    } catch (cause) {
      this.picking = false;
      this.end('failed', this.failure(cause, 'Source selection failed.'));
      return result;
    }
    void pending.then(
      (capture) => {
        this.picking = false;
        if (this.attempt !== attempt) {
          this.obsolete(capture);
          return;
        }
        attempt.capture = capture;
        try {
          if (!this.authorized(attempt)) return;
          const tracks = [capture.video, ...(capture.audio ? [capture.audio] : [])];
          const live = () => {
            const current = capture.stream.getTracks();
            return (
              capture.sound === attempt.sound &&
              (attempt.sound === 'tab' ? !!capture.audio : !capture.audio) &&
              tracks.every((track) => track.readyState === 'live' && track.enabled) &&
              current.length === tracks.length &&
              tracks.every((track) => current.includes(track))
            );
          };
          const listen = (target: EventTarget, name: string, reason: PreviewEnd) => {
            const ended = () => {
              if (this.attempt === attempt) this.end(reason);
            };
            target.addEventListener(name, ended);
            attempt.remove.push(() => target.removeEventListener(name, ended));
          };
          listen(capture.video, 'ended', 'video-ended');
          if (capture.audio) listen(capture.audio, 'ended', 'audio-ended');
          listen(capture.stream, 'addtrack', 'stream-changed');
          listen(capture.stream, 'removetrack', 'stream-changed');
          void capture.ended.then(
            (reason) => {
              if (this.attempt === attempt && attempt.capture === capture) this.end(reason);
              else this.obsolete(capture);
            },
            (cause) => {
              if (this.attempt === attempt)
                this.end('failed', this.failure(cause, 'Preview source lifecycle failed.'));
              else this.options.onError(this.failure(cause, 'Obsolete preview lifecycle failed.'));
            },
          );
          if (!live()) {
            this.end(
              'failed',
              new ScreenCaptureError(
                'source_ended',
                'The selected preview source is no longer valid.',
              ),
            );
            return;
          }
        } catch (cause) {
          this.end('failed', this.failure(cause, 'Preview source validation failed.'));
          return;
        }
        this.state = Object.freeze({ phase: 'preview', sound: attempt.sound, capture });
        resolve();
        this.notify();
      },
      (cause) => {
        this.picking = false;
        if (this.attempt === attempt)
          this.end('failed', this.failure(cause, 'Source selection failed.'));
      },
    );
    this.notify();
    return result;
  }
  private failure(cause: unknown, message: string) {
    return cause instanceof ScreenCaptureError
      ? cause
      : new ScreenCaptureError('failed', message, { cause });
  }
  private obsolete(resource: { dispose(): void }) {
    try {
      resource.dispose();
    } catch (cause) {
      this.options.onError(this.failure(cause, 'Obsolete preview cleanup failed.'));
    }
  }
  private end(reason: PreviewEnd, error?: ScreenCaptureError, permanent = false) {
    const attempt = this.attempt;
    if (!attempt && !permanent) return;
    this.attempt = undefined;
    this.finishing = true;
    const failures: unknown[] = [];
    const clean = (work: () => void) => {
      try {
        work();
      } catch (cause) {
        failures.push(cause);
      }
    };
    if (attempt) {
      clearTimeout(attempt.timer);
      for (const remove of attempt.remove) clean(remove);
      clean(() => attempt.abort.abort());
      if (attempt.started) clean(() => this.options.capture.stop());
      if (attempt.capture) clean(() => attempt.capture!.dispose());
      if (attempt.authorization) clean(() => attempt.authorization!.dispose());
    }
    if (permanent) {
      clean(this.unsubscribe);
      clean(() => this.options.capture.dispose());
    }
    if (failures.length)
      error = new ScreenCaptureError('failed', 'Preview cleanup failed.', {
        cause: new AggregateError(failures),
      });
    const ended =
      error ??
      new ScreenCaptureError(
        reason === 'disposed'
          ? 'disposed'
          : reason === 'expired'
            ? 'timeout'
            : reason === 'authorization-lost'
              ? 'denied'
              : 'cancelled',
        'Screen preview ended: ' + reason + '.',
      );
    attempt?.prepare.reject(ended);
    attempt?.start?.reject(ended);
    this.state = Object.freeze({
      phase: this.disposed ? 'disposed' : 'idle',
      reason,
      ...(error ? { error: Object.freeze({ code: error.code, message: error.message }) } : {}),
    });
    this.finishing = false;
    try {
      this.notify();
      if (failures.length) this.options.onError(ended);
    } finally {
      if (permanent) this.listeners.clear();
    }
  }
  stop() {
    this.end('stopped');
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.end('disposed', undefined, true);
  }
}
