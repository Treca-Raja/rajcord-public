import { io, type Socket } from 'socket.io-client';
import type {
  ScreenAck,
  ScreenBindRequest,
  ScreenBinding,
  ScreenClientEvents,
  ScreenServerEvents,
  ScreenDirectory,
  ScreenLinkNotice,
  ScreenClosed,
  ScreenSignalNotice,
} from '@tricord/shared';
import type { OwnedScreenBinding, ScreenBindingDependency } from './screen-binding';

const sockets = new Map<string, ScreenSocket>();
export class ScreenSocket {
  private readonly socket: Socket<ScreenServerEvents, ScreenClientEvents>;
  private retired = false;
  private epoch?: string;
  private raw = new Set<Promise<unknown>>();
  private listeners = new Set<
    (event: 'directory' | 'link' | 'closed' | 'signal' | 'disconnect', data: unknown) => void
  >();
  constructor(csrfToken: string) {
    this.socket = io({
      transports: ['websocket'],
      auth: { csrfToken },
      withCredentials: true,
      autoConnect: false,
      reconnection: false,
    });
    this.socket.on('screen:directory', (value) => this.notify('directory', value));
    this.socket.on('screen:link', (value) => this.notify('link', value));
    this.socket.on('screen:closed', (value) => this.notify('closed', value));
    this.socket.on('screen:signal', (value) => this.notify('signal', value));
    this.socket.on('disconnect', () => this.notify('disconnect', undefined));
  }
  private notify(event: Parameters<Parameters<ScreenSocket['subscribe']>[0]>[0], value: unknown) {
    if (!this.retired) for (const listener of [...this.listeners]) listener(event, value);
  }
  subscribe(
    listener: (
      event: 'directory' | 'link' | 'closed' | 'signal' | 'disconnect',
      value: ScreenDirectory | ScreenLinkNotice | ScreenClosed | ScreenSignalNotice | unknown,
    ) => void,
  ) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private track<T>(raw: Promise<T>) {
    this.raw.add(raw);
    void raw.then(
      () => this.raw.delete(raw),
      () => this.raw.delete(raw),
    );
    return raw;
  }
  async bind(request: ScreenBindRequest, signal: AbortSignal): Promise<unknown> {
    if (this.retired || signal.aborted) throw new Error('Screen connection ended.');
    await this.track(
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Screen connection timed out.')), 4000);
        const connected = () => finish(),
          failed = (cause: Error) => finish(cause);
        const aborted = () => finish(new Error('Screen connection cancelled.'));
        const finish = (cause?: Error) => {
          clearTimeout(timer);
          this.socket.off('connect', connected);
          this.socket.off('connect_error', failed);
          signal.removeEventListener('abort', aborted);
          if (cause) reject(cause);
          else resolve();
        };
        this.socket.once('connect', connected);
        this.socket.once('connect_error', failed);
        signal.addEventListener('abort', aborted, { once: true });
        this.socket.connect();
      }),
    );
    if (this.retired || signal.aborted) throw new Error('Screen connection ended.');
    const binding = await this.command<ScreenBinding>('screen:bind', request, signal);
    if (this.retired || signal.aborted) throw new Error('Screen connection ended.');
    this.epoch = binding.epoch;
    sockets.set(binding.epoch, this);
    return binding;
  }
  command<T>(event: keyof ScreenClientEvents, body: unknown, signal?: AbortSignal): Promise<T> {
    if (this.retired || !this.socket.connected || signal?.aborted)
      return Promise.reject(new Error('Screen connection is unavailable.'));
    if (this.raw.size >= 20) return Promise.reject(new Error('Screen connection is busy.'));
    // Socket.IO's generic argument tuples cannot represent this checked event union.
    const emit = this.socket.timeout(4000).emitWithAck.bind(this.socket.timeout(4000)) as (
      event: keyof ScreenClientEvents,
      body: unknown,
    ) => Promise<ScreenAck<T>>;
    const raw = this.track(emit(event, body));
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(new Error('Screen request cancelled.'));
      signal?.addEventListener('abort', aborted, { once: true });
      void raw
        .then((ack) => {
          if (this.retired || signal?.aborted) throw new Error('Screen request ended.');
          if (!ack || typeof ack !== 'object' || typeof ack.ok !== 'boolean')
            throw new Error('Invalid screen acknowledgement.');
          if (!ack.ok)
            throw Object.assign(new Error(ack.error || 'Screen request rejected.'), {
              code: ack.code,
            });
          resolve(ack.data);
        })
        .catch(reject)
        .finally(() => signal?.removeEventListener('abort', aborted));
    });
  }
  retire = async () => {
    if (!this.retired) {
      this.retired = true;
      if (this.epoch && sockets.get(this.epoch) === this) sockets.delete(this.epoch);
      this.listeners.clear();
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    await Promise.allSettled([...this.raw]);
  };
}
export function screenSocketFactory(csrf: string): ScreenBindingDependency['create'] {
  return (own) => {
    const socket = new ScreenSocket(csrf);
    own(socket.retire);
    return socket;
  };
}
export function screenSocket(binding: OwnedScreenBinding) {
  const socket = sockets.get(binding.binding.epoch);
  if (!binding.inspect() || !socket) throw new Error('Screen transport does not own this binding.');
  return socket;
}
