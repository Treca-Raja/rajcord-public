import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  ChatAck,
  PresenceSnapshot,
} from '@tricord/shared';
import { PRESENCE_TIMING } from '@tricord/shared';
import { identity, type Identity } from './auth/service.js';
import { PresenceService } from './presence.js';

vi.mock('./auth/service.js', () => ({ identity: vi.fn() }));

class TestSocket {
  connected = true;
  data: { token: string; auth: Identity };
  events: { event: string; payload: unknown }[] = [];
  handlers = new Map<string, (...args: never[]) => unknown>();
  constructor(
    readonly id: string,
    auth: Identity,
    private owner: TestServer,
  ) {
    this.data = { token: id, auth };
  }
  on(event: string, handler: (...args: never[]) => unknown) {
    this.handlers.set(event, handler);
  }
  emit(event: string, payload?: unknown) {
    this.events.push({ event, payload });
  }
  leave(reason = 'transport close') {
    this.connected = false;
    this.owner.sockets.sockets.delete(this.id);
    this.handlers.get('disconnect')?.(reason as never);
  }
  disconnect() {
    this.leave('server namespace disconnect');
  }
}
class TestServer {
  sockets = { sockets: new Map<string, TestSocket>() };
  connection?: (socket: TestSocket) => void;
  on(_event: string, callback: (socket: TestSocket) => void) {
    this.connection = callback;
  }
  connect(token: string, auth: Identity) {
    const socket = new TestSocket(token, auth, this);
    this.sockets.sockets.set(token, socket);
    this.connection!(socket);
    return socket;
  }
}
const auth = (id: string, status: Identity['user']['status'] = 'approved') =>
  ({
    user: { id, username: id, displayName: id, status, isOwner: false },
    sessionId: id,
    csrfToken: '',
    expiresAt: new Date(86400000),
    remember: false,
    tokenHash: '',
  }) satisfies Identity;

let io: TestServer, service: PresenceService;
let sessions: Map<string, Identity>;
let roster: { id: string; username: string; display_name: string }[];
let failed: boolean;
async function snapshot(socket: TestSocket) {
  let result: ChatAck<PresenceSnapshot> | undefined;
  socket.handlers.get('presence:snapshot')!(((value: ChatAck<PresenceSnapshot>) => {
    result = value;
  }) as never);
  await service.reconcile();
  return result!;
}
function connect(token: string, id = token, status: Identity['user']['status'] = 'approved') {
  const current = auth(id, status);
  sessions.set(token, current);
  if (status === 'approved' && !roster.some((row) => row.id === id))
    roster.push({ id, username: id, display_name: id });
  return io.connect(token, current);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  failed = false;
  sessions = new Map();
  roster = [];
  io = new TestServer();
  vi.mocked(identity).mockImplementation(async (_pool, token) => {
    if (failed) throw new Error('unavailable');
    return sessions.get(String(token)) ?? null;
  });
  const pool = {
    query: vi.fn(async () => {
      if (failed) throw new Error('unavailable');
      return { rows: roster };
    }),
  } as unknown as Pool;
  service = new PresenceService(
    pool,
    io as unknown as Server<ClientToServerEvents, ServerToClientEvents>,
  );
});
afterEach(async () => {
  await service.close();
  vi.useRealTimers();
});

describe('authoritative ephemeral presence', () => {
  it('counts ten accounts once across multiple connections, including background clients', async () => {
    const sockets = Array.from({ length: 10 }, (_, n) => [
      connect('tab' + n, 'user' + n),
      connect('desktop' + n, 'user' + n),
    ]).flat();
    const result = await snapshot(sockets[0]!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.onlineIds).toEqual(Array.from({ length: 10 }, (_, n) => 'user' + n));
    // There are no reading/focus/voice inputs. Duplicated sockets cause no additional status changes.
    for (const socket of sockets)
      expect(socket.events.filter((event) => event.event === 'presence:changed')).toHaveLength(1);
    sockets[0]!.leave();
    const again = await snapshot(sockets[1]!);
    expect(again).toEqual(result);
  });

  it('uses bounded grace, cancels it on reconnection, and ignores stale old disconnects', async () => {
    const viewer = connect('viewer');
    const old = connect('old', 'member');
    await service.reconcile();
    old.leave();
    await service.reconcile();
    await vi.advanceTimersByTimeAsync(PRESENCE_TIMING.reconnectGraceMs - 1);
    expect(await snapshot(viewer)).toMatchObject({
      ok: true,
      data: { onlineIds: ['member', 'viewer'] },
    });
    const replacement = connect('new', 'member');
    await service.reconcile();
    await vi.advanceTimersByTimeAsync(1);
    expect(await snapshot(viewer)).toMatchObject({
      ok: true,
      data: { onlineIds: ['member', 'viewer'] },
    });
    replacement.leave();
    await service.reconcile();
    await vi.advanceTimersByTimeAsync(PRESENCE_TIMING.reconnectGraceMs);
    expect(await snapshot(viewer)).toMatchObject({ ok: true, data: { onlineIds: ['viewer'] } });
    replacement.handlers.get('disconnect')?.('transport close' as never);
    expect(await snapshot(viewer)).toMatchObject({ ok: true, data: { onlineIds: ['viewer'] } });
  });

  it('server logout has no grace and one revoked session cannot remove another valid session', async () => {
    const viewer = connect('viewer');
    const tab = connect('tab', 'member');
    const other = connect('other', 'member');
    await service.reconcile();
    sessions.delete('tab');
    tab.disconnect();
    expect(await snapshot(viewer)).toMatchObject({
      ok: true,
      data: { onlineIds: ['member', 'viewer'] },
    });
    sessions.delete('other');
    other.disconnect();
    expect(await snapshot(viewer)).toMatchObject({ ok: true, data: { onlineIds: ['viewer'] } });
  });

  it('revocation during network grace removes presence immediately when known', async () => {
    const viewer = connect('viewer');
    const member = connect('member');
    await service.reconcile();
    member.leave();
    await service.reconcile();
    sessions.delete('member');
    expect(await snapshot(viewer)).toMatchObject({ ok: true, data: { onlineIds: ['viewer'] } });
  });

  it('pending users cannot snapshot or receive presence, and revoked recipients stop receiving deltas', async () => {
    const pending = connect('pending', 'pending', 'pending');
    const viewer = connect('viewer');
    expect(await snapshot(pending)).toMatchObject({ ok: false, status: 403 });
    expect(pending.events).toHaveLength(0);
    sessions.delete('viewer');
    connect('new');
    await service.reconcile();
    const deliveries = viewer.events.length;
    connect('next');
    await service.reconcile();
    expect(viewer.connected).toBe(false);
    expect(viewer.events).toHaveLength(deliveries);
  });

  it('database failure signals unavailable instead of fabricated offline; recovery changes epoch', async () => {
    const viewer = connect('viewer');
    const before = await snapshot(viewer);
    failed = true;
    expect(await snapshot(viewer)).toMatchObject({ ok: false, status: 503 });
    expect(viewer.events.at(-1)?.event).toBe('presence:unavailable');
    failed = false;
    const after = await snapshot(viewer);
    expect(after).toMatchObject({ ok: true, data: { onlineIds: ['viewer'] } });
    if (before.ok && after.ok) expect(after.data.epoch).not.toBe(before.data.epoch);
  });

  it('snapshots serialize with revisions and request budgets reject excess without removing eligibility', async () => {
    const viewer = connect('viewer');
    const first = await snapshot(viewer);
    connect('next');
    const second = await snapshot(viewer);
    if (first.ok && second.ok) expect(second.data.revision).toBeGreaterThan(first.data.revision);
    for (let n = 0; n < 10; n++) expect((await snapshot(viewer)).ok).toBe(true);
    expect(await snapshot(viewer)).toMatchObject({ ok: false, status: 429 });
    expect(viewer.connected).toBe(true);
  });
});

it('revalidates a recipient again at delivery even if it passed source validation', async () => {
  const viewer = connect('viewer');
  await service.reconcile();
  const before = viewer.events.length;
  let validations = 0;
  vi.mocked(identity).mockImplementation(async (_pool, token) => {
    if (token === 'viewer' && ++validations === 2) sessions.delete('viewer');
    return sessions.get(String(token)) ?? null;
  });
  connect('other');
  await service.reconcile();
  expect(viewer.connected).toBe(false);
  expect(viewer.events).toHaveLength(before);
});

it('shutdown cannot publish a stale delta after a queued identity lookup completes', async () => {
  const viewer = connect('viewer');
  await service.reconcile();
  const before = viewer.events.length;
  let resolve!: (value: Identity) => void;
  const pending = new Promise<Identity>((done) => {
    resolve = done;
  });
  vi.mocked(identity).mockImplementationOnce(() => pending);
  connect('other');
  await Promise.resolve();
  const closing = service.close();
  resolve(auth('viewer'));
  await closing;
  expect(viewer.events).toHaveLength(before);
});

it('shutdown cannot acknowledge a delayed snapshot as fresh', async () => {
  const viewer = connect('viewer');
  await service.reconcile();
  let resolve!: (value: Identity) => void;
  const pending = new Promise<Identity>((done) => {
    resolve = done;
  });
  vi.mocked(identity).mockImplementationOnce(() => pending);
  const ack = vi.fn();
  viewer.handlers.get('presence:snapshot')!(ack as never);
  await Promise.resolve();
  const closing = service.close();
  resolve(auth('viewer'));
  await closing;
  expect(ack).not.toHaveBeenCalled();
});

it('shutdown during recipient revalidation cannot deliver the already prepared delta', async () => {
  const viewer = connect('viewer');
  await service.reconcile();
  const before = viewer.events.length;
  let resolve!: (value: Identity) => void;
  const pending = new Promise<Identity>((done) => {
    resolve = done;
  });
  let began!: () => void;
  const started = new Promise<void>((done) => {
    began = done;
  });
  let validations = 0;
  vi.mocked(identity).mockImplementation(async (_pool, token) => {
    if (token === 'viewer' && ++validations === 2) {
      began();
      return pending;
    }
    return sessions.get(String(token)) ?? null;
  });
  connect('other');
  await started;
  const closing = service.close();
  resolve(auth('viewer'));
  await closing;
  expect(viewer.events).toHaveLength(before);
});

it('a failed lookup after shutdown cannot send an error acknowledgement or uncertainty event', async () => {
  const viewer = connect('viewer');
  await service.reconcile();
  const before = viewer.events.length;
  let reject!: (error: Error) => void;
  const pending = new Promise<Identity>((_done, fail) => {
    reject = fail;
  });
  vi.mocked(identity).mockImplementationOnce(() => pending);
  const ack = vi.fn();
  viewer.handlers.get('presence:snapshot')!(ack as never);
  await Promise.resolve();
  const closing = service.close();
  reject(new Error('Fixture lookup failed during shutdown'));
  await closing;
  expect(ack).not.toHaveBeenCalled();
  expect(viewer.events).toHaveLength(before);
});

it('a disconnected requester cannot hide a database outage from remaining connected viewers', async () => {
  const viewer = connect('viewer'),
    requester = connect('requester');
  await service.reconcile();
  let reject!: (error: Error) => void;
  const pending = new Promise<Identity>((_done, fail) => {
    reject = fail;
  });
  vi.mocked(identity).mockImplementationOnce(() => pending);
  const ack = vi.fn();
  requester.handlers.get('presence:snapshot')!(ack as never);
  await Promise.resolve();
  requester.disconnect();
  reject(new Error('Fixture database unavailable'));
  await service.reconcile();
  expect(ack).not.toHaveBeenCalled();
  expect(
    viewer.events.some(
      (event) => event.event === 'presence:unavailable' && event.payload === undefined,
    ),
  ).toBe(true);
});
