import type { Server, Socket } from 'socket.io';
import { SCREEN_DIRECTORY_PAGE_SIZE } from '@tricord/shared';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  ScreenAck,
  ScreenBinding,
  ScreenClosed,
  ScreenDirectory,
  ScreenDirectoryReply,
} from '@tricord/shared';
import { HttpError } from '../auth/validation.js';
import { ScreenService, ScreenError, type ScreenCaller, type ScreenSnapshot } from './service.js';
import { ScreenBudget, ScreenOutput } from './budget.js';

type ScreenSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type Connection = {
  socket: ScreenSocket;
  caller: ScreenCaller;
  epoch?: string;
  snapshotBatch: boolean;
  directoryPending: boolean;
  revision: number;
  completeRevision: number;
  links: Set<string>;
  shares: Set<string>;
  legacyOutgoing: Set<string>;
  dirty: boolean;
  refreshing: boolean;
  output: ScreenOutput;
};
type ClosedLink = ScreenClosed & { linkId: string };
const closedLink = (epoch: string, revision: number, linkId: string): ClosedLink => ({
  epoch,
  revision,
  linkId,
  reason: 'ended',
});
function emitClosed(c: Connection, notice: ClosedLink) {
  c.socket.emit('screen:closed', notice);
  c.links.delete(notice.linkId);
  c.legacyOutgoing.delete(notice.linkId);
}
function sendDirectoryChanges(c: Connection, directory: ScreenDirectory) {
  const { epoch, revision, shares } = directory;
  const current = new Set(shares.map((share) => share.id));
  const removed = [...c.shares].filter((id) => !current.has(id));
  const added = shares.filter((share) => !c.shares.has(share.id));
  // Recompute each unsent delta from a freshly authorized snapshot on every refresh.
  c.directoryPending = true;
  let addIndex = 0,
    removeIndex = 0;
  do {
    const removePage = removed.slice(removeIndex, removeIndex + SCREEN_DIRECTORY_PAGE_SIZE);
    const addPage = added.slice(
      addIndex,
      addIndex + SCREEN_DIRECTORY_PAGE_SIZE - removePage.length,
    );
    removeIndex += removePage.length;
    addIndex += addPage.length;
    const complete = addIndex === added.length && removeIndex === removed.length;
    const page = { epoch, revision, removed: removePage, added: addPage, complete };
    if (!c.output.take(false, [page])) return false;
    c.socket.emit('screen:directoryChanges', page);
    for (const id of removePage) c.shares.delete(id);
    for (const share of addPage) c.shares.add(share.id);
  } while (addIndex < added.length || removeIndex < removed.length);
  c.directoryPending = false;
  c.revision = revision;
  return true;
}
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
    refreshing = false,
    refreshOffset = 0,
    disposed = false;
  const sendSnapshot = (c: Connection, snapshot: ScreenSnapshot) => {
    if (!c.socket.connected || c.epoch !== snapshot.directory.epoch) return;
    const { directory, links } = snapshot;
    if (c.completeRevision === directory.revision) return;
    const current = new Set(links.map((l) => l.link.id));
    const closed = [...c.links]
      .filter((id) => !current.has(id))
      .map((linkId) => closedLink(directory.epoch, directory.revision, linkId));
    const added = links.filter((grant) => !c.links.has(grant.link.id));
    const notices = added.map((grant) => ({
      epoch: c.epoch!,
      revision: directory.revision,
      grant,
    }));
    const needsDirectory = c.revision !== directory.revision || c.directoryPending;
    const largeDirectory =
      c.caller.directoryChanges && directory.shares.length > SCREEN_DIRECTORY_PAGE_SIZE;
    const sendDirectory = () => {
      c.socket.emit('screen:directory', directory);
      c.shares = new Set(directory.shares.map((share) => share.id));
      c.revision = directory.revision;
      c.directoryPending = false;
    };
    const defer = () => {
      c.dirty = true;
    };
    c.output.take(c.socket.conn.transport.writable, []);
    if (
      !largeDirectory &&
      c.output.take(false, [...closed, ...(needsDirectory ? [directory] : []), ...notices])
    ) {
      for (const notice of closed) emitClosed(c, notice);
      if (needsDirectory) sendDirectory();
      for (const notice of notices) c.socket.emit('screen:link', notice);
    } else {
      if (c.snapshotBatch && !largeDirectory) {
        const batch = { directory, links: added, closed: closed.map((notice) => notice.linkId) };
        if (c.output.take(false, [batch])) {
          c.socket.emit('screen:snapshot', batch);
          for (const id of batch.closed) c.legacyOutgoing.delete(id);
          c.shares = new Set(directory.shares.map((share) => share.id));
          c.revision = c.completeRevision = directory.revision;
          c.directoryPending = false;
          c.links = current;
          return;
        }
      }
      // Preserve progress when an entire batch exceeds even a drained output window.
      for (const notice of closed) {
        if (!c.output.take(false, [notice])) return defer();
        emitClosed(c, notice);
      }
      if (needsDirectory) {
        if (largeDirectory) {
          if (!sendDirectoryChanges(c, directory)) return defer();
        } else {
          if (!c.output.take(false, [directory])) return defer();
          sendDirectory();
        }
      }
      for (const notice of notices) {
        if (!c.output.take(false, [notice])) return defer();
        c.socket.emit('screen:link', notice);
        c.links.add(notice.grant.link.id);
      }
    }
    c.links = current;
    c.completeRevision = directory.revision;
  };
  const refresh = async (c: Connection) => {
    if (!c.epoch || c.refreshing || !c.dirty || !c.socket.connected) return;
    let release: (() => void) | undefined;
    const epoch = c.epoch;
    try {
      release = budget.acquire(c.socket.data.auth.user.id, 'snapshot', 0);
      c.refreshing = true;
      c.dirty = false;
      const unchangedRevision = await service.snapshot(
        c.caller,
        { epoch },
        (snapshot) => sendSnapshot(c, snapshot),
        c.completeRevision,
        c.revision > 0 && !c.directoryPending ? c : undefined,
      );
      if (c.epoch === epoch && unchangedRevision !== null)
        c.completeRevision = Math.max(c.completeRevision, unchangedRevision);
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
        c.shares.clear();
        c.legacyOutgoing.clear();
      }
    } finally {
      release?.();
      c.refreshing = false;
    }
  };
  const refreshConnection = async (c: Connection) => {
    try {
      await refresh(c);
    } catch {
      const epoch = c.epoch;
      if (!epoch) return;
      c.epoch = undefined;
      c.dirty = false;
      c.links.clear();
      c.shares.clear();
      c.legacyOutgoing.clear();
      service.disconnect(c.socket.id, epoch);
    }
  };
  const rejectUnexpected = (work: Promise<unknown>) => {
    void work.catch(() => console.error('Screen event handler escaped its failure boundary.'));
  };
  const schedule = () => {
    for (const c of connections.values()) if (c.epoch) c.dirty = true;
    if (scheduled || disposed || refreshing) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      const wave = [...connections.values()].filter((c) => c.epoch);
      if (!wave.length) return;
      const start = refreshOffset % wave.length;
      refreshing = true;
      // Admit one directory refresh at a time so polling cannot fill the
      // shared voice authorization queue ahead of interactive commands.
      rejectUnexpected(
        (async () => {
          try {
            for (let i = 0; i < wave.length && !disposed; i++) {
              refreshOffset = (start + i) % wave.length;
              if (!budget.snapshotAvailable()) break;
              await refreshConnection(wave[refreshOffset]!);
              refreshOffset++;
            }
          } finally {
            refreshing = false;
          }
        })(),
      );
    });
  };
  const unsubscribe = service.onChange(schedule);
  const connect = (socket: ScreenSocket) => {
    const c: Connection = {
      socket,
      caller: {
        token: socket.data.token,
        transportId: socket.id,
        supportsMoreThanNineViewers: socket.handshake.auth.screenMoreThanNineViewers === true,
        renewalPages: socket.handshake.auth.screenRenewalPages === true,
        directoryChanges: socket.handshake.auth.screenDirectoryChanges === true,
        isConnected: () => socket.connected && !disposed,
      },
      snapshotBatch: socket.handshake.auth.screenSnapshotBatch === true,
      directoryPending: false,
      revision: 0,
      completeRevision: 0,
      links: new Set(),
      shares: new Set(),
      legacyOutgoing: new Set(),
      dirty: false,
      refreshing: false,
      output: new ScreenOutput(),
    };
    connections.set(socket.id, c);
    const handle = async <T>(
      kind: 'control' | 'signal' | 'renew',
      data: unknown,
      ack: (response: ScreenAck<T>) => void,
      work: (reply: (result: T, closed?: readonly ClosedLink[]) => boolean) => Promise<T>,
    ) => {
      if (typeof ack !== 'function' || disposed) return;
      let release: (() => void) | undefined;
      try {
        const encoded = JSON.stringify(data);
        if (!encoded || Buffer.byteLength(encoded) > 15360)
          throw new HttpError(400, 'Invalid screen envelope.');
        release = budget.acquire(socket.data.auth.user.id, kind, Buffer.byteLength(encoded));
        let answered = false;
        const reply = (result: T, closed: readonly ClosedLink[] = []) => {
          if (answered || !socket.connected) return false;
          answered = true;
          const response: ScreenAck<T> = { ok: true, data: result };
          if (!c.output.take(socket.conn.transport.writable, [...closed, response])) {
            if (closed.length)
              throw new ScreenError('throttled', 429, 'Screen delivery is busy. Retry later.');
            return false;
          }
          for (const notice of closed) emitClosed(c, notice);
          ack(response);
          return true;
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
    socket.on('screen:bind', (data, ack) =>
      rejectUnexpected(
        handle('control', data, ack, async () => {
          const binding: ScreenBinding = await service.bind(c.caller, data);
          if (!socket.connected) {
            service.disconnect(socket.id, binding.epoch);
            throw new ScreenError('stale', 409, 'Screen connection ended.');
          }
          if (c.epoch !== binding.epoch) {
            c.revision = 0;
            c.completeRevision = 0;
            c.directoryPending = false;
            c.links.clear();
            c.shares.clear();
            c.legacyOutgoing.clear();
          }
          c.epoch = binding.epoch;
          schedule();
          return binding;
        }),
      ),
    );
    socket.on('screen:publish', (data, ack) =>
      rejectUnexpected(handle('control', data, ack, () => service.publish(c.caller, data))),
    );
    socket.on('screen:stop', (data, ack) =>
      rejectUnexpected(handle('control', data, ack, () => service.stop(c.caller, data))),
    );
    socket.on('screen:select', (data, ack) =>
      rejectUnexpected(
        handle('control', data, ack, (reply) => service.select(c.caller, data, reply)),
      ),
    );
    socket.on('screen:renew', (data, ack) =>
      rejectUnexpected(
        handle(data?.offset === undefined ? 'renew' : 'control', data, ack, (reply) =>
          service.renew(c.caller, data, (renewal, legacy) => {
            if (!legacy) {
              reply(renewal);
              return;
            }
            // Released publishers open new peers before pruning peers absent from the grant.
            const closed = [...c.legacyOutgoing]
              .filter((id) => !legacy.outgoing.has(id))
              .map((id) => closedLink(data.epoch, legacy.revision, id));
            if (reply(renewal, closed))
              for (const { link } of renewal.links)
                if (legacy.outgoing.has(link.id)) c.legacyOutgoing.add(link.id);
          }),
        ),
      ),
    );
    socket.on('screen:directory', (data, ack) =>
      rejectUnexpected(
        handle<ScreenDirectoryReply>('control', data, ack, (reply) =>
          service.snapshot(c.caller, data, (snapshot) => {
            const directory = snapshot.directory;
            if (c.caller.directoryChanges && directory.shares.length > SCREEN_DIRECTORY_PAGE_SIZE) {
              // A request awaiting this revision also needs a completion event if a
              // superseding update restores the membership from the previous directory.
              if (c.completeRevision !== directory.revision && c.revision !== directory.revision)
                c.directoryPending = true;
              reply({
                epoch: directory.epoch,
                revision:
                  c.completeRevision === directory.revision ? c.revision : directory.revision,
                streamed: true,
              });
            } else reply(directory);
            sendSnapshot(c, snapshot);
          }),
        ),
      ),
    );
    socket.on('screen:signal', (data, ack) =>
      rejectUnexpected(
        handle('signal', data, ack, () =>
          service.relay(c.caller, data, (destination, notice) => {
            const target = connections.get(destination.transportId);
            if (!target?.socket.connected || target.epoch !== destination.epoch) return false;
            if (!target.output.take(target.socket.conn.transport.writable, [notice]))
              throw new ScreenError('throttled', 429, 'Screen delivery is busy. Retry later.');
            target.socket.emit('screen:signal', notice);
            return true;
          }),
        ),
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
