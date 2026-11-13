import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { testDatabase } from '../db/test-database.js';
import { AuthService, digest } from '../auth/service.js';
import { createApp } from '../app.js';
import { voiceConfig } from '../voice/config.js';
import { io as connect, type Socket } from 'socket.io-client';
import type {
  ScreenAck,
  ScreenBinding,
  ScreenShare,
  ScreenPublishGrant,
  ScreenLinkGrant,
  ScreenDirectory,
  ScreenSignalNotice,
  ScreenRenewal,
  ScreenSelectRequest,
} from '@tricord/shared';
import { screenSdp, screenIce } from './signaling-fixture.js';
import { selectionFixture } from './selection-fixture.js';

const origin = 'http://127.0.0.1:5173',
  password = randomUUID() + '-Screen';
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  server: ReturnType<typeof createApp>,
  auth: AuthService;
type Person = { id: string; token: string; csrf: string; username: string };
let owner: Person,
  publisher: Person,
  viewer: Person,
  pending: Person,
  channel: string,
  otherChannel: string;
let address: string;
const sockets: Socket[] = [];
it('requires main capture to correlate the same session and current connected screen epoch', async () => {
  const p = await socketBind(publisher),
    v = await socketBind(viewer);
  const requestId = randomUUID();
  const prepare = (epoch: string) =>
    server.app.inject({
      method: 'POST',
      url: '/api/screen/capture/prepare',
      headers: {
        origin,
        cookie: 'tricord_session=' + publisher.token,
        'x-csrf-token': publisher.csrf,
      },
      payload: { requestId, epoch, sound: 'none' },
    });
  expect((await prepare(v.binding.epoch)).statusCode).toBe(403);
  const response = await prepare(p.binding.epoch);
  expect(response.statusCode).toBe(200);
  const grant = response.json();
  expect(Object.keys(grant).sort()).toEqual(['id', 'remainingMs']);
  p.socket.disconnect();
  await vi.waitFor(async () => {
    const checked = await server.app.inject({
      method: 'POST',
      url: '/api/screen/capture/consume',
      headers: {
        origin,
        cookie: 'tricord_session=' + publisher.token,
        'x-csrf-token': publisher.csrf,
      },
      payload: { id: grant.id },
    });
    expect(checked.statusCode).toBe(403);
  });
  expect(server.voice!.leases.get(publisher.id)?.id).toBe(p.lease.id);
});
async function open(person: Person) {
  const socket = connect(address, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin, cookie: 'tricord_session=' + person.token },
    auth: { csrfToken: person.csrf },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}
async function command<T>(socket: Socket, event: string, data: unknown): Promise<T> {
  const result: ScreenAck<T> = await socket.timeout(3000).emitWithAck(event, data);
  if (!result.ok) throw new Error(result.code + ': ' + result.error);
  if (event === 'screen:publish') return (result.data as ScreenPublishGrant).share as T;
  return result.data;
}
async function socketBind(person: Person, channelId = channel) {
  const lease = await server.voice!.join(person.token, { channelId });
  const socket = await open(person);
  const directory = new Promise<ScreenDirectory>((resolve) =>
    socket.once('screen:directory', resolve),
  );
  const binding = await command<ScreenBinding>(socket, 'screen:bind', {
    version: 2,
    leaseId: lease.id,
    requestId: randomUUID(),
  });
  await directory;
  return { socket, binding, lease };
}
async function socketLinked() {
  const p = await socketBind(publisher),
    v = await socketBind(viewer);
  const share = await command<ScreenShare>(p.socket, 'screen:publish', {
    epoch: p.binding.epoch,
    requestId: randomUUID(),
    sourceGeneration: 1,
    profile: 'smooth',
    videoBitrate: 8000000,
    sound: 'system',
  });
  const linkedNotice = new Promise<{ grant: ScreenLinkGrant }>((resolve) =>
    p.socket.once('screen:link', resolve),
  );
  const grant = await command<ScreenLinkGrant>(v.socket, 'screen:select', {
    epoch: v.binding.epoch,
    requestId: randomUUID(),
    revision: 1,
    shareId: share.id,
    profile: 'smooth',
    videoBitrate: 4000000,
  });
  expect((await linkedNotice).grant.link).toEqual(grant.link);
  return { p, v, share, grant };
}
async function socketSelections() {
  const person = async () => {
    const username = 'screen_select_' + randomUUID().replaceAll('-', '').slice(0, 16),
      registered = await auth.register({ username, displayName: username, password });
    await auth.changeStatus(owner.token, registered.id, 'approve');
    return login(username);
  };
  const firstPublisher = await person(),
    selectedViewer = await person(),
    secondPublisher = await person();
  const p = await socketBind(firstPublisher),
    v = await socketBind(selectedViewer),
    q = await socketBind(secondPublisher);
  const publish = (client: typeof p) =>
    command<ScreenShare>(client.socket, 'screen:publish', {
      epoch: client.binding.epoch,
      requestId: randomUUID(),
      sourceGeneration: 1,
      profile: 'smooth',
      videoBitrate: 8000000,
      sound: 'system',
    });
  const share = await publish(p),
    other = await publish(q),
    socket = v.socket,
    send = vi.fn((request: Readonly<ScreenSelectRequest>) =>
      command<ScreenLinkGrant | null>(socket, 'screen:select', request),
    ),
    plan = selectionFixture(v.binding.epoch, send),
    a = plan.select(share.id),
    first = (await a.operation.run())!;
  send.mockClear();
  return { p, v, q, share, other, send, plan, a, first, viewer: selectedViewer };
}
async function selectedLink(socket: Socket, epoch: string) {
  const renewal = await command<ScreenRenewal>(socket, 'screen:renew', {
    epoch,
    requestId: randomUUID(),
    revision: 1,
  });
  return renewal.links.map((grant) => grant.link.id);
}
const login = async (username: string): Promise<Person> => {
  const result = await auth.login({ username, password, remember: true }, undefined);
  return { id: result.auth.user.id, token: result.token, csrf: result.auth.csrfToken, username };
};
const caller = (person: Person) => ({
  token: person.token,
  transportId: randomUUID(),
  isConnected: () => true,
});
async function bind(person: Person, channelId = channel) {
  const lease = await server.voice!.join(person.token, { channelId });
  const context = caller(person);
  const binding = await server.screen!.bind(context, {
    version: 2,
    leaseId: lease.id,
    requestId: randomUUID(),
  });
  return { context, binding, lease };
}
async function linked() {
  const p = await bind(publisher),
    v = await bind(viewer);
  const { share } = await server.screen!.publish(p.context, {
    epoch: p.binding.epoch,
    requestId: randomUUID(),
    sourceGeneration: 1,
    profile: 'smooth',
    videoBitrate: 8000000,
    sound: 'system',
  });
  const link = (await server.screen!.select(v.context, {
    epoch: v.binding.epoch,
    requestId: randomUUID(),
    revision: 1,
    shareId: share.id,
    profile: 'smooth',
    videoBitrate: 4000000,
  }))!;
  return { p, v, share, link };
}

beforeAll(async () => {
  fixture = await testDatabase();
  auth = new AuthService(fixture.database.pool);
  await auth.bootstrap('screen_owner', 'Screen owner', password);
  owner = await login('screen_owner');
  for (const username of [
    'screen_publisher',
    'screen_viewer',
    'screen_pending',
    ...Array.from({ length: 8 }, (_, i) => 'screen_burst_' + i),
  ]) {
    const person = await auth.register({ username, displayName: username, password });
    if (username !== 'screen_pending') await auth.changeStatus(owner.token, person.id, 'approve');
  }
  pending = await login('screen_pending');
  const config = voiceConfig();
  if (!config) throw new Error('Run pnpm voice:setup and pnpm voice:up.');
  server = createApp({
    databaseUrl: fixture.url,
    allowedOrigins: [origin],
    voiceConfig: { ...config, prefix: 'tricord-screen-test-' + randomUUID() + '-' },
  });
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  channel = (await server.voice!.channels(owner.token))[0]!.id;
  otherChannel = (await server.voice!.create(owner.token, { name: 'Other screen test channel' }))
    .id;
});
beforeEach(async () => {
  publisher = await login('screen_publisher');
  viewer = await login('screen_viewer');
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  vi.restoreAllMocks();
  if (server?.voice)
    for (const lease of [...server.voice.leases.values()]) await server.voice.remove(lease);
  const status = (
    await fixture.database.pool.query('SELECT status FROM users WHERE username=$1', [
      'screen_publisher',
    ])
  ).rows[0]?.status;
  if (status === 'suspended') await auth.changeStatus(owner.token, publisher.id, 'restore');
});
afterAll(async () => {
  await server?.app.close();
  if (server?.voice)
    for (const room of await server.voice.media.listRooms())
      if (room.name.startsWith(server.voice.prefix)) await server.voice.media.deleteRoom(room.name);
  await fixture?.cleanup();
});

it('binds real approved sessions and rejects pending, other-account and other-session credentials', async () => {
  const p = await bind(publisher);
  const request = { version: 2, leaseId: p.lease.id, requestId: randomUUID() };
  await expect(server.screen!.bind(caller(pending), request)).rejects.toMatchObject({
    statusCode: 403,
  });
  await expect(server.screen!.bind(caller(viewer), request)).rejects.toMatchObject({
    statusCode: 401,
  });
  const device = await login(publisher.username);
  await expect(server.screen!.bind(caller(device), request)).rejects.toMatchObject({
    statusCode: 401,
  });
  expect((await server.screen!.bind(p.context, request)).epoch).toBe(p.binding.epoch);
});

it('authorizes both real leases without extending voice and rejects cross-channel selection', async () => {
  const peers = await linked();
  expect(peers.link.link.videoBitrate).toBe(4000000);
  expect(JSON.stringify(peers.link)).not.toMatch(/token|credential|sessionId|leaseId|sourceName/);
  const stranger = await bind(owner, otherChannel);
  await expect(
    server.screen!.select(stranger.context, {
      epoch: stranger.binding.epoch,
      requestId: randomUUID(),
      revision: 1,
      shareId: peers.share.id,
      profile: 'auto',
      videoBitrate: null,
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  const before = server.voice!.leases.get(publisher.id)!.expires;
  await server.screen!.renew(peers.p.context, {
    epoch: peers.p.binding.epoch,
    requestId: randomUUID(),
    revision: 1,
  });
  expect(server.voice!.leases.get(publisher.id)!.expires).toBe(before);
  expect(
    (
      await server.screen!.authorizeLink(peers.v.context, {
        epoch: peers.v.binding.epoch,
        linkId: peers.link.link.id,
      })
    ).remainingMs,
  ).toBeGreaterThan(0);
});

it.each(['publisher', 'viewer'] as const)(
  'rejects revoked %s sessions without waiting for the voice sweep',
  async (role) => {
    const peers = await linked();
    const target = role === 'publisher' ? publisher : viewer;
    await fixture.database.pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [
      digest(target.token),
    ]);
    const other = role === 'publisher' ? peers.v : peers.p;
    await expect(
      server.screen!.authorizeLink(other.context, {
        epoch: other.binding.epoch,
        linkId: peers.link.link.id,
      }),
    ).rejects.toMatchObject({ code: 'not_authorized' });
  },
);

it('rejects suspension immediately and invalidates grants during voice reconciliation', async () => {
  const peers = await linked();
  await auth.changeStatus(owner.token, publisher.id, 'suspend');
  await expect(
    server.screen!.renew(peers.v.context, {
      epoch: peers.v.binding.epoch,
      requestId: randomUUID(),
      revision: 1,
    }),
  ).rejects.toMatchObject({ code: 'not_authorized' });
  await server.voice!.reconcile();
  expect(server.voice!.leases.has(publisher.id)).toBe(false);
});

it('routes the application authorization-failure boundary through synchronous invalidation', async () => {
  const peers = await linked();
  const closed = vi.fn();
  server.voice!.leases.get(publisher.id)!.close = closed;
  vi.spyOn(server.voice!, 'reconcile').mockRejectedValue(new Error('Test authorization outage'));
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { origin, cookie: 'tricord_session=' + owner.token, 'x-csrf-token': owner.csrf },
  });
  expect(response.statusCode).toBe(200);
  expect(closed).toHaveBeenCalled();
  expect(server.voice!.leases.get(publisher.id)!.revoked).toBe(true);
  await expect(
    server.screen!.authorizeLink(peers.v.context, {
      epoch: peers.v.binding.epoch,
      linkId: peers.link.link.id,
    }),
  ).rejects.toMatchObject({ code: 'stale' });
  owner = await login(owner.username);
});

it('keeps screen HTTP routes absent; signaling uses authenticated sockets', async () => {
  const peers = await linked();
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/screen/publish',
    headers: {
      origin,
      cookie: 'tricord_session=' + publisher.token,
      'x-csrf-token': publisher.csrf,
    },
    payload: { epoch: peers.p.binding.epoch },
  });
  expect(response.statusCode).toBe(404);
});

it('delivers authorized directories, links, signaling and close notices over the real socket boundary', async () => {
  const { p, v, share, grant } = await socketLinked();
  const notice = await command<ScreenDirectory>(v.socket, 'screen:directory', {
    epoch: v.binding.epoch,
  });
  expect(notice.shares).toEqual([share]);
  const outsider = await socketBind(owner, otherChannel);
  expect(
    (
      await command<ScreenDirectory>(outsider.socket, 'screen:directory', {
        epoch: outsider.binding.epoch,
      })
    ).shares,
  ).toEqual([]);
  const received: ScreenSignalNotice[] = [];
  v.socket.on('screen:signal', (value) => received.push(value));
  const request = {
    epoch: p.binding.epoch,
    linkId: grant.link.id,
    revision: 1,
    sequence: 1,
    payload: { type: 'offer', sdp: screenSdp('offer') },
  };
  await command(p.socket, 'screen:signal', request);
  expect(received).toEqual([{ ...request, epoch: v.binding.epoch }]);
  expect(await p.socket.timeout(3000).emitWithAck('screen:signal', request)).toMatchObject({
    ok: false,
    code: 'stale',
  });
  expect(
    await outsider.socket
      .timeout(3000)
      .emitWithAck('screen:signal', { ...request, epoch: outsider.binding.epoch }),
  ).toMatchObject({ ok: false, code: 'not_authorized' });
  expect(received).toHaveLength(1);
  const closed = new Promise<unknown>((resolve) => v.socket.once('screen:closed', resolve));
  await command(p.socket, 'screen:stop', { epoch: p.binding.epoch, shareId: share.id });
  expect(await closed).toMatchObject({
    epoch: v.binding.epoch,
    linkId: grant.link.id,
    reason: 'ended',
  });
});

it.each(['cleanup-first', 'replacement-first'] as const)(
  'keeps real socket selection B when captured A cleanup arrives %s',
  async (order) => {
    const f = await socketSelections(),
      cleanup = f.a.reserveCleanup()!;
    expect(f.send).not.toHaveBeenCalled();
    expect(f.a.reserveCleanup()).toBe(cleanup);
    expect(cleanup.request.revision).toBe(2);
    if (order === 'cleanup-first') {
      expect(await cleanup.run()).toBeNull();
      expect(await cleanup.run()).toBeNull();
    }
    const b = f.plan.select(f.other.id),
      next = (await b.operation.run())!;
    expect(next.link.selectionRevision).toBe(3);
    const sends = f.send.mock.calls.length;
    for (let i = 0; i < 10; i++) expect(f.a.reserveCleanup()).toBeNull();
    expect(f.send).toHaveBeenCalledTimes(sends);
    await expect(cleanup.run()).rejects.toThrow(/^stale:/);
    await expect(cleanup.run()).rejects.toThrow(/^stale:/);
    expect(f.send.mock.calls.at(-1)![0]).toBe(cleanup.request);
    expect(b.reserveCleanup()!.request.revision).toBe(4);
    expect(await selectedLink(f.v.socket, f.v.binding.epoch)).toEqual([next.link.id]);
    expect(server.voice!.leases.get(f.viewer.id)?.id).toBe(f.v.lease.id);
  },
);

it.each(['epoch', 'lease', 'session'] as const)(
  'rejects captured old socket cleanup after real %s replacement without clearing B',
  async (kind) => {
    const f = await socketSelections(),
      cleanup = f.a.reserveCleanup()!;
    let socket = f.v.socket,
      lease = f.v.lease;
    if (kind === 'epoch') server.screen!.disconnect(socket.id!, f.v.binding.epoch);
    else {
      await server.voice!.leave(f.viewer.token, { leaseId: lease.id });
      if (kind === 'session') {
        const replacement = await login(f.viewer.username);
        expect(replacement.id).toBe(f.viewer.id);
        expect(replacement.token === f.viewer.token).toBe(false);
        const next = await socketBind(replacement);
        socket = next.socket;
        lease = next.lease;
      } else lease = await server.voice!.join(f.viewer.token, { channelId: channel });
    }
    const binding = await command<ScreenBinding>(socket, 'screen:bind', {
      version: 2,
      leaseId: lease.id,
      requestId: randomUUID(),
    });
    expect(binding.epoch).not.toBe(f.v.binding.epoch);
    const plan = selectionFixture(binding.epoch, (request) =>
        command<ScreenLinkGrant | null>(socket, 'screen:select', request),
      ),
      b = plan.select(f.other.id),
      next = (await b.operation.run())!;
    expect(next.link.selectionRevision).toBe(1);
    expect(cleanup.request).toMatchObject({ epoch: f.v.binding.epoch, revision: 2 });
    await expect(cleanup.run()).rejects.toThrow(/^stale:/);
    expect(await selectedLink(socket, binding.epoch)).toEqual([next.link.id]);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(cleanup.request);
  },
);

it.each([
  ['session', false],
  ['approval', false],
  ['lease', false],
  ['expiry', false],
  ['session', true],
  ['approval', true],
] as const)(
  'does not reuse an acknowledged socket unselect after real %s loss (disconnect=%s)',
  async (loss, disconnect) => {
    const f = await socketSelections(),
      cleanup = f.a.reserveCleanup()!;
    expect(await cleanup.run()).toBeNull();
    try {
      if (loss === 'session')
        await fixture.database.pool.query(
          'UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',
          [digest(f.viewer.token)],
        );
      else if (loss === 'approval') await auth.changeStatus(owner.token, f.viewer.id, 'suspend');
      else if (loss === 'lease') server.voice!.invalidate(server.voice!.leases.get(f.viewer.id)!);
      else server.voice!.leases.get(f.viewer.id)!.expires = Date.now() - 1;
      const retry = cleanup.run();
      if (disconnect) {
        f.v.socket.disconnect();
        await expect(retry).rejects.toThrow(/^socket has been disconnected$/);
      }
      // Revocation can close the socket before its rejection acknowledgement arrives.
      await expect(retry).rejects.toSatisfy(
        (cause: unknown) =>
          cause instanceof Error &&
          (/^(not_authorized|stale):/.test(cause.message) ||
            ((loss === 'session' || loss === 'approval') &&
              cause.message === 'socket has been disconnected' &&
              !f.v.socket.connected)),
      );
      expect(f.send.mock.calls[0]![0]).toBe(cleanup.request);
      expect(f.send.mock.calls[1]![0]).toBe(cleanup.request);
    } finally {
      if (loss === 'approval') await auth.changeStatus(owner.token, f.viewer.id, 'restore');
    }
  },
);

it('rejects malformed, oversized and caller-injected packets without affecting authenticated chat/voice', async () => {
  const { p, v, grant } = await socketLinked(),
    received = vi.fn();
  v.socket.on('screen:signal', received);
  const request = {
    epoch: p.binding.epoch,
    linkId: grant.link.id,
    revision: 1,
    sequence: 1,
    payload: { type: 'offer', sdp: screenSdp('offer') },
  };
  for (const mutation of [
    { token: viewer.token },
    { transportId: v.socket.id },
    { isConnected: true },
    { payload: { type: 'offer', sdp: 'x'.repeat(14000) } },
    {
      payload: {
        type: 'ice',
        candidate: {
          ...screenIce,
          candidate: screenIce.candidate.replace('typ host', 'typ invalid'),
        },
      },
    },
    { payload: { type: 'offer', sdp: screenSdp('offer').replace('m=video', 'm=application') } },
  ])
    expect(
      await p.socket.timeout(3000).emitWithAck('screen:signal', { ...request, ...mutation }),
    ).toMatchObject({ ok: false, code: 'invalid' });
  expect(received).not.toHaveBeenCalled();
  expect(await p.socket.timeout(3000).emitWithAck('connection:ping')).toEqual({ ok: true });
  expect(server.voice!.leases.get(publisher.id)?.revoked).toBe(false);
  await command(p.socket, 'screen:signal', request);
  expect(received).toHaveBeenCalledTimes(1);
});

it.each(['publisher', 'viewer'] as const)(
  'does not relay after real %s revocation, even with an existing link DTO',
  async (role) => {
    const { p, v, grant } = await socketLinked(),
      received = vi.fn();
    v.socket.on('screen:signal', received);
    await fixture.database.pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [
      digest((role === 'publisher' ? publisher : viewer).token),
    ]);
    const result = await p.socket.timeout(3000).emitWithAck('screen:signal', {
      epoch: p.binding.epoch,
      linkId: grant.link.id,
      revision: 1,
      sequence: 1,
      payload: { type: 'offer', sdp: screenSdp('offer') },
    });
    expect(result.ok).toBe(false);
    expect(received).not.toHaveBeenCalled();
  },
);

it('bounds unresolved authorization before enqueueing work and fences a disconnected recipient', async () => {
  const { p, v, grant } = await socketLinked();
  let resolve!: () => void, entered!: () => void;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const original = server.voice!.authorize.bind(server.voice!);
  let calls = 0;
  vi.spyOn(server.voice!, 'authorize').mockImplementation(async (...args) => {
    if (args[0] === publisher.token) {
      calls++;
      entered();
      await gate;
    }
    return original(...args);
  });
  const received = vi.fn();
  v.socket.on('screen:signal', received);
  const request = {
    epoch: p.binding.epoch,
    linkId: grant.link.id,
    revision: 1,
    sequence: 1,
    payload: { type: 'offer', sdp: screenSdp('offer') },
  };
  const requests = Array.from({ length: 6 }, (_, i) =>
    p.socket.timeout(5000).emitWithAck('screen:signal', { ...request, sequence: i + 1 }),
  );
  try {
    await started;
    const rejected = await Promise.race(requests);
    expect(rejected).toMatchObject({ ok: false, code: 'throttled' });
    expect(calls).toBe(1);
    const disconnectedId = v.socket.id;
    v.socket.disconnect();
    await vi.waitFor(() =>
      expect([...server.io.sockets.sockets.values()].some((s) => s.id === disconnectedId)).toBe(
        false,
      ),
    );
  } finally {
    resolve();
  }
  const results = await Promise.all(requests);
  expect(results.every((result) => !result.ok)).toBe(true);
  expect(received).not.toHaveBeenCalled();
  expect(await p.socket.timeout(3000).emitWithAck('connection:ping')).toEqual({ ok: true });
});

it('handles ten authenticated clients and 1280 direct-candidate relays with production screen budgets enabled', async () => {
  const people = [
    publisher,
    viewer,
    ...(await Promise.all(Array.from({ length: 8 }, (_, i) => login('screen_burst_' + i)))),
  ];
  const clients = [];
  for (const person of people) {
    await open(person); // Main application socket remains independent of its screen transport.
    clients.push(await socketBind(person));
  }
  const shares: ScreenShare[] = [];
  for (const client of clients)
    shares.push(
      await command(client.socket, 'screen:publish', {
        epoch: client.binding.epoch,
        requestId: randomUUID(),
        sourceGeneration: 1,
        profile: 'smooth',
        videoBitrate: 8000000,
        sound: 'system',
      }),
    );
  const links: ScreenLinkGrant[] = [];
  for (let i = 0; i < 10; i++)
    links.push(
      await command(clients[i]!.socket, 'screen:select', {
        epoch: clients[i]!.binding.epoch,
        requestId: randomUUID(),
        revision: 1,
        shareId: shares[(i + 1) % 10]!.id,
        profile: 'smooth',
        videoBitrate: 4000000,
      }),
    );
  const received = Array.from({ length: 10 }, () => 0);
  clients.forEach((client, i) => client.socket.on('screen:signal', () => received[i]!++));
  for (let i = 0; i < 10; i++) {
    const pub = clients[(i + 1) % 10]!,
      view = clients[i]!,
      link = links[i]!.link;
    await command(pub.socket, 'screen:signal', {
      epoch: pub.binding.epoch,
      linkId: link.id,
      revision: 1,
      sequence: 1,
      payload: { type: 'offer', sdp: screenSdp('offer') },
    });
    await command(view.socket, 'screen:signal', {
      epoch: view.binding.epoch,
      linkId: link.id,
      revision: 1,
      sequence: 1,
      payload: { type: 'answer', sdp: screenSdp('answer') },
    });
  }
  const loop = monitorEventLoopDelay({ resolution: 10 }),
    started = performance.now();
  loop.enable();
  let healthMs = 0;
  try {
    for (let sequence = 2; sequence <= 129; sequence++) {
      const packets = links.map((grant, i) => {
        const pub = clients[(i + 1) % 10]!;
        return command(pub.socket, 'screen:signal', {
          epoch: pub.binding.epoch,
          linkId: grant.link.id,
          revision: 1,
          sequence,
          payload: { type: 'ice', candidate: screenIce },
        });
      });
      if (sequence % 16 === 0) {
        const at = performance.now();
        expect((await server.app.inject('/health')).statusCode).toBe(200);
        healthMs = Math.max(healthMs, performance.now() - at);
        await server.voice!.heartbeat(publisher.token, { leaseId: clients[0]!.lease.id });
      }
      await Promise.all(packets);
    }
    process.stdout.write(
      JSON.stringify({
        screenCandidateRelays: 1280,
        elapsedMs: Math.round(performance.now() - started),
        healthMaxMs: Math.round(healthMs),
        eventLoopP95Ms: Math.round(loop.percentile(95) / 1e6),
      }) + '\n',
    );
  } finally {
    loop.disable();
  }
  expect(received).toEqual(Array(10).fill(130));
  expect(
    (
      await command<ScreenDirectory>(clients[0]!.socket, 'screen:directory', {
        epoch: clients[0]!.binding.epoch,
      })
    ).shares,
  ).toHaveLength(10);
  for (const client of clients)
    expect(await client.socket.timeout(3000).emitWithAck('connection:ping')).toEqual({ ok: true });
}, 30000);

it('fences old socket epochs after rebind and stops relay immediately at lease expiry', async () => {
  const { p, v, grant } = await socketLinked();
  const oldId = v.socket.id!;
  v.socket.disconnect();
  await vi.waitFor(() => expect(server.io.sockets.sockets.has(oldId)).toBe(false));
  const replacement = await open(viewer);
  const binding = await command<ScreenBinding>(replacement, 'screen:bind', {
    version: 2,
    leaseId: v.lease.id,
    requestId: randomUUID(),
  });
  expect(binding.epoch).not.toBe(v.binding.epoch);
  server.screen!.disconnect(oldId, v.binding.epoch);
  expect(
    await replacement.timeout(3000).emitWithAck('screen:directory', { epoch: v.binding.epoch }),
  ).toMatchObject({ ok: false, code: 'stale' });
  expect(
    (await command<ScreenDirectory>(replacement, 'screen:directory', { epoch: binding.epoch }))
      .shares,
  ).toHaveLength(1);
  expect(
    await p.socket.timeout(3000).emitWithAck('screen:signal', {
      epoch: p.binding.epoch,
      linkId: grant.link.id,
      revision: 1,
      sequence: 1,
      payload: { type: 'offer', sdp: screenSdp('offer') },
    }),
  ).toMatchObject({ ok: false, code: 'not_authorized' });
  const next = await command<ScreenLinkGrant>(replacement, 'screen:select', {
    epoch: binding.epoch,
    requestId: randomUUID(),
    revision: 1,
    shareId: grant.link.shareId,
    profile: 'smooth',
    videoBitrate: null,
  });
  const received = vi.fn();
  replacement.on('screen:signal', received);
  server.voice!.leases.get(viewer.id)!.expires = Date.now() - 1;
  expect(
    (
      await p.socket.timeout(3000).emitWithAck('screen:signal', {
        epoch: p.binding.epoch,
        linkId: next.link.id,
        revision: 1,
        sequence: 2,
        payload: { type: 'offer', sdp: screenSdp('offer') },
      })
    ).ok,
  ).toBe(false);
  expect(received).not.toHaveBeenCalled();
});

it('sends a fresh directory when the same socket obtains a new epoch without directory changes', async () => {
  const p = await socketBind(publisher);
  server.screen!.disconnect(p.socket.id!, p.binding.epoch);
  const update = new Promise<ScreenDirectory>((resolve) =>
    p.socket.once('screen:directory', resolve),
  );
  const binding = await command<ScreenBinding>(p.socket, 'screen:bind', {
    version: 2,
    leaseId: p.lease.id,
    requestId: randomUUID(),
  });
  expect(binding.epoch).not.toBe(p.binding.epoch);
  expect(await update).toMatchObject({ epoch: binding.epoch, shares: [] });
});

it('bounds delivery to a stalled receiver and permits an uncommitted signal retry after drain', async () => {
  const { p, v, grant } = await socketLinked();
  const request = {
    epoch: p.binding.epoch,
    linkId: grant.link.id,
    revision: 1,
    sequence: 1,
    payload: { type: 'offer', sdp: screenSdp('offer') },
  };
  await command(p.socket, 'screen:signal', request);
  await command(v.socket, 'screen:signal', {
    ...request,
    epoch: v.binding.epoch,
    payload: { type: 'answer', sdp: screenSdp('answer') },
  });
  const backend = server.io.sockets.sockets.get(v.socket.id!)!;
  const transport = backend.conn.transport;
  await vi.waitFor(() => expect(transport.writable).toBe(true));
  const descriptor = Object.getOwnPropertyDescriptor(transport, 'writable')!;
  Object.defineProperty(transport, 'writable', {
    configurable: true,
    get: () => false,
    set: () => {},
  });
  let retrySequence = 0,
    accepted = 0;
  try {
    for (let sequence = 2; sequence <= 41; sequence++) {
      const result = await p.socket.timeout(3000).emitWithAck('screen:signal', {
        ...request,
        sequence,
        payload: { type: 'ice', candidate: screenIce },
      });
      if (!result.ok) {
        expect(result.code).toBe('throttled');
        retrySequence = sequence;
        break;
      }
      accepted++;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThanOrEqual(32);
    expect(retrySequence).toBeGreaterThan(0);
  } finally {
    Object.defineProperty(transport, 'writable', descriptor);
    transport.writable = true;
    transport.emit('ready');
  }
  await vi.waitFor(() => expect(transport.writable).toBe(true));
  await command(p.socket, 'screen:signal', {
    ...request,
    sequence: retrySequence,
    payload: { type: 'ice', candidate: screenIce },
  });
  expect(await v.socket.timeout(3000).emitWithAck('connection:ping')).toEqual({ ok: true });
});
