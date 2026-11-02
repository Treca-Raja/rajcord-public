import { randomUUID } from 'node:crypto';
import type { WebFrameMain } from 'electron';
import type {
  CaptureAuthorization,
  CaptureAuthorityOperation,
  CaptureSoundChoice,
} from '@tricord/shared' with { 'resolution-mode': 'import' };
import type { CaptureIntentSource, TrustedCaptureIntent } from './native-capture.js';

export type CaptureAuthorityTransport = (
  operation: CaptureAuthorityOperation,
  body: Record<string, string>,
  signal: AbortSignal,
) => Promise<unknown>;
export type CaptureAuthorityContext = {
  mainFrame: WebFrameMain;
  url: string;
  navigation: number;
  alive: boolean;
};
type RecordState = {
  requestId: string;
  grantId: string;
  intent: TrustedCaptureIntent;
  deadline: number;
  consumed: boolean;
};
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function grant(value: unknown): CaptureAuthorization {
  const body = value as Partial<CaptureAuthorization> | null;
  if (
    !body ||
    !validId(body.id) ||
    !Number.isSafeInteger(body.remainingMs) ||
    body.remainingMs! <= 0 ||
    body.remainingMs! > 45000 ||
    Object.keys(body).sort().join() !== 'id,remainingMs'
  )
    throw new Error('Invalid capture authority response.');
  return body as CaptureAuthorization;
}
export class ServerCaptureAuthority implements CaptureIntentSource {
  private record?: RecordState;
  private generation = 0;
  private listeners = new Set<() => void>();
  private flight?: {
    result: Promise<unknown>;
    abort: AbortController;
    operation: CaptureAuthorityOperation;
  };
  private preparing?: string;
  private cancelRequest?: string;
  private verifying = false;
  private disposed = false;
  private watch?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;
  private readonly watchMs: number;
  constructor(
    private readonly options: {
      context: () => CaptureAuthorityContext | null;
      transport: CaptureAuthorityTransport;
      onError: (code: string) => void;
      now?: () => number;
      watchMs?: number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.watchMs = options.watchMs ?? 1000;
    if (!Number.isSafeInteger(this.watchMs) || this.watchMs < 1000 || this.watchMs > 10000)
      throw new Error('Invalid capture authority watch interval.');
  }
  onInvalidated(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private sameContext(intent: TrustedCaptureIntent) {
    try {
      const context = this.options.context();
      return (
        !!context?.alive &&
        context.mainFrame === intent.frame &&
        context.url === intent.url &&
        context.navigation === intent.navigation
      );
    } catch {
      return false;
    }
  }
  inspect() {
    const record = this.record;
    if (!record) return null;
    if (this.disposed || record.deadline <= this.now() || !this.sameContext(record.intent)) {
      this.invalidate();
      return null;
    }
    return record.intent;
  }
  private async operation(operation: CaptureAuthorityOperation, body: Record<string, string>) {
    if (this.flight) throw new Error('Capture authority is busy.');
    const abort = new AbortController();
    let ended!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      ended = () => reject(new Error('Capture authority request ended.'));
      abort.signal.addEventListener('abort', ended, { once: true });
    });
    const timeout = setTimeout(() => {
      if (operation === 'cancel') abort.abort();
      else {
        this.options.onError('authority_timeout');
        this.invalidate();
      }
    }, 5000);
    const native = Promise.resolve().then(() => {
      if (abort.signal.aborted) throw new Error('Capture authority request ended.');
      return this.options.transport(operation, body, abort.signal);
    });
    const result = Promise.race([native, cancelled]).finally(() => {
      clearTimeout(timeout);
      abort.signal.removeEventListener('abort', ended);
    });
    const flight = { result, abort, operation };
    this.flight = flight;
    const release = () => {
      if (this.flight === flight) this.flight = undefined;
      queueMicrotask(() => this.drainCancel());
    };
    // Logical cancellation never releases an unresolved native request or body cleanup.
    void native.then(release, () => {
      abort.abort();
      release();
    });
    return result;
  }
  private drainCancel() {
    if (!this.cancelRequest || this.flight || this.verifying || this.preparing) return;
    const requestId = this.cancelRequest;
    this.cancelRequest = undefined;
    void this.operation('cancel', { requestId }).then(
      (value) => {
        if (!value || (value as { cancelled?: unknown }).cancelled !== true)
          this.options.onError('cancel_unavailable');
      },
      () => this.options.onError('cancel_unavailable'),
    );
  }
  private schedule(record: RecordState) {
    clearTimeout(this.watch);
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.invalidate(), Math.max(1, record.deadline - this.now()));
    this.watch = setTimeout(() => void this.check(record), this.watchMs);
  }
  private async check(record: RecordState) {
    if (this.record !== record || !this.inspect()) return;
    if (this.flight || this.verifying) {
      this.watch = setTimeout(() => void this.check(record), this.watchMs);
      return;
    }
    const started = this.now();
    try {
      const value = grant(await this.operation('check', { id: record.grantId }));
      if (this.record !== record) return;
      if (!this.inspect() || value.id !== record.grantId)
        throw new Error('Capture authority changed.');
      record.deadline = Math.min(record.deadline, started + value.remainingMs);
      if (record.deadline <= this.now()) {
        this.invalidate();
        return;
      }
      this.schedule(record);
    } catch {
      if (this.record === record) {
        this.options.onError('authority_unavailable');
        this.invalidate();
      }
    }
  }
  async prepare(sound: CaptureSoundChoice): Promise<TrustedCaptureIntent> {
    if (
      this.disposed ||
      this.record ||
      this.flight ||
      this.preparing ||
      this.verifying ||
      this.cancelRequest
    )
      throw new Error('Capture authority is unavailable or busy.');
    if (sound !== 'none' && sound !== 'system') throw new Error('Invalid capture sound choice.');
    const context = this.options.context();
    if (!context?.alive || !Number.isSafeInteger(context.navigation))
      throw new Error('Capture document is unavailable.');
    const generation = ++this.generation,
      requestId = randomUUID(),
      started = this.now();
    this.preparing = requestId;
    try {
      const value = grant(await this.operation('prepare', { requestId, sound }));
      const intent: TrustedCaptureIntent = Object.freeze({
        intent: {},
        authorization: {},
        generation,
        frame: context.mainFrame,
        url: context.url,
        navigation: context.navigation,
        sound,
        expires: started + value.remainingMs,
      });
      if (
        this.disposed ||
        generation !== this.generation ||
        !this.sameContext(intent) ||
        intent.expires <= this.now()
      )
        throw new Error('Capture authority changed.');
      const record = {
        requestId,
        grantId: value.id,
        intent,
        deadline: intent.expires,
        consumed: false,
      };
      this.record = record;
      this.schedule(record);
      return intent;
    } catch (cause) {
      this.cancelRequest = requestId;
      throw cause;
    } finally {
      this.preparing = undefined;
      this.drainCancel();
    }
  }
  async verify(intent: TrustedCaptureIntent) {
    const record = this.record;
    if (
      this.verifying ||
      !record ||
      record.intent !== intent ||
      record.consumed ||
      this.inspect() !== intent
    )
      return false;
    this.verifying = true;
    try {
      if (this.flight) await this.flight.result;
      if (this.record !== record || this.inspect() !== intent) return false;
      const started = this.now();
      const value = grant(await this.operation('consume', { id: record.grantId }));
      if (this.record !== record) return false;
      if (this.inspect() !== intent || value.id !== record.grantId)
        throw new Error('Capture authority changed.');
      record.deadline = Math.min(record.deadline, started + value.remainingMs);
      if (record.deadline <= this.now()) {
        this.invalidate();
        return false;
      }
      record.consumed = true;
      this.schedule(record);
      return true;
    } catch {
      if (this.record === record) {
        this.options.onError('authority_unavailable');
        this.invalidate();
      }
      return false;
    } finally {
      this.verifying = false;
      this.drainCancel();
    }
  }
  invalidate() {
    this.generation++;
    const requestId = this.record?.requestId ?? this.preparing;
    this.record = undefined;
    clearTimeout(this.watch);
    clearTimeout(this.expiry);
    if (this.flight?.operation !== 'cancel') this.flight?.abort.abort();
    if (requestId) this.cancelRequest = requestId;
    for (const listener of this.listeners) listener();
    this.drainCancel();
  }
  async dispose() {
    if (!this.disposed) {
      this.disposed = true;
      this.invalidate();
      this.listeners.clear();
    }
  }
}
