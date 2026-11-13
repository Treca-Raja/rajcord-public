import type { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  ScreenAck,
  ScreenBinding,
  ScreenDirectory,
} from '@tricord/shared';
import { HttpError } from '../auth/validation.js';
import { ScreenService, ScreenError, type ScreenCaller, type ScreenSnapshot } from './service.js';
import { ScreenBudget, ScreenOutput } from './budget.js';

type ScreenSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type Connection = {
  socket: ScreenSocket;
  caller: ScreenCaller;
  epoch?: string;
  revision: number;
  links: Set<string>;
  dirty: boolean;
  refreshing: boolean;
  output: ScreenOutput;
};
function failure(error: unknown): ScreenAck<never> {
  if (error instanceof ScreenError)
    return {
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.code === 'throttled' ? { retryAfterMs: 1000 } : {}),
    };
  if (error instanceof HttpError && error.statusCode < 500)
    return {
      ok: false,
      code: error.statusCode === 400 ? 'invalid' : 'not_authorized',
      error: 'Screen request rejected.',
    };
  return { ok: false, code: 'unavailable', error: 'Screen sharing is unavailable.' };
}
export function registerScreen(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  service: ScreenService,
) {
  const budget = new ScreenBudget();
  const connections = new Map<string, Connection>();
  let scheduled = false,
    disposed = false;
  const sendSnapshot = (c: Connection, snapshot: ScreenSnapshot) => {
    if (!c.socket.connected || c.epoch !== snapshot.directory.epoch) return;
    const { directory, links } = snapshot;
    if (c.revision === directory.revision) return;
    const current = new Set(links.map((l) => l.link.id));
    const closed = [...c.links]
      .filter((id) => !current.has(id))
      .map((linkId) => ({
        epoch: c.epoch!,
        revision: directory.revision,
        linkId,
        reason: 'ended' as const,
      }));
    const notices = links.map((grant) => ({
      epoch: c.epoch!,
      revision: directory.revision,
      grant,
    }));
    if (!c.output.take(c.socket.conn.transport.writable, [...closed, directory, ...notices])) {
      c.dirty = true;
      return;
    }
    for (const notice of closed) c.socket.emit('screen:closed', notice);
    c.socket.emit('screen:directory', directory);
    for (const notice of notices) c.socket.emit('screen:link', notice);
    c.links = current;
    c.revision = directory.revision;
  };
  const refresh = async (c: Connection) => {
    if (!c.epoch || c.refreshing || !c.dirty || !c.socket.connected) return;
    let release: (() => void) | undefined;
    const epoch = c.epoch;
    try {
      release = budget.acquire(c.socket.data.auth.user.id, 'snapshot', 0);
      c.refreshing = true;
      c.dirty = false;
      await service.snapshot(c.caller, { epoch }, (snapshot) => sendSnapshot(c, snapshot));
    } catch (error) {
      if (error instanceof ScreenError && error.code === 'throttled') c.dirty = true;
      else if (c.epoch === epoch) {
        // Content-free invalidation is safe even when authorization itself is unavailable.
        const notice = {
          epoch,
          revision: c.revision + 1,
          linkId: null,
          reason: 'ended' as const,
        };
        if (c.output.take(c.socket.conn.transport.writable, [notice]))
          c.socket.emit('screen:closed', notice);
        service.disconnect(c.socket.id, epoch);
        c.epoch = undefined;
        c.links.clear();
      }
    } finally {
      release?.();
      c.refreshing = false;
    }
  };
  const schedule = () => {
    for (const c of connections.values()) if (c.epoch) c.dirty = true;
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) for (const c of connections.values()) void refresh(c);
    });
  };
  const unsubscribe = service.onChange(schedule);
  const connect = (socket: ScreenSocket) => {
    const c: Connection = {
      socket,
      caller: {
        token: socket.data.token,
        transportId: socket.id,
        isConnected: () => socket.connected && !disposed,
      },
      revision: 0,
      links: new Set(),
      dirty: false,
      refreshing: false,
      output: new ScreenOutput(),
    };
    connections.set(socket.id, c);
    const handle = async <T>(
      kind: 'control' | 'signal' | 'renew',
      data: unknown,
      ack: (response: ScreenAck<T>) => void,
      work: (reply: (result: T) => void) => Promise<T>,
    ) => {
      if (typeof ack !== 'function' || disposed) return;
      let release: (() => void) | undefined;
      try {
        const encoded = JSON.stringify(data);
        if (!encoded || Buffer.byteLength(encoded) > 15360)
          throw new HttpError(400, 'Invalid screen envelope.');
        release = budget.acquire(socket.data.auth.user.id, kind, Buffer.byteLength(encoded));
        let answered = false;
        const reply = (result: T) => {
          if (answered) return;
          answered = true;
          const response: ScreenAck<T> = { ok: true, data: result };
          if (socket.connected && c.output.take(socket.conn.transport.writable, [response]))
            ack(response);
        };
        const result = await work(reply);
        reply(result);
      } catch (error) {
        const response = failure(error);
        if (socket.connected && c.output.take(socket.conn.transport.writable, [response]))
          ack(response);
      } finally {
        release?.();
      }
    };
    socket.on(
      'screen:bind',
      (data, ack) =>
        void handle('control', data, ack, async () => {
          const binding: ScreenBinding = await service.bind(c.caller, data);
          if (!socket.connected) {
            service.disconnect(socket.id, binding.epoch);
            throw new ScreenError('stale', 409, 'Screen connection ended.');
          }
          if (c.epoch !== binding.epoch) {
            c.revision = 0;
            c.links.clear();
          }
          c.epoch = binding.epoch;
          schedule();
          return binding;
        }),
    );
    socket.on(
      'screen:publish',
      (data, ack) => void handle('control', data, ack, () => service.publish(c.caller, data)),
    );
    socket.on(
      'screen:stop',
      (data, ack) => void handle('control', data, ack, () => service.stop(c.caller, data)),
    );
    socket.on(
      'screen:select',
      (data, ack) =>
        void handle('control', data, ack, (reply) => service.select(c.caller, data, reply)),
    );
    socket.on(
      'screen:renew',
      (data, ack) =>
        void handle('renew', data, ack, (reply) => service.renew(c.caller, data, reply)),
    );
    socket.on(
      'screen:directory',
      (data, ack) =>
        void handle<ScreenDirectory>('control', data, ack, (reply) =>
          service.snapshot(c.caller, data, (snapshot) => {
            sendSnapshot(c, snapshot);
            reply(snapshot.directory);
          }),
        ),
    );
    socket.on(
      'screen:signal',
      (data, ack) =>
        void handle('signal', data, ack, () =>
          service.relay(c.caller, data, (destination, notice) => {
            const target = connections.get(destination.transportId);
            if (!target?.socket.connected || target.epoch !== destination.epoch) return false;
            if (!target.output.take(target.socket.conn.transport.writable, [notice]))
              throw new ScreenError('throttled', 429, 'Screen delivery is busy. Retry later.');
            target.socket.emit('screen:signal', notice);
            return true;
          }),
        ),
    );
    socket.once('disconnect', () => {
      connections.delete(socket.id);
      if (c.epoch) service.disconnect(socket.id, c.epoch);
    });
  };
  io.on('connection', connect);
  const timer = setInterval(schedule, 1000);
  timer.unref();
  return () => {
    disposed = true;
    clearInterval(timer);
    unsubscribe();
    io.off('connection', connect);
    for (const c of connections.values()) if (c.epoch) service.disconnect(c.socket.id, c.epoch);
    connections.clear();
  };
}
