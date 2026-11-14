import { screenIceServers } from './screen-ice';
import {
  SCREEN_PROTOCOL_VERSION,
  type ScreenBindRequest,
  type ScreenBinding,
} from '@tricord/shared';
import { adoptScreenRenewal, type ScreenRenewalPermit } from './screen-renewal';

type Retire = () => void | Promise<void>;
export type ScreenBindTransport = {
  bind(request: ScreenBindRequest, signal: AbortSignal): Promise<unknown>;
  retire: Retire;
};
export type ScreenBindingDependency = {
  create(own: (retire: Retire) => void): ScreenBindTransport;
  onError(error: unknown): void;
  now?: () => number;
};
export type OwnedScreenBinding = Readonly<{
  binding: Readonly<ScreenBinding>;
  inspect(): Readonly<{ generation: object; deadline: number }> | null;
  onInvalidated(listener: () => void): () => void;
  release(): void;
  adoptRenewal(permit: ScreenRenewalPermit): void;
}>;

const fail = (message: string) => new Error('Screen binding: ' + message);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

type Attempt = {
  current(): boolean;
  abort: AbortController;
  constructing: boolean;
  raw: boolean;
  retiring: number;
  ended: boolean;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  cleanups: Map<Retire, boolean>;
  listeners: Set<() => void>;
  removeAbort(): void;
  reject(error: unknown): void;
};

// Retained by the voice owner, including after logical cancellation. References and
// deadlines here fence local ownership; only the server authenticates a binding.
export class ScreenBindingOwner {
  private attempt?: Attempt;
  private disposed = false;
  private readonly now: () => number;
  constructor(private readonly dependency?: ScreenBindingDependency) {
    this.now = dependency?.now ?? Date.now;
  }
  private report(error: unknown) {
    try {
      this.dependency!.onError(error);
    } catch (cause) {
      globalThis.reportError(cause);
    }
  }
  private free(attempt: Attempt) {
    if (
      this.attempt === attempt &&
      attempt.ended &&
      !attempt.constructing &&
      !attempt.raw &&
      !attempt.retiring
    )
      this.attempt = undefined;
  }
  private retire(attempt: Attempt, work: Retire) {
    if (attempt.cleanups.get(work)) return;
    attempt.cleanups.set(work, true);
    attempt.retiring++;
    let raw: void | Promise<void>;
    try {
      raw = work();
    } catch (cause) {
      attempt.retiring--;
      this.report(cause);
      this.free(attempt);
      return;
    }
    Promise.resolve(raw).then(
      () => {
        attempt.retiring--;
        this.free(attempt);
      },
      (cause: unknown) => {
        attempt.retiring--;
        this.report(cause);
        this.free(attempt);
      },
    );
  }
  private end(attempt: Attempt, cause: unknown) {
    if (attempt.ended) return;
    attempt.ended = true;
    clearTimeout(attempt.timer);
    attempt.removeAbort();
    attempt.reject(cause);
    attempt.abort.abort();
    for (const listener of [...attempt.listeners]) {
      try {
        listener();
      } catch (error) {
        this.report(error);
      }
    }
    attempt.listeners.clear();
    for (const work of attempt.cleanups.keys()) this.retire(attempt, work);
    this.free(attempt);
  }
  invalidate() {
    if (this.attempt) this.end(this.attempt, fail('voice authorization ended.'));
  }
  dispose() {
    this.disposed = true;
    this.invalidate();
  }
  inspect() {
    return Object.freeze({ occupied: !!this.attempt, disposed: this.disposed });
  }
  bind(
    lease: Readonly<{ id: string; channelId: string }>,
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<OwnedScreenBinding> {
    if (this.disposed || !current()) return Promise.reject(fail('no current voice lease.'));
    if (!this.dependency) return Promise.reject(fail('transport is unavailable.'));
    if (this.attempt) return Promise.reject(fail('previous screen work is still owned.'));
    if (signal?.aborted) return Promise.reject(fail('cancelled.'));
    let resolve!: (value: OwnedScreenBinding) => void, reject!: (error: unknown) => void;
    const result = new Promise<OwnedScreenBinding>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const attempt: Attempt = {
      current,
      abort: new AbortController(),
      constructing: true,
      raw: false,
      retiring: 0,
      ended: false,
      deadline: this.now() + 5000,
      cleanups: new Map(),
      listeners: new Set(),
      removeAbort: () => {},
      reject,
    };
    this.attempt = attempt;
    const check = () => {
      if (!attempt.ended && (!current() || attempt.deadline <= this.now()))
        this.end(attempt, fail('authorization ended or timed out.'));
      return !attempt.ended;
    };
    const schedule = () => {
      clearTimeout(attempt.timer);
      attempt.timer = setTimeout(
        () => {
          if (check()) schedule();
        },
        Math.max(1, attempt.deadline - this.now()),
      );
    };
    const cancelled = () => this.end(attempt, fail('cancelled.'));
    signal?.addEventListener('abort', cancelled, { once: true });
    attempt.removeAbort = () => signal?.removeEventListener('abort', cancelled);
    schedule();
    try {
      let constructing = true;
      let transport: ScreenBindTransport;
      const own = (retire: Retire) => {
        if (!constructing || typeof retire !== 'function')
          throw fail('invalid construction cleanup.');
        if (!attempt.cleanups.has(retire)) attempt.cleanups.set(retire, false);
        if (attempt.ended) this.retire(attempt, retire);
      };
      try {
        transport = this.dependency.create(own);
      } finally {
        constructing = false;
      }
      if (
        !transport ||
        typeof transport.bind !== 'function' ||
        typeof transport.retire !== 'function'
      )
        throw fail('invalid transport.');
      if (!attempt.cleanups.has(transport.retire)) attempt.cleanups.set(transport.retire, false);
      if (!check()) {
        for (const work of attempt.cleanups.keys()) this.retire(attempt, work);
        return result;
      }
      const started = this.now();
      attempt.raw = true;
      const raw = transport.bind(
        {
          version: SCREEN_PROTOCOL_VERSION,
          leaseId: lease.id,
          requestId: crypto.randomUUID(),
        },
        attempt.abort.signal,
      );
      Promise.resolve(raw).then(
        (value) => {
          attempt.raw = false;
          try {
            if (!check()) return;
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw fail('invalid reply.');
            const body = value as Record<string, unknown>;
            if (
              ![3, 4].includes(Object.keys(body).length) ||
              Object.keys(body).some(
                (key) => !['epoch', 'channelId', 'remainingMs', 'iceServers'].includes(key),
              ) ||
              !identifier(body.epoch) ||
              body.channelId !== lease.channelId ||
              !Number.isSafeInteger(body.remainingMs) ||
              (body.remainingMs as number) < 1 ||
              (body.remainingMs as number) > 45000
            )
              throw fail('invalid reply.');
            const binding: Readonly<ScreenBinding> = Object.freeze({
              epoch: body.epoch,
              channelId: lease.channelId,
              remainingMs: body.remainingMs as number,
              ...(Object.hasOwn(body, 'iceServers')
                ? { iceServers: screenIceServers(body.iceServers as RTCIceServer[]) }
                : {}),
            });
            attempt.deadline = started + binding.remainingMs;
            if (!check()) return;
            schedule();
            const generation = Object.freeze({});
            let snapshot = Object.freeze({ generation, deadline: attempt.deadline });
            let renewalRevision = 0;
            resolve(
              Object.freeze({
                binding,
                inspect: () => (check() ? snapshot : null),
                onInvalidated: (listener: () => void) => {
                  if (check()) attempt.listeners.add(listener);
                  else listener();
                  return () => {
                    attempt.listeners.delete(listener);
                  };
                },
                release: () => this.end(attempt, fail('released.')),
                adoptRenewal: (permit: ScreenRenewalPermit) => {
                  if (!check()) throw fail('binding ended.');
                  adoptScreenRenewal(
                    permit,
                    generation,
                    attempt.deadline,
                    renewalRevision,
                    this.now(),
                  );
                  attempt.deadline = permit.deadline;
                  renewalRevision = permit.revision;
                  snapshot = Object.freeze({ generation, deadline: permit.deadline });
                  schedule();
                },
              }),
            );
          } catch (cause) {
            this.end(attempt, cause);
          } finally {
            this.free(attempt);
          }
        },
        (cause: unknown) => {
          attempt.raw = false;
          this.end(attempt, cause);
          this.free(attempt);
        },
      );
    } catch (cause) {
      attempt.raw = false;
      this.end(attempt, cause);
    } finally {
      attempt.constructing = false;
      this.free(attempt);
    }
    return result;
  }
}
