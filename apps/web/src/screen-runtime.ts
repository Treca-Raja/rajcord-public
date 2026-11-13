import type { ApprovedVoiceSession } from './voice-session';
import type { VoiceController } from './voice-controller';
import type {
  ScreenBindingDependency,
  OwnedScreenBinding,
  ScreenBindTransport,
} from './screen-binding';
import type {
  ScreenReceiveLane,
  ScreenReceiveHandle,
  ScreenReceiveOptions,
} from './screen-receiver';
import type { WebScreenCapture } from './screen-capture';

type Retirement = ScreenBindTransport['retire'];
type Ticket = { constructing: boolean; raw: number; cleanup: number; retired: boolean };
type Voice = Pick<VoiceController, 'bindScreens' | 'onLeaseInvalidated'>;
type Capture = Pick<WebScreenCapture, 'start' | 'stop' | 'dispose'>;

export type ScreenRuntimeAttachment = Readonly<{
  bindingDependency?: ScreenBindingDependency;
  connectVoice(voice: Voice): void;
  bind(signal?: AbortSignal): Promise<OwnedScreenBinding>;
  openIncoming(options: ScreenReceiveOptions): ScreenReceiveHandle;
  stop(): void;
  release(): void;
}>;

// Bootstrap owns this object for the document, outside approval/React effects.
// Retiring an attachment stops media; it cannot release unsettled native work.
export class ScreenRuntime {
  private current?: { release(): void };
  private ticket?: Ticket;
  private disposed = false;
  private attaching = false;
  private ending = 0;
  constructor(
    private readonly options: {
      binding?: ScreenBindingDependency;
      capture?: Capture;
      incoming?: ScreenReceiveLane;
      onError(error: unknown): void;
      sessionTransport?: boolean;
    },
  ) {}
  private report(cause: unknown) {
    try {
      this.options.onError(cause);
    } catch (error) {
      globalThis.reportError(error);
    }
  }
  private clear(ticket: Ticket) {
    if (
      this.ticket === ticket &&
      ticket.retired &&
      !ticket.constructing &&
      !ticket.raw &&
      !ticket.cleanup
    )
      this.ticket = undefined;
  }
  private dependency(
    current: () => boolean,
    session: ApprovedVoiceSession,
  ): ScreenBindingDependency | undefined {
    const dependency =
      this.options.binding ??
      (this.options.sessionTransport
        ? { create: session.openScreens, onError: this.options.onError }
        : undefined);
    if (!dependency) return;
    return Object.freeze({
      now: dependency.now,
      onError: (error: unknown) => this.report(error),
      create: (own: (retire: Retirement) => void): ScreenBindTransport => {
        if (!current() || this.disposed) throw new Error('Screen attachment ended.');
        if (this.ticket) throw new Error('Screen runtime still owns unresolved binding work.');
        const ticket: Ticket = { constructing: true, raw: 0, cleanup: 0, retired: false };
        this.ticket = ticket;
        const cleanups = new Map<Retirement, Retirement>();
        const register = (retire: Retirement) => {
          if (!ticket.constructing)
            throw new Error('Register screen retirement during construction.');
          let wrapped = cleanups.get(retire);
          if (wrapped) return wrapped;
          let result: Promise<void> | undefined;
          wrapped = () => {
            if (result) return result;
            ticket.retired = true;
            ticket.cleanup++;
            // Reserve the idempotent result before running reentrant user cleanup.
            result = Promise.resolve()
              .then(retire)
              .then(
                () => {
                  ticket.cleanup--;
                  this.clear(ticket);
                },
                (cause: unknown) => {
                  ticket.cleanup--;
                  this.clear(ticket);
                  throw cause;
                },
              );
            return result;
          };
          cleanups.set(retire, wrapped);
          own(wrapped);
          return wrapped;
        };
        try {
          const transport = dependency.create(register);
          const retire = register(transport.retire);
          return {
            retire,
            bind: (request, signal) => {
              if (!current() || ticket.retired || ticket.raw)
                return Promise.reject(new Error('Screen attachment ended or binding is busy.'));
              ticket.raw++;
              let raw: Promise<unknown>;
              try {
                raw = transport.bind(request, signal);
              } catch (cause) {
                ticket.raw--;
                this.clear(ticket);
                throw cause;
              }
              return Promise.resolve(raw).then(
                (value) => {
                  ticket.raw--;
                  this.clear(ticket);
                  return value;
                },
                (cause: unknown) => {
                  ticket.raw--;
                  this.clear(ticket);
                  throw cause;
                },
              );
            },
          };
        } catch (cause) {
          ticket.retired = true;
          throw cause;
        } finally {
          ticket.constructing = false;
          this.clear(ticket);
        }
      },
    });
  }
  attach(session: ApprovedVoiceSession): ScreenRuntimeAttachment {
    if (this.disposed || !session.current) throw new Error('Screen session ended.');
    if (this.attaching || this.ending)
      throw new Error('Screen attachment replacement is in progress.');
    this.attaching = true;
    try {
      this.current?.release();
      if (this.disposed || !session.current) throw new Error('Screen session ended.');
      let active = true;
      let voice: Voice | undefined;
      let binding: OwnedScreenBinding | undefined;
      let incoming: ScreenReceiveHandle | undefined;
      let removeVoice = () => {},
        removeSession = () => {};
      const pending = new Set<(cause: Error) => void>();
      const attachment = { release: () => release() };
      const current = () =>
        active && !this.disposed && session.current && this.current === attachment;
      const stop = () => {
        this.ending++;
        try {
          const previous = binding;
          binding = undefined;
          const received = incoming;
          incoming = undefined;
          for (const cancel of [...pending]) cancel(new Error('Screen attachment stopped.'));
          pending.clear();
          const tasks = [
            () => received?.stop(),
            () => previous?.release(),
            () => this.options.capture?.stop(),
          ];
          for (const task of tasks) {
            try {
              task();
            } catch (cause) {
              this.report(cause);
            }
          }
        } finally {
          this.ending--;
        }
      };
      const release = () => {
        if (!active) return;
        active = false;
        // Retire this key before any cleanup can synchronously call a replacement.
        if (this.current === attachment) this.current = undefined;
        removeVoice();
        removeSession();
        stop();
      };
      this.current = attachment;
      removeSession = session.onEnd(release);
      const dependency = this.dependency(current, session);
      return Object.freeze({
        ...(dependency ? { bindingDependency: dependency } : {}),
        connectVoice: (delegate: Voice) => {
          if (!current() || voice) throw new Error('Screen voice delegate is unavailable.');
          voice = delegate;
          const unsubscribe = delegate.onLeaseInvalidated(() => {
            if (current()) stop();
          });
          if (current()) removeVoice = unsubscribe;
          else unsubscribe();
        },
        bind: (signal?: AbortSignal) => {
          if (!current() || !voice) return Promise.reject(new Error('Screen attachment ended.'));
          const abort = new AbortController();
          let cancel!: (cause: Error) => void;
          const result = new Promise<OwnedScreenBinding>((resolve, reject) => {
            cancel = (cause) => {
              reject(cause);
              abort.abort();
            };
            pending.add(cancel);
            const aborted = () => cancel(new Error('Screen binding cancelled.'));
            signal?.addEventListener('abort', aborted, { once: true });
            if (signal?.aborted) aborted();
            let raw: Promise<OwnedScreenBinding>;
            try {
              raw = voice!.bindScreens({ signal: abort.signal });
            } catch (cause) {
              raw = Promise.reject(cause);
            }
            void raw
              .then((handle) => {
                if (current() && !abort.signal.aborted) {
                  binding = handle;
                  resolve(handle);
                } else {
                  handle.release();
                  reject(new Error('Screen attachment ended.'));
                }
              }, reject)
              .finally(() => {
                pending.delete(cancel);
                signal?.removeEventListener('abort', aborted);
              });
          });
          return result;
        },
        openIncoming: (options: ScreenReceiveOptions) => {
          if (
            !current() ||
            !binding?.inspect() ||
            options.endpoint.epoch !== binding.binding.epoch ||
            !this.options.incoming
          )
            throw new Error('Screen receiving is unavailable.');
          if (incoming && ['closed', 'paused-hidden'].includes(incoming.inspect().phase))
            incoming = undefined;
          if (incoming) throw new Error('Stop the current screen receiver first.');
          const handle = this.options.incoming.open(options);
          if (!current() || !binding.inspect()) {
            handle.dispose();
            throw new Error('Screen attachment ended.');
          }
          incoming = handle;
          return handle;
        },
        stop: () => {
          if (current()) stop();
        },
        release,
      });
    } finally {
      this.attaching = false;
    }
  }
  attachCall(session: ApprovedVoiceSession) {
    try {
      return this.attach(session);
    } catch (cause) {
      // A failed optional screen owner must not prevent microphone voice joining.
      this.report(cause);
      return undefined;
    }
  }
  inspect() {
    return Object.freeze({
      disposed: this.disposed,
      attached: !!this.current,
      bindingBusy: !!this.ticket,
    });
  }
  suspend() {
    this.current?.release();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.current?.release();
    for (const cleanup of [
      () => this.options.capture?.dispose(),
      () => this.options.incoming?.dispose(),
    ]) {
      try {
        cleanup();
      } catch (cause) {
        this.report(cause);
      }
    }
  }
}
