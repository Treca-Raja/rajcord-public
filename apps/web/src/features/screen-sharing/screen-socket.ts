import { io, type Socket } from 'socket.io-client';
import { SCREEN_DIRECTORY_PAGE_SIZE } from '@tricord/shared';
import { runInBackground } from '../../shared/background';
import type {
  ScreenAck,
  ScreenBindRequest,
  ScreenBinding,
  ScreenClientEvents,
  ScreenServerEvents,
  ScreenDirectory,
  ScreenDirectoryReply,
  ScreenShare,
  ScreenLinkNotice,
  ScreenClosed,
  ScreenSignalNotice,
} from '@tricord/shared';
import type { OwnedScreenBinding, ScreenBindingDependency } from './screen-binding';
import { record, share, uuid } from './screen-share';

const sockets = new Map<string, ScreenSocket>();
type ScreenCommand = { event: keyof ScreenClientEvents; run(): Promise<void>; cancel(): void };
const maxQueued = 128;
function directoryHeader(value: unknown) {
  const data = record(value);
  if (
    typeof data.epoch !== 'string' ||
    !Number.isSafeInteger(data.revision) ||
    (data.revision as number) < 0
  )
    throw new Error('Invalid screen directory.');
  return { epoch: data.epoch, revision: data.revision as number };
}
function directoryValue(value: ScreenDirectory) {
  const header = directoryHeader(value);
  if (!Array.isArray(value.shares)) throw new Error('Invalid screen directory.');
  return { ...header, shares: value.shares.map(share) };
}
export class ScreenSocket {
  private readonly socket: Socket<ScreenServerEvents, ScreenClientEvents>;
  private retired = false;
  private readonly lifetime = new AbortController();
  private directoryEpoch?: string;
  private directoryShares = new Map<string, ScreenShare>();
  private lastDirectory?: ScreenDirectory;
  private epoch?: string;
  private raw = new Set<Promise<unknown>>();
  private commands: ScreenCommand[] = [];
  private selectionReadyAt = 0;
  private wake?: ReturnType<typeof setTimeout>;
  private commanding = false;
  private listeners = new Set<
    (event: 'directory' | 'link' | 'closed' | 'signal' | 'disconnect', data: unknown) => void
  >();
  constructor(csrfToken: string) {
    this.socket = io({
      transports: ['websocket'],
      auth: {
        csrfToken,
        screenSnapshotBatch: true,
        screenDirectoryChanges: true,
        screenMoreThanNineViewers: true,
        screenRenewalPages: true,
      },
      withCredentials: true,
      autoConnect: false,
      reconnection: false,
    });
    this.socket.on('screen:directory', (value) => {
      const directory = this.directoryInput(() => directoryValue(value));
      if (directory) this.fullDirectory(directory);
    });
    this.socket.on('screen:directoryChanges', (value) => {
      const page = this.directoryInput(() => {
        const header = directoryHeader(value);
        const { added, removed, complete } = value;
        if (
          !Array.isArray(added) ||
          !Array.isArray(removed) ||
          typeof complete !== 'boolean' ||
          added.length + removed.length > SCREEN_DIRECTORY_PAGE_SIZE ||
          !removed.every(uuid)
        )
          throw new Error('Invalid screen directory changes.');
        return { ...header, added: added.map(share), removed, complete };
      });
      if (!page) return;
      const { epoch, revision, added, removed, complete } = page;
      if (this.directoryEpoch !== epoch) {
        this.directoryEpoch = epoch;
        this.directoryShares.clear();
        this.lastDirectory = undefined;
      }
      for (const id of removed) this.directoryShares.delete(id);
      for (const share of added) this.directoryShares.set(share.id, share);
      if (complete) {
        this.lastDirectory = { epoch, revision, shares: [...this.directoryShares.values()] };
        this.notify('directory', this.lastDirectory);
      }
    });
    this.socket.on('screen:snapshot', (value) => {
      const directory = this.directoryInput(() => {
        if (!Array.isArray(value?.links) || !Array.isArray(value.closed))
          throw new Error('Invalid screen snapshot.');
        return directoryValue(value.directory);
      });
      if (!directory) return;
      const { links, closed } = value;
      const { epoch, revision } = directory;
      for (const linkId of closed)
        this.notify('closed', { epoch, revision, linkId, reason: 'ended' });
      this.fullDirectory(directory);
      for (const grant of links) this.notify('link', { epoch, revision, grant });
    });
    this.socket.on('screen:link', (value) => this.notify('link', value));
    this.socket.on('screen:closed', (value) => this.notify('closed', value));
    this.socket.on('screen:signal', (value) => this.notify('signal', value));
    this.socket.on('disconnect', () => this.notify('disconnect', undefined));
  }
  private directoryInput<T>(parse: () => T) {
    try {
      return parse();
    } catch (cause) {
      this.lastDirectory = undefined;
      this.directoryShares.clear();
      this.notify('disconnect', cause);
      runInBackground(this.retire());
    }
  }
  private fullDirectory(value: ScreenDirectory) {
    this.directoryEpoch = value.epoch;
    this.directoryShares = new Map(value.shares.map((share) => [share.id, share]));
    this.lastDirectory = value;
    this.notify('directory', value);
  }
  private async readDirectory(value: ScreenDirectoryReply, signal?: AbortSignal) {
    if (this.retired || signal?.aborted || !this.socket.connected)
      throw new Error('Screen connection ended.');
    if (!('streamed' in value)) return value;
    directoryHeader(value);
    if (value.streamed !== true) throw new Error('Invalid screen directory acknowledgement.');
    const ready = () =>
      this.lastDirectory?.epoch === value.epoch && this.lastDirectory.revision >= value.revision;
    if (ready()) return this.lastDirectory!;
    const lifetime = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    return new Promise<ScreenDirectory>((resolve, reject) => {
      const stop = () => {
        cleanup();
        reject(new Error('Screen directory transfer ended.'));
      };
      const remove = this.subscribe((event, data) => {
        if (
          event === 'disconnect' ||
          (event === 'closed' && (data as ScreenClosed).linkId === null)
        )
          stop();
        else if (event === 'directory' && ready()) {
          cleanup();
          resolve(this.lastDirectory!);
        }
      });
      const timer = setTimeout(stop, 45000);
      const cleanup = () => {
        clearTimeout(timer);
        remove();
        lifetime.removeEventListener('abort', stop);
      };
      lifetime.addEventListener('abort', stop, { once: true });
    });
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
    if (event === 'screen:directory')
      return this.enqueue<ScreenDirectoryReply>(event, body, signal).then((reply) =>
        this.readDirectory(reply, signal),
      ) as Promise<T>;
    return this.enqueue(event, body, signal);
  }
  private enqueue<T>(
    event: keyof ScreenClientEvents,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.retired || !this.socket.connected || signal?.aborted)
      return Promise.reject(new Error('Screen connection is unavailable.'));
    // Reserve the last queue slot for the lease that authorizes every peer.
    const queueLimit = event === 'screen:renew' ? maxQueued : maxQueued - 1;
    if (this.commands.length >= queueLimit)
      return Promise.reject(new Error('Screen connection is busy.'));
    let request: unknown;
    try {
      request = structuredClone(body);
    } catch (cause) {
      return Promise.reject(new Error('Invalid screen command body.', { cause }));
    }
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let retries = 0;
      const selection = event === 'screen:select';
      const retryUntil = Date.now() + 8000;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        reject(new Error('Screen request cancelled.'));
        if (!started) {
          const index = this.commands.indexOf(task);
          if (index >= 0) this.commands.splice(index, 1);
          cleanup();
          runInBackground(this.pumpCommands());
        }
      };
      const queueTimeout = () =>
        setTimeout(() => {
          const index = this.commands.indexOf(task);
          if (index >= 0) this.commands.splice(index, 1);
          cleanup();
          reject(Object.assign(new Error('Screen request queue timed out.'), { code: 'timeout' }));
          runInBackground(this.pumpCommands());
        }, 4000);
      let timer = queueTimeout();
      const task: ScreenCommand = {
        event,
        cancel,
        run: async () => {
          started = true;
          clearTimeout(timer);
          try {
            if (this.retired || !this.socket.connected || signal?.aborted)
              throw new Error('Screen connection is unavailable.');
            // One command plus the server's snapshot refresh fits the existing two-request account budget.
            const emit = this.socket.timeout(4000).emitWithAck.bind(this.socket.timeout(4000)) as (
              event: keyof ScreenClientEvents,
              body: unknown,
            ) => Promise<ScreenAck<T>>;
            if (selection) this.selectionReadyAt = Date.now() + 250;
            const ack = await this.track(emit(event, request));
            if (this.retired || signal?.aborted) throw new Error('Screen request ended.');
            if (!ack || typeof ack !== 'object' || typeof ack.ok !== 'boolean')
              throw new Error('Invalid screen acknowledgement.');
            if (!ack.ok) {
              // A throttled acknowledgement confirms that this attempt can be
              // retried. An ambiguous timeout must never replay a mutation.
              if (selection && ack.code === 'throttled' && retries < 2) {
                const hint = Number.isFinite(ack.retryAfterMs) ? ack.retryAfterMs! : 1000;
                const delay =
                  Math.max(1000, Math.min(2000, hint)) +
                  retries * 500 +
                  Math.floor(Math.random() * 250);
                if (Date.now() + delay < retryUntil && this.commands.length < queueLimit) {
                  retries++;
                  this.selectionReadyAt = Date.now() + delay;
                  started = false;
                  timer = queueTimeout();
                  this.commands.unshift(task);
                  return;
                }
              }
              throw Object.assign(new Error(ack.error || 'Screen request rejected.'), {
                code: ack.code,
              });
            }
            resolve(ack.data);
          } catch (cause) {
            if (cause instanceof Error && cause.message === 'operation has timed out')
              Object.assign(cause, { code: 'timeout' });
            reject(cause);
          } finally {
            if (started) cleanup();
          }
        },
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.commands.push(task);
      if (signal?.aborted) cancel();
      runInBackground(this.pumpCommands());
    });
  }
  private async pumpCommands() {
    if (this.commanding) return;
    clearTimeout(this.wake);
    this.wake = undefined;
    this.commanding = true;
    try {
      while (this.commands.length && !this.retired) {
        const delay = this.selectionReadyAt - Date.now();
        let index = this.commands.findIndex((task) => task.event === 'screen:renew');
        if (index < 0)
          index = delay > 0 ? this.commands.findIndex((task) => task.event !== 'screen:select') : 0;
        if (index < 0) {
          this.wake = setTimeout(() => runInBackground(this.pumpCommands()), delay);
          break;
        }
        await this.commands.splice(index, 1)[0]!.run();
      }
    } finally {
      this.commanding = false;
    }
  }
  retire = async () => {
    if (!this.retired) {
      this.retired = true;
      this.lifetime.abort();
      this.lastDirectory = undefined;
      this.directoryShares.clear();
      clearTimeout(this.wake);
      if (this.epoch && sockets.get(this.epoch) === this) sockets.delete(this.epoch);
      this.listeners.clear();
      for (const task of [...this.commands]) task.cancel();
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
