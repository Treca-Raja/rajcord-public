import type { ScreenPeerLifecycle } from './screen-peer';
import { adoptScreenRenewal, type ScreenRenewalPermit } from './screen-renewal';

export type ScreenPlaybackElement = Pick<
  HTMLVideoElement,
  | 'srcObject'
  | 'muted'
  | 'volume'
  | 'paused'
  | 'pause'
  | 'play'
  | 'addEventListener'
  | 'removeEventListener'
> & {
  readonly sinkId?: string;
  setSinkId?(id: string): Promise<void>;
};
type Code =
  | 'invalid'
  | 'busy'
  | 'closed'
  | 'cancelled'
  | 'timeout'
  | 'output-required'
  | 'output-missing'
  | 'output-unsupported'
  | 'output-failed'
  | 'autoplay-blocked'
  | 'playback-failed'
  | 'lifecycle-lost'
  | 'expired'
  | 'track-ended';
export class ScreenPlaybackError extends Error {
  constructor(
    readonly code: Code,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export type ScreenPlaybackEnd =
  'hidden' | 'stopped' | 'disposed' | 'lifecycle-lost' | 'expired' | 'track-ended';
type Phase =
  | 'idle'
  | 'paused'
  | 'routing'
  | 'starting'
  | 'playing'
  | 'blocked-output'
  | 'blocked-autoplay'
  | 'error'
  | 'paused-hidden'
  | 'closed'
  | 'stopped'
  | 'disposed';
export type ScreenPlaybackState = Readonly<{
  phase: Phase;
  output: string | null;
  outputAvailable: boolean;
  muted: boolean;
  deafened: boolean;
  volume: number;
  pendingNative: boolean;
  closed: boolean;
  reason?: ScreenPlaybackEnd;
  error?: Readonly<{ code: Code; message: string }>;
}>;
type Attempt = {
  element?: ScreenPlaybackElement;
  stream?: MediaStream;
  cancel?: (error: ScreenPlaybackError) => void;
  timer?: ReturnType<typeof setTimeout>;
  cleanups: (() => void)[];
};
const elements = new WeakSet<ScreenPlaybackElement>();
const failure = (code: Code, message: string, cause?: unknown) =>
  new ScreenPlaybackError(code, message, cause === undefined ? undefined : { cause });

// Owns elements/stream containers only. Incoming tracks remain owned by ScreenPeer.
// The lifecycle is revocation-only; this class cannot authorize or restore a selection.
export class ScreenPlaybackOwner {
  private readonly generation: object;
  private deadline: number;
  private renewalRevision = 0;
  private expiry?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly tracks: readonly MediaStreamTrack[];
  private readonly cleanups: (() => void)[] = [];
  private readonly listeners = new Set<(state: ScreenPlaybackState) => void>();
  private attempt?: Attempt;
  private native?: object;
  private state: ScreenPlaybackState = Object.freeze({
    phase: 'idle',
    output: null,
    outputAvailable: false,
    muted: false,
    deafened: false,
    volume: 1,
    pendingNative: false,
    closed: false,
  });

  constructor(
    private readonly options: {
      lifecycle: ScreenPeerLifecycle;
      video: MediaStreamTrack;
      audio: MediaStreamTrack | null;
      createElement(): ScreenPlaybackElement;
      createStream(tracks: readonly MediaStreamTrack[]): MediaStream;
      // Synchronous local notification only. A future controller owns delivery revocation.
      onStopIncoming(reason: ScreenPlaybackEnd): void;
      onError(error: Error): void;
      now?: () => number;
      operationTimeoutMs?: number;
    },
  ) {
    options = this.options = {
      ...options,
      lifecycle: {
        inspect: options.lifecycle.inspect.bind(options.lifecycle),
        onInvalidated: options.lifecycle.onInvalidated.bind(options.lifecycle),
      },
    };
    this.now = options.now ?? Date.now;
    this.timeout = options.operationTimeoutMs ?? 5000;
    const current = options.lifecycle.inspect();
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 2147483647)
      throw failure('invalid', 'Invalid playback operation timeout.');
    if (
      !current ||
      typeof current.generation !== 'object' ||
      !current.generation ||
      !Number.isSafeInteger(current.deadline) ||
      current.deadline <= this.now()
    )
      throw failure('lifecycle-lost', 'Playback lifecycle is unavailable.');
    this.generation = current.generation;
    this.deadline = current.deadline;
    if (options.video.kind !== 'video' || (options.audio && options.audio.kind !== 'audio'))
      throw failure('invalid', 'Expected one incoming video and optional audio track.');
    this.tracks = Object.freeze(options.audio ? [options.video, options.audio] : [options.video]);
    try {
      for (const track of this.tracks) {
        if (track.readyState !== 'live') throw failure('track-ended', 'Incoming track has ended.');
        const ended = () => this.end('track-ended');
        track.addEventListener('ended', ended);
        this.cleanups.push(() => track.removeEventListener('ended', ended));
      }
      const unsubscribe = options.lifecycle.onInvalidated(() => this.end('lifecycle-lost'));
      if (this.state.closed) unsubscribe();
      else this.cleanups.push(unsubscribe);
      this.check();
    } catch (error) {
      this.end(
        error instanceof ScreenPlaybackError && error.code === 'track-ended'
          ? 'track-ended'
          : 'lifecycle-lost',
      );
      throw error;
    }
  }
  subscribe(listener: (state: ScreenPlaybackState) => void) {
    if (this.state.closed) throw failure('closed', 'Playback owner has ended.');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  inspect(): ScreenPlaybackState {
    if (!this.state.closed) {
      try {
        this.check();
        if (this.state.phase === 'playing' && this.attempt) {
          try {
            this.verifyElement(this.attempt, this.state.output!);
          } catch (cause) {
            const error =
              cause instanceof ScreenPlaybackError
                ? cause
                : failure('playback-failed', 'Playback inspection failed.', cause);
            this.block(error, error.code.startsWith('output-') ? 'blocked-output' : 'error');
          }
        }
      } catch (error) {
        if (!this.state.closed) throw error;
      }
    }
    return this.state;
  }
  private report(error: Error) {
    try {
      this.options.onError(error);
    } catch (cause) {
      queueMicrotask(() => {
        throw cause;
      });
    }
  }
  adoptRenewal(permit: ScreenRenewalPermit) {
    this.check();
    adoptScreenRenewal(permit, this.generation, this.deadline, this.renewalRevision, this.now());
    const current = this.options.lifecycle.inspect();
    if (!current || current.generation !== this.generation || current.deadline < permit.deadline)
      throw failure('lifecycle-lost', 'Playback renewal lifecycle mismatch.');
    this.deadline = permit.deadline;
    this.renewalRevision = permit.revision;
    this.check();
  }
  private update(patch: Partial<ScreenPlaybackState>) {
    this.state = Object.freeze({ ...this.state, ...patch, pendingNative: !!this.native });
    const state = this.state;
    for (const listener of [...this.listeners]) {
      if (this.state !== state) break;
      try {
        listener(state);
      } catch (cause) {
        this.report(new Error('Playback subscriber failed.', { cause }));
      }
    }
  }
  private check() {
    if (this.state.closed) throw failure('closed', 'Playback owner has ended.');
    let current: ReturnType<ScreenPeerLifecycle['inspect']>;
    try {
      current = this.options.lifecycle.inspect();
    } catch (cause) {
      this.end('lifecycle-lost');
      throw failure('lifecycle-lost', 'Playback lifecycle is unavailable.', cause);
    }
    if (this.state.closed) throw failure('closed', 'Playback owner has ended.');
    if (
      !current ||
      current.generation !== this.generation ||
      !Number.isSafeInteger(current.deadline)
    ) {
      this.end('lifecycle-lost');
      throw failure('lifecycle-lost', 'Playback lifecycle has ended.');
    }
    this.deadline = Math.min(this.deadline, current.deadline);
    if (this.deadline <= this.now()) {
      this.end('expired');
      throw failure('expired', 'Playback deadline expired.');
    }
    if (this.tracks.some((track) => track.readyState !== 'live')) {
      this.end('track-ended');
      throw failure('track-ended', 'Incoming track has ended.');
    }
    clearTimeout(this.expiry);
    this.expiry = setTimeout(
      () => {
        try {
          this.check();
        } catch (cause) {
          if (!this.state.closed) {
            this.end('lifecycle-lost');
            this.report(new Error('Playback deadline check failed.', { cause }));
          }
        }
      },
      Math.min(2147483647, Math.max(1, this.deadline - this.now())),
    );
  }
  private detach(attempt: Attempt) {
    const errors: unknown[] = [];
    const clean = (work: () => void) => {
      try {
        work();
      } catch (error) {
        errors.push(error);
      }
    };
    if (attempt.element) {
      const element = attempt.element;
      clean(() => {
        element.muted = true;
      });
      clean(() => element.pause());
      clean(() => {
        element.srcObject = null;
      });
    }
    for (const cleanup of attempt.cleanups.splice(0)) clean(cleanup);
    if (errors.length) this.report(new AggregateError(errors, 'Playback element cleanup failed.'));
  }
  private cancel(error: ScreenPlaybackError) {
    const attempt = this.attempt;
    this.attempt = undefined;
    if (!attempt) return;
    clearTimeout(attempt.timer);
    attempt.cancel?.(error);
    this.detach(attempt);
  }
  private block(error: ScreenPlaybackError, phase: Phase) {
    this.cancel(error);
    if (this.state.closed) return;
    this.update({
      phase,
      ...(phase === 'blocked-output' ? { outputAvailable: false } : {}),
      error: Object.freeze({ code: error.code, message: error.message }),
    });
  }
  setOutput(id: string | null) {
    this.check();
    if (id !== null && (typeof id !== 'string' || !id.length || id.length > 512))
      throw failure('invalid', 'Choose an explicit output device.');
    if (id === this.state.output && this.state.outputAvailable) return;
    this.cancel(failure('cancelled', 'Playback output changed.'));
    this.check();
    this.update({
      output: id,
      outputAvailable: id !== null,
      phase: id ? 'paused' : 'blocked-output',
      error: undefined,
    });
  }
  outputLost(id: string) {
    this.check();
    if (id !== this.state.output) return;
    this.cancel(failure('output-missing', 'Selected output is unavailable.'));
    this.check();
    this.update({
      outputAvailable: false,
      phase: 'blocked-output',
      error: Object.freeze({
        code: 'output-missing',
        message: 'Selected output is unavailable. Choose an output explicitly.',
      }),
    });
  }
  setMuted(muted: boolean) {
    this.preference({ muted });
  }
  setDeafened(deafened: boolean) {
    this.preference({ deafened });
  }
  setVolume(volume: number) {
    this.preference({ volume });
  }
  private preference(patch: Partial<Pick<ScreenPlaybackState, 'muted' | 'deafened' | 'volume'>>) {
    this.inspect();
    this.check();
    if (
      Object.values(patch).some((value) => value === undefined) ||
      (patch.muted !== undefined && typeof patch.muted !== 'boolean') ||
      (patch.deafened !== undefined && typeof patch.deafened !== 'boolean') ||
      (patch.volume !== undefined &&
        (!Number.isFinite(patch.volume) || patch.volume < 0 || patch.volume > 1))
    )
      throw failure('invalid', 'Invalid playback preference.');
    this.update(patch);
    const element = this.attempt?.element;
    if (!element) return;
    try {
      element.volume = this.state.volume;
      element.muted = this.state.phase !== 'playing' || this.state.muted || this.state.deafened;
    } catch (cause) {
      this.block(failure('playback-failed', 'Cannot apply playback preferences.', cause), 'error');
    }
  }
  // Retain this slot after logical failure until the actual native promise settles.
  private runNative(attempt: Attempt, invoke: () => Promise<void>): Promise<void> {
    const slot = {};
    this.native = slot;
    this.update({});
    return new Promise<void>((resolve, reject) => {
      attempt.cancel = reject;
      const settle = (ok: boolean, error?: unknown) => {
        const obsolete = this.attempt !== attempt || this.state.closed;
        if (obsolete) this.detach(attempt);
        if (this.native === slot) this.native = undefined;
        if (attempt.cancel === reject) attempt.cancel = undefined;
        this.update({});
        if (!ok) reject(error ?? failure('playback-failed', 'Native playback failed.'));
        else resolve();
      };
      try {
        this.check();
        if (this.attempt !== attempt) throw failure('cancelled', 'Playback attempt was replaced.');
        Promise.resolve(invoke()).then(
          () => settle(true),
          (error: unknown) => settle(false, error),
        );
      } catch (cause) {
        settle(false, cause);
      }
    });
  }
  private current(attempt: Attempt, output: string) {
    this.check();
    if (this.attempt !== attempt || this.state.output !== output || !this.state.outputAvailable)
      throw failure('cancelled', 'Playback attempt was replaced.');
  }
  private verifyElement(attempt: Attempt, output: string) {
    if (attempt.element?.sinkId !== output)
      throw failure('output-missing', 'Selected output is no longer applied.');
    if (attempt.element.paused) throw failure('playback-failed', 'Playback did not remain active.');
    const tracks = attempt.stream?.getTracks();
    if (
      !attempt.stream ||
      attempt.element.srcObject !== attempt.stream ||
      !tracks ||
      tracks.length !== this.tracks.length ||
      this.tracks.some((track) => !tracks.includes(track))
    )
      throw failure('playback-failed', 'Playback stream changed.');
  }
  async play(request: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = request.signal;
    this.inspect();
    this.check();
    if (signal?.aborted) throw failure('cancelled', 'Playback was cancelled.');
    if (this.state.phase === 'playing') return;
    if (this.attempt || this.native)
      throw failure('busy', 'Wait for the outstanding native playback operation.');
    const output = this.state.output;
    if (!output || !this.state.outputAvailable) {
      const error = failure('output-required', 'Choose an available output before playback.');
      this.block(error, 'blocked-output');
      throw error;
    }
    const attempt: Attempt = { cleanups: [] };
    this.attempt = attempt;
    let stage: 'output' | 'play' = 'output';
    try {
      const element = this.options.createElement();
      if (elements.has(element) || !element.paused || element.srcObject !== null)
        throw failure('invalid', 'Playback requires a fresh owned element.');
      elements.add(element);
      attempt.element = element;
      element.muted = true;
      element.pause();
      element.srcObject = null;
      element.volume = this.state.volume;
      this.current(attempt, output);
      if (typeof element.setSinkId !== 'function')
        throw failure('output-unsupported', 'Exact output selection is unsupported.');
      const failed = () => {
        if (this.attempt === attempt)
          this.block(failure('playback-failed', 'Playback element failed.'), 'error');
      };
      element.addEventListener('error', failed);
      attempt.cleanups.push(() => element.removeEventListener('error', failed));
      if (signal) {
        const cancelled = () => {
          if (this.attempt === attempt)
            this.block(failure('cancelled', 'Playback was cancelled.'), 'paused');
        };
        signal.addEventListener('abort', cancelled, { once: true });
        attempt.cleanups.push(() => signal.removeEventListener('abort', cancelled));
        if (signal.aborted) throw failure('cancelled', 'Playback was cancelled.');
      }
      attempt.timer = setTimeout(() => {
        if (this.attempt === attempt)
          this.block(failure('timeout', 'Playback operation timed out.'), 'error');
      }, this.timeout);
      this.update({ phase: 'routing', error: undefined });
      this.current(attempt, output);
      await this.runNative(attempt, () => element.setSinkId!(output));
      this.current(attempt, output);
      if (element.sinkId !== output)
        throw failure('output-failed', 'Exact output selection was not confirmed.');
      const stream = this.options.createStream(this.tracks);
      const tracks = stream.getTracks();
      if (
        tracks.length !== this.tracks.length ||
        this.tracks.some((track) => !tracks.includes(track))
      )
        throw failure('invalid', 'Playback stream must contain only its borrowed incoming tracks.');
      this.current(attempt, output);
      attempt.stream = stream;
      element.srcObject = stream;
      stage = 'play';
      this.update({ phase: 'starting' });
      this.current(attempt, output);
      await this.runNative(attempt, () => element.play());
      this.current(attempt, output);
      this.verifyElement(attempt, output);
      clearTimeout(attempt.timer);
      element.volume = this.state.volume;
      this.current(attempt, output);
      element.muted = this.state.muted || this.state.deafened;
      this.current(attempt, output);
      this.update({ phase: 'playing', error: undefined });
      this.current(attempt, output);
    } catch (cause) {
      const code: Code =
        stage === 'output'
          ? 'output-failed'
          : cause instanceof Error && cause.name === 'NotAllowedError'
            ? 'autoplay-blocked'
            : 'playback-failed';
      const error =
        cause instanceof ScreenPlaybackError
          ? cause
          : failure(
              code,
              stage === 'output' ? 'Cannot select the exact output.' : 'Playback needs attention.',
              cause,
            );
      if (this.attempt === attempt)
        this.block(
          error,
          error.code.startsWith('output-')
            ? 'blocked-output'
            : error.code === 'autoplay-blocked'
              ? 'blocked-autoplay'
              : 'error',
        );
      else this.detach(attempt);
      throw error;
    }
  }
  private end(reason: ScreenPlaybackEnd) {
    if (this.state.closed) return;
    // Publish terminal identity before native cleanup or user callbacks can reenter.
    this.state = Object.freeze({ ...this.state, closed: true, reason });
    clearTimeout(this.expiry);
    this.cancel(
      failure(
        reason === 'hidden' || reason === 'stopped' || reason === 'disposed' ? 'closed' : reason,
        'Playback owner has ended.',
      ),
    );
    const errors: unknown[] = [];
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch (cause) {
        errors.push(cause);
      }
    }
    this.update({
      phase:
        reason === 'hidden'
          ? 'paused-hidden'
          : reason === 'stopped'
            ? 'stopped'
            : reason === 'disposed'
              ? 'disposed'
              : 'closed',
    });
    this.listeners.clear();
    try {
      this.options.onStopIncoming(reason);
    } catch (cause) {
      errors.push(cause);
    }
    if (errors.length) this.report(new AggregateError(errors, 'Playback owner cleanup failed.'));
  }
  hide() {
    this.end('hidden');
  }
  stop() {
    this.end('stopped');
  }
  dispose() {
    this.end('disposed');
  }
}
