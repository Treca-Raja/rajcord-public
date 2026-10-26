import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import { testDatabase } from '../db/test-database.js';
import { createApp } from '../app.js';
import { AuthService } from '../auth/service.js';
import { ChatService } from './service.js';
import type { ChatAck, ChatMessage, Conversation, MessagePage } from '@tricord/shared';
const origin = 'http://127.0.0.1:5173',
  secret = 'Messaging-' + randomUUID();
type Person = { id: string; username: string; token: string; cookie: string; csrf: string };
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  server: ReturnType<typeof createApp>,
  address: string,
  auth: AuthService,
  chat: ChatService,
  owner: Person;
const sockets: Socket[] = [];
async function login(username: string) {
  const result = await auth.login({ username, password: secret, remember: true }, undefined);
  return {
    id: result.auth.user.id,
    username,
    token: result.token,
    cookie: 'tricord_session=' + result.token,
    csrf: result.auth.csrfToken,
  };
}
async function person(approved = true) {
  const user = await auth.register({
    username: 'msg_' + randomUUID().replaceAll('-', '').slice(0, 24),
    displayName: 'Messaging test',
    password: secret,
  });
  if (approved) await auth.changeStatus(owner.token, user.id, 'approve');
  return login(user.username);
}
async function people() {
  return Promise.all([person(), person(), person()]);
}
const request = (
  user: Person | undefined,
  url: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  payload?: unknown,
) =>
  server.app.inject({
    url,
    method,
    payload,
    headers: { origin, ...(user ? { cookie: user.cookie, 'x-csrf-token': user.csrf } : {}) },
  });
async function create(user: Person, body: unknown) {
  const res = await request(user, '/api/conversations', 'POST', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().conversation as Conversation;
}
async function channel(user: Person) {
  return create(user, { kind: 'channel', name: 'test-' + randomUUID().slice(0, 12) });
}
async function send(user: Person, c: Conversation, body = 'Hello', clientId = randomUUID()) {
  const res = await request(user, '/api/conversations/' + c.id + '/messages', 'POST', {
    body,
    clientId,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().message as ChatMessage;
}
async function history(user: Person, c: Conversation, query = '') {
  const res = await request(user, '/api/conversations/' + c.id + '/messages' + query);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as MessagePage;
}
async function invite(inviter: Person, member: Person, c: Conversation) {
  const response = await request(inviter, '/api/conversations/' + c.id + '/invitations', 'POST', {
    userId: member.id,
  });
  expect(response.statusCode).toBe(200);
  return response.json().id as string;
}
async function accept(user: Person, id: string) {
  expect((await request(user, '/api/invitations/' + id, 'POST', { accept: true })).statusCode).toBe(
    200,
  );
}
function connectSocket(user: Person) {
  const socket = connect(address, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin, cookie: user.cookie },
    auth: { csrfToken: user.csrf },
  });
  sockets.push(socket);
  return socket;
}
async function ready(socket: Socket) {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}
async function join(socket: Socket, c: Conversation) {
  await ready(socket);
  return socket.timeout(3000).emitWithAck('conversation:join', { conversationId: c.id }) as Promise<
    ChatAck<{ joined: true }>
  >;
}
beforeAll(async () => {
  fixture = await testDatabase();
  auth = new AuthService(fixture.database.pool);
  chat = new ChatService(fixture.database.pool);
  const first = await auth.bootstrap('owner_' + randomUUID().slice(0, 8), 'Owner', secret);
  owner = await login(first.username);
  server = createApp({ databaseUrl: fixture.url, rateLimits: false });
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.disconnect();
});
afterAll(async () => {
  await server?.app.close();
  await fixture?.cleanup();
});
it('creates shared channels, permits member management, and archives without destroying history', async () => {
  const [a, b] = await people(),
    c = await channel(a!);
  const message = await send(a!, c);
  expect(
    (
      await request(b, '/api/conversations/' + c.id, 'PATCH', {
        name: 'renamed-' + randomUUID().slice(0, 8),
        archived: true,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await request(b, '/api/conversations/' + c.id + '/messages', 'POST', {
        body: 'blocked',
        clientId: randomUUID(),
      })
    ).statusCode,
  ).toBe(409);
  expect((await history(b!, c)).messages[0]?.id).toBe(message.id);
  expect(
    (await request(b, '/api/conversations/' + c.id, 'PATCH', { archived: false })).statusCode,
  ).toBe(200);
});
it('persists authorship, content, timestamps and stable ordering in PostgreSQL', async () => {
  const a = await person(),
    c = await channel(a),
    first = await send(a, c, 'First'),
    second = await send(a, c, 'Second');
  expect(first.seq).toBe('1');
  expect(second.seq).toBe('2');
  expect(first.author.id).toBe(a.id);
  expect(
    (
      await fixture.database.pool.query('SELECT body,author_id FROM messages WHERE id=$1', [
        first.id,
      ])
    ).rows[0],
  ).toEqual({ body: 'First', author_id: a.id });
  expect((await history(a, c)).messages.map((m) => m.body)).toEqual(['First', 'Second']);
});
it('paginates by server order without overlap and rejects invalid cursors', async () => {
  const a = await person(),
    c = await channel(a);
  for (let i = 0; i < 7; i++) await send(a, c, String(i));
  const latest = await history(a, c, '?limit=3');
  expect(latest.messages.map((m) => m.seq)).toEqual(['5', '6', '7']);
  expect(latest.nextBefore).toBe('5');
  const older = await history(a, c, '?limit=3&before=' + latest.nextBefore);
  expect(older.messages.map((m) => m.seq)).toEqual(['2', '3', '4']);
  for (const query of [
    '?before=-1',
    '?afterChange=bad',
    '?before=1&afterChange=0',
    '?limit=101',
    '?before=999999999999999999999',
  ])
    expect((await request(a, '/api/conversations/' + c.id + '/messages' + query)).statusCode).toBe(
      400,
    );
});
it('assigns unique increasing order under concurrent sends', async () => {
  const a = await person(),
    c = await channel(a);
  const sent = await Promise.all(
    Array.from({ length: 8 }, (_, i) => send(a, c, 'Concurrent ' + i)),
  );
  expect(new Set(sent.map((m) => m.seq)).size).toBe(8);
  expect((await history(a, c)).messages.map((m) => Number(m.seq))).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
});
it('retries the same message idempotently and rejects conflicting identifier reuse', async () => {
  const a = await person(),
    c = await channel(a),
    id = randomUUID();
  const [one, two] = await Promise.all([send(a, c, 'Once', id), send(a, c, 'Once', id)]);
  expect(one.id).toBe(two.id);
  expect((await history(a, c)).messages).toHaveLength(1);
  expect(
    (
      await request(a, '/api/conversations/' + c.id + '/messages', 'POST', {
        body: 'Different',
        clientId: id,
      })
    ).statusCode,
  ).toBe(409);
});
it('creates one DM for an unordered pair, including concurrent opens', async () => {
  const [a, b] = await people();
  const [one, two] = await Promise.all([
    create(a!, { kind: 'dm', userId: b!.id }),
    create(b!, { kind: 'dm', userId: a!.id }),
  ]);
  expect(one.id).toBe(two.id);
  const message = await send(a!, one, 'Private');
  expect((await history(b!, two)).messages[0]?.id).toBe(message.id);
});
it('hides DM existence and content from unrelated members and the platform owner', async () => {
  const [a, b, outsider] = await people(),
    c = await create(a!, { kind: 'dm', userId: b!.id }),
    m = await send(a!, c, 'Private');
  for (const user of [outsider!, owner]) {
    expect(
      (await request(user, '/api/conversations'))
        .json()
        .conversations.some((x: Conversation) => x.id === c.id),
    ).toBe(false);
    for (const path of [
      '',
      '/messages',
      '/messages?before=99',
      '/messages?afterChange=0',
      '/messages/' + m.id,
    ])
      expect((await request(user, '/api/conversations/' + c.id + path)).statusCode).toBe(404);
    expect((await join(connectSocket(user), c)).ok).toBe(false);
  }
});
it('refuses contact with unapproved accounts and self DMs', async () => {
  const a = await person(),
    pending = await person(false);
  expect(
    (await request(a, '/api/conversations', 'POST', { kind: 'dm', userId: pending.id })).statusCode,
  ).toBe(404);
  expect(
    (await request(a, '/api/conversations', 'POST', { kind: 'dm', userId: a.id })).statusCode,
  ).toBe(400);
});
it('requires explicit group invitation acceptance before any history or room access', async () => {
  const [a, b] = await people(),
    c = await create(a!, { kind: 'group', name: 'Group', userIds: [b!.id] });
  const first = await send(a!, c, 'Before acceptance');
  expect((await request(b, '/api/conversations/' + c.id)).statusCode).toBe(404);
  expect(
    (await request(b, '/api/conversations/' + c.id + '/messages/' + first.id)).statusCode,
  ).toBe(404);
  expect((await join(connectSocket(b!), c)).ok).toBe(false);
  const invitations = (await request(b, '/api/invitations')).json().invitations;
  await accept(b!, invitations[0].id);
  expect((await history(b!, c)).messages).toEqual([]);
  const next = await send(a!, c, 'After joining');
  expect((await history(b!, c)).messages.map((m) => m.id)).toEqual([next.id]);
});
it('does not allow an invitation to be accepted by another user or by an unapproved invitee', async () => {
  const [a, b, other] = await people(),
    c = await create(a!, { kind: 'group', name: 'Group' }),
    id = await invite(a!, b!, c);
  expect(
    (await request(other, '/api/invitations/' + id, 'POST', { accept: true })).statusCode,
  ).toBe(404);
  await auth.changeStatus(owner.token, b!.id, 'suspend');
  expect((await request(b, '/api/invitations/' + id, 'POST', { accept: true })).statusCode).toBe(
    401,
  );
});
it('supports declining invitations without granting access', async () => {
  const [a, b] = await people(),
    c = await create(a!, { kind: 'group', name: 'Group' }),
    id = await invite(a!, b!, c);
  expect((await request(b, '/api/invitations/' + id, 'POST', { accept: false })).statusCode).toBe(
    200,
  );
  expect((await request(b, '/api/conversations/' + c.id)).statusCode).toBe(404);
  expect((await request(b, '/api/invitations/' + id, 'POST', { accept: true })).statusCode).toBe(
    404,
  );
});
it('allows existing group members to invite while reserving removal and transfer for the manager', async () => {
  const [a, b, candidate] = await people(),
    c = await create(a!, { kind: 'group', name: 'Group' });
  await accept(b!, await invite(a!, b!, c));
  await accept(candidate!, await invite(b!, candidate!, c));
  for (const user of [b!, owner])
    expect(
      (
        await request(user, '/api/conversations/' + c.id + '/membership', 'POST', {
          action: 'remove',
          userId: candidate!.id,
        })
      ).statusCode,
    ).toBe(user === owner ? 404 : 403);
  expect(
    (
      await request(b, '/api/conversations/' + c.id + '/membership', 'POST', {
        action: 'transfer',
        userId: b!.id,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await request(a, '/api/conversations/' + c.id + '/membership', 'POST', {
        action: 'transfer',
        userId: b!.id,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await request(a, '/api/conversations/' + c.id + '/membership', 'POST', {
        action: 'remove',
        userId: candidate!.id,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await request(b, '/api/conversations/' + c.id + '/membership', 'POST', {
        action: 'remove',
        userId: candidate!.id,
      })
    ).statusCode,
  ).toBe(200);
});
it('requires a manager to transfer before leaving other members behind', async () => {
  const [a, b] = await people(),
    c = await create(a!, { kind: 'group', name: 'Group' });
  await accept(b!, await invite(a!, b!, c));
  expect(
    (await request(a, '/api/conversations/' + c.id + '/membership', 'POST', { action: 'leave' }))
      .statusCode,
  ).toBe(409);
});
it('enforces membership periods across leaving, rejoining, pagination and direct lookups', async () => {
  const [a, b] = await people(),
    c = await create(a!, { kind: 'group', name: 'Periods' });
  const hiddenFirst = await send(a!, c, 'Before first join');
  await accept(b!, await invite(a!, b!, c));
  const visibleFirst = await send(a!, c, 'First period');
  const authored = await send(b!, c, 'My first period');
  expect(
    (await request(b, '/api/conversations/' + c.id + '/membership', 'POST', { action: 'leave' }))
      .statusCode,
  ).toBe(200);
  expect((await request(b, '/api/conversations/' + c.id + '/messages')).statusCode).toBe(404);
  const absent = await send(a!, c, 'During absence');
  await accept(b!, await invite(a!, b!, c));
  const later = await send(a!, c, 'Second period');
  expect((await history(b!, c)).messages.map((m) => m.id)).toEqual([
    visibleFirst.id,
    authored.id,
    later.id,
  ]);
  expect((await history(b!, c, '?before=5&limit=1')).messages.map((m) => m.id)).toEqual([
    authored.id,
  ]);
  expect((await history(b!, c, '?afterChange=0')).messages.map((m) => m.id)).toEqual([
    visibleFirst.id,
    authored.id,
    later.id,
  ]);
  for (const m of [hiddenFirst, absent])
    expect((await request(b, '/api/conversations/' + c.id + '/messages/' + m.id)).statusCode).toBe(
      404,
    );
});
it('uses message counters rather than timestamps at invitation boundaries', async () => {
  const [a, b] = await people(),
    c = await create(a!, { kind: 'group', name: 'Boundary' });
  const before = await send(a!, c);
  await accept(b!, await invite(a!, b!, c));
  const after = await send(a!, c);
  await fixture.database.pool.query(
    "UPDATE messages SET created_at='2020-01-01' WHERE conversation_id=$1",
    [c.id],
  );
  expect((await history(b!, c)).messages.map((m) => m.id)).toEqual([after.id]);
  expect(
    (await request(b, '/api/conversations/' + c.id + '/messages/' + before.id)).statusCode,
  ).toBe(404);
});
it('closes zero-message membership periods without granting subsequent messages', async () => {
  const [a, b] = await people(),
    c = await create(a!, { kind: 'group', name: 'Empty interval' });
  await accept(b!, await invite(a!, b!, c));
  await request(b, '/api/conversations/' + c.id + '/membership', 'POST', { action: 'leave' });
  await send(a!, c, 'Absent');
  await accept(b!, await invite(a!, b!, c));
  expect((await history(b!, c)).messages).toHaveLength(0);
});
it('allows only original authors to edit or delete, including against owner/admin attempts', async () => {
  const [a, b] = await people(),
    c = await channel(a!),
    m = await send(a!, c, 'Original');
  for (const user of [b!, owner])
    for (const method of ['PATCH', 'DELETE'] as const)
      expect(
        (
          await request(
            user,
            '/api/conversations/' + c.id + '/messages/' + m.id,
            method,
            method === 'PATCH' ? { body: 'Hijacked' } : undefined,
          )
        ).statusCode,
      ).toBe(403);
  const edited = await request(a, '/api/conversations/' + c.id + '/messages/' + m.id, 'PATCH', {
    body: 'Edited',
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().message.id).toBe(m.id);
  expect(edited.json().message.author.id).toBe(a!.id);
  expect(edited.json().message.seq).toBe(m.seq);
  expect(
    (await request(a, '/api/conversations/' + c.id + '/messages/' + m.id, 'DELETE')).statusCode,
  ).toBe(200);
  expect((await history(b!, c)).messages).toHaveLength(0);
  expect((await request(b, '/api/conversations/' + c.id + '/messages/' + m.id)).statusCode).toBe(
    404,
  );
  const deleted = (await history(b!, c, '?afterChange=0')).messages[0]!;
  expect(deleted.body).toBe(null);
  expect(deleted.deleted).toBe(true);
  expect(
    (await fixture.database.pool.query('SELECT body,author_id FROM messages WHERE id=$1', [m.id]))
      .rows[0],
  ).toEqual({ body: null, author_id: a!.id });
});
it('never resurrects a deleted message when retrying its original send', async () => {
  const a = await person(),
    c = await channel(a),
    key = randomUUID(),
    m = await send(a, c, 'Delete me', key);
  await request(a, '/api/conversations/' + c.id + '/messages/' + m.id, 'DELETE');
  const retry = await send(a, c, 'Delete me', key);
  expect(retry.id).toBe(m.id);
  expect(retry.body).toBe(null);
  expect((await history(a, c)).messages).toHaveLength(0);
});
it('validates messages, rejects author injection and preserves untrusted text literally', async () => {
  const a = await person(),
    c = await channel(a);
  for (const body of [
    { body: ' ', clientId: randomUUID() },
    { body: 'x'.repeat(4001), clientId: randomUUID() },
    { body: 'Hi', clientId: randomUUID(), authorId: owner.id },
    { body: 'Hi', clientId: 'bad' },
  ])
    expect(
      (await request(a, '/api/conversations/' + c.id + '/messages', 'POST', body)).statusCode,
    ).toBe(400);
  const raw = '<img src=x onerror=alert(1)> **text**';
  expect((await send(a, c, raw)).body).toBe(raw);
});
it('rejects pending, rejected, suspended and removed messaging activity', async () => {
  const active = await person(),
    c = await channel(active),
    pending = await person(false);
  expect((await request(undefined, '/api/conversations')).statusCode).toBe(401);
  for (const user of [pending]) {
    expect((await request(user, '/api/conversations')).statusCode).toBe(403);
    expect((await join(connectSocket(user), c)).ok).toBe(false);
  }
  await auth.changeStatus(owner.token, pending.id, 'reject');
  expect((await request(pending, '/api/conversations/' + c.id + '/messages')).statusCode).toBe(403);
  for (const status of ['suspend', 'remove']) {
    const user = await person();
    await auth.changeStatus(owner.token, user.id, status);
    expect(
      (
        await request(user, '/api/conversations/' + c.id + '/messages', 'POST', {
          body: 'no',
          clientId: randomUUID(),
        })
      ).statusCode,
    ).toBe(401);
  }
});
it('requires CSRF for HTTP message mutations', async () => {
  const a = await person(),
    c = await channel(a);
  expect(
    (
      await server.app.inject({
        url: '/api/conversations/' + c.id + '/messages',
        method: 'POST',
        headers: { origin, cookie: a.cookie },
        payload: { body: 'CSRF', clientId: randomUUID() },
      })
    ).statusCode,
  ).toBe(403);
});
it('delivers real-time updates between independent authenticated sessions after persistence', async () => {
  const [a, b] = await people(),
    c = await channel(a!),
    sender = connectSocket(a!),
    receiver = connectSocket(b!);
  expect((await join(sender, c)).ok).toBe(true);
  expect((await join(receiver, c)).ok).toBe(true);
  const event = new Promise<{ conversationId: string }>((resolve) =>
    receiver.once('conversation:changed', resolve),
  );
  const ack = (await sender.timeout(3000).emitWithAck('message:send', {
    conversationId: c.id,
    clientId: randomUUID(),
    body: 'Across sessions',
  })) as ChatAck<ChatMessage>;
  expect(ack.ok).toBe(true);
  if (!ack.ok) throw new Error('Expected message');
  expect(
    (await fixture.database.pool.query('SELECT id FROM messages WHERE id=$1', [ack.data.id]))
      .rowCount,
  ).toBe(1);
  expect((await event).conversationId).toBe(c.id);
  expect((await history(b!, c)).messages[0]?.body).toBe('Across sessions');
});
it('does not leak private events to an unauthorized room subscriber', async () => {
  const [a, b, other] = await people(),
    c = await create(a!, { kind: 'dm', userId: b!.id }),
    outsider = connectSocket(other!);
  expect((await join(outsider, c)).ok).toBe(false);
  let received = false;
  outsider.on('conversation:changed', () => {
    received = true;
  });
  await send(a!, c, 'Secret');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(received).toBe(false);
});
it('evicts removed group members and rechecks delivery even if a stale room exists', async () => {
  const [a, b] = await people(),
    c = await create(a!, { kind: 'group', name: 'Removal' });
  await accept(b!, await invite(a!, b!, c));
  const socket = connectSocket(b!);
  await join(socket, c);
  const closed = new Promise<void>((resolve) =>
    socket.once('conversation:closed', () => resolve()),
  );
  expect(
    (
      await request(a, '/api/conversations/' + c.id + '/membership', 'POST', {
        action: 'remove',
        userId: b!.id,
      })
    ).statusCode,
  ).toBe(200);
  await closed;
  // Deliberately recreate a stale subscription to verify rooms cannot bypass current DB authorization.
  const backend = [...server.io.sockets.sockets.values()].find(
    (s) => s.data.auth.user.id === b!.id,
  )!;
  await backend.join('conversation:' + c.id);
  let leaked = false;
  socket.on('conversation:changed', () => {
    leaked = true;
  });
  await send(a!, c, 'After removal');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(leaked).toBe(false);
});
it('disconnects a suspended account during messaging and denies further sends', async () => {
  const [a, b] = await people(),
    c = await channel(a!),
    socket = connectSocket(b!);
  await join(socket, c);
  const disconnected = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
  expect(
    (await request(owner, '/api/admin/accounts/' + b!.id, 'POST', { action: 'suspend' }))
      .statusCode,
  ).toBe(200);
  await disconnected;
  expect(socket.connected).toBe(false);
  await send(a!, c, 'After suspension');
  expect((await request(b, '/api/conversations/' + c.id + '/messages')).statusCode).toBe(401);
});
it('synchronizes missed messages, edits and deletions after reconnection without duplicates', async () => {
  const [a, b] = await people(),
    c = await channel(a!),
    old = await send(a!, c, 'Old'),
    deleted = await send(a!, c, 'Remove offline'),
    checkpoint = (await history(b!, c)).change;
  const socket = connectSocket(b!);
  await join(socket, c);
  socket.disconnect();
  const added = await send(a!, c, 'While offline');
  await request(a, '/api/conversations/' + c.id + '/messages/' + old.id, 'PATCH', {
    body: 'Changed offline',
  });
  await request(a, '/api/conversations/' + c.id + '/messages/' + deleted.id, 'DELETE');
  socket.connect();
  await join(socket, c);
  const changes = await history(b!, c, '?afterChange=' + checkpoint + '&limit=2');
  expect(changes.hasMore).toBe(true);
  const rest = await history(b!, c, '?afterChange=' + changes.change + '&limit=2');
  const all = [...changes.messages, ...rest.messages];
  expect(new Set(all.map((m) => m.id))).toEqual(new Set([old.id, deleted.id, added.id]));
  expect(all.find((m) => m.id === deleted.id)?.body).toBe(null);
  expect(all.find((m) => m.id === old.id)?.body).toBe('Changed offline');
});
it('retains messages and idempotency across backend restarts', async () => {
  const a = await person(),
    c = await channel(a),
    id = randomUUID(),
    before = await send(a, c, 'Persisted', id);
  await server.app.close();
  server = createApp({ databaseUrl: fixture.url, rateLimits: false });
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  expect((await history(a, c)).messages[0]?.id).toBe(before.id);
  expect((await send(a, c, 'Persisted', id)).id).toBe(before.id);
});
it('rate-limits new messages across transports while allowing safe retries', async () => {
  const a = await person(),
    c = await channel(a),
    key = randomUUID();
  await send(a, c, 'First', key);
  for (let i = 1; i < 30; i++)
    await chat.send(a.token, c.id, { body: 'Rate ' + i, clientId: randomUUID() });
  expect(
    (
      await request(a, '/api/conversations/' + c.id + '/messages', 'POST', {
        body: 'Too much',
        clientId: randomUUID(),
      })
    ).statusCode,
  ).toBe(429);
  const socket = connectSocket(a);
  await ready(socket);
  const ack = await socket.timeout(3000).emitWithAck('message:send', {
    conversationId: c.id,
    body: 'Too much',
    clientId: randomUUID(),
  });
  expect(ack.status).toBe(429);
  expect((await send(a, c, 'First', key)).seq).toBe('1');
});

it('does not evict a new member when an inaccessible older message is edited', async () => {
  const [a, b] = await people(),
    c = await create(a!, { kind: 'group', name: 'Historical edits' }),
    old = await send(a!, c, 'Before join');
  await accept(b!, await invite(a!, b!, c));
  const socket = connectSocket(b!);
  await join(socket, c);
  let closed = false;
  socket.on('conversation:closed', () => {
    closed = true;
  });
  expect(
    (
      await request(a, '/api/conversations/' + c.id + '/messages/' + old.id, 'PATCH', {
        body: 'Still private history',
      })
    ).statusCode,
  ).toBe(200);
  const changed = new Promise<void>((resolve) =>
    socket.once('conversation:changed', () => resolve()),
  );
  await send(a!, c, 'New visible message');
  await changed;
  expect(closed).toBe(false);
  expect((await history(b!, c)).messages.map((m) => m.body)).toEqual(['New visible message']);
});

async function summary(user: Person, c: Conversation) {
  return (await request(user, '/api/conversations/' + c.id)).json().conversation as Conversation;
}
it('persists monotonic account-scoped read cursors without marking new or own messages unread', async () => {
  const [a, b] = await people(),
    c = await channel(a!);
  await send(b!, c, 'Own message');
  const first = await send(a!, c, 'First unread');
  const second = await send(a!, c, 'Hey @' + b!.username.toUpperCase() + '!');
  expect(await summary(b!, c)).toMatchObject({ unreadCount: 2, mentionCount: 1, lastReadSeq: '0' });
  expect((await history(b!, c)).messages).toHaveLength(3);
  expect((await summary(b!, c)).unreadCount).toBe(2); // Fetching history never marks it read.
  const path = '/api/conversations/' + c.id + '/read';
  expect((await request(b, path, 'POST', { seq: first.seq })).statusCode).toBe(200);
  expect(await summary(b!, c)).toMatchObject({
    unreadCount: 1,
    mentionCount: 1,
    lastReadSeq: first.seq,
  });
  await request(b, path, 'POST', { seq: second.seq });
  await request(b, path, 'POST', { seq: first.seq });
  const anotherSession = await login(b!.username);
  expect(await summary(anotherSession, c)).toMatchObject({
    unreadCount: 0,
    mentionCount: 0,
    lastReadSeq: second.seq,
  });
  await send(a!, c, 'After reading');
  expect((await summary(anotherSession, c)).unreadCount).toBe(1);
  expect((await summary(a!, c)).unreadCount).toBe(1); // Only b's original message.
});
it('unread mentions respect token boundaries and current message edits/deletions', async () => {
  const [a, b] = await people(),
    c = await channel(a!);
  await send(a!, c, 'email@' + b!.username + '.test @' + b!.username + '_extra');
  const mention = await send(a!, c, 'Hello @' + b!.username + ' @' + b!.username);
  expect(await summary(b!, c)).toMatchObject({ unreadCount: 2, mentionCount: 1 });
  await request(a, '/api/conversations/' + c.id + '/messages/' + mention.id, 'PATCH', {
    body: 'Mention removed',
  });
  expect((await summary(b!, c)).mentionCount).toBe(0);
  await request(a, '/api/conversations/' + c.id + '/messages/' + mention.id, 'DELETE');
  expect((await summary(b!, c)).unreadCount).toBe(1);
});
it('read cursors reject missing, future or invalid values and require CSRF and approval', async () => {
  const a = await person(),
    pending = await person(false),
    c = await channel(a);
  await send(a, c);
  const path = '/api/conversations/' + c.id + '/read';
  for (const body of [
    {},
    { seq: '-1' },
    { seq: '2' },
    { seq: 1 },
    { seq: '9223372036854775808' },
    { seq: '1', userId: owner.id },
  ])
    expect((await request(a, path, 'POST', body)).statusCode).toBe(400);
  expect((await request(undefined, path, 'POST', { seq: '1' })).statusCode).toBe(401);
  expect((await request(pending, path, 'POST', { seq: '1' })).statusCode).toBe(403);
  expect(
    (
      await server.app.inject({
        url: path,
        method: 'POST',
        headers: { origin, cookie: a.cookie },
        payload: { seq: '1' },
      })
    ).statusCode,
  ).toBe(403);
  expect((await request(a, path, 'POST', { seq: '1' })).statusCode).toBe(200);
});
it('private unread counts exclude pre-join and absent membership periods and reject former members', async () => {
  const [a, b, outsider] = await people(),
    c = await create(a!, { kind: 'group', name: 'Unread boundaries' });
  const hidden = await send(a!, c, '@' + b!.username + ' before joining');
  await accept(b!, await invite(a!, b!, c));
  expect((await summary(b!, c)).unreadCount).toBe(0);
  expect(
    (await request(b, '/api/conversations/' + c.id + '/read', 'POST', { seq: hidden.seq }))
      .statusCode,
  ).toBe(404);
  await send(a!, c, '@' + b!.username + ' visible');
  expect(await summary(b!, c)).toMatchObject({ unreadCount: 1, mentionCount: 1 });
  await request(a, '/api/conversations/' + c.id + '/membership', 'POST', {
    action: 'remove',
    userId: b!.id,
  });
  await send(a!, c, '@' + b!.username + ' during absence');
  expect(
    (await request(b, '/api/conversations/' + c.id + '/read', 'POST', { seq: '2' })).statusCode,
  ).toBe(404);
  expect(
    (await request(outsider, '/api/conversations/' + c.id + '/read', 'POST', { seq: '2' }))
      .statusCode,
  ).toBe(404);
  await accept(b!, await invite(a!, b!, c));
  expect(await summary(b!, c)).toMatchObject({ unreadCount: 1, mentionCount: 1 });
});
it('delivers notices for unselected private conversations only to authorized recipients, once per message', async () => {
  const [a, b, outsider] = await people(),
    c = await create(a!, { kind: 'dm', userId: b!.id });
  const recipient = connectSocket(b!),
    stranger = connectSocket(outsider!);
  await Promise.all([ready(recipient), ready(stranger)]);
  const notices: unknown[] = [],
    leaks: unknown[] = [];
  recipient.on('message:created', (value) => notices.push(value));
  stranger.on('message:created', (value) => leaks.push(value));
  let inbox = 0;
  recipient.on('unread:changed', () => inbox++);
  const key = randomUUID();
  const first = await send(a!, c, '@' + b!.username + ' private secret', key);
  await send(a!, c, '@' + b!.username + ' private secret', key);
  await request(a, '/api/conversations/' + c.id + '/messages/' + first.id, 'PATCH', {
    body: 'edited secret',
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(notices).toEqual([
    {
      conversationId: c.id,
      messageId: first.id,
      seq: first.seq,
      authorId: a!.id,
      kind: 'dm',
      mention: true,
    },
  ]);
  expect(leaks).toEqual([]);
  expect(inbox).toBeGreaterThan(0);
  await auth.changeStatus(owner.token, b!.id, 'suspend');
  await send(a!, await channel(a!), '@' + b!.username + ' no suspended delivery');
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(notices).toHaveLength(1);
});

it('synchronizes read progress only to the same approved account across devices', async () => {
  const [a, b] = await people(),
    c = await channel(a!);
  const latest = await send(a!, c);
  const second = await login(b!.username);
  const reader = connectSocket(b!),
    otherDevice = connectSocket(second),
    bystander = connectSocket(a!);
  await Promise.all([ready(reader), ready(otherDevice), ready(bystander)]);
  let own = 0,
    remote = 0,
    unrelated = 0;
  reader.on('unread:changed', () => own++);
  otherDevice.on('unread:changed', () => remote++);
  bystander.on('unread:changed', () => unrelated++);
  await request(b, '/api/conversations/' + c.id + '/read', 'POST', { seq: latest.seq });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(own).toBe(1);
  expect(remote).toBe(1);
  expect(unrelated).toBe(0);
  expect((await summary(second, c)).unreadCount).toBe(0);
});

it('acknowledges reads for ten accounts over authenticated sockets with production budgets unchanged', async () => {
  const accounts: Person[] = [];
  for (let i = 0; i < 10; i++) accounts.push(await person());
  const c = await channel(owner),
    latest = await send(owner, c);
  const limited = createApp({ databaseUrl: fixture.url, rateLimits: true });
  const clients: Socket[] = [];
  const httpReads: string[] = [];
  limited.app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/conversations')) httpReads.push(req.url);
  });
  try {
    const endpoint = await limited.app.listen({ host: '127.0.0.1', port: 0 });
    for (const user of accounts) {
      const client = connect(endpoint, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { origin, cookie: user.cookie },
        auth: { csrfToken: user.csrf },
      });
      clients.push(client);
      await ready(client);
    }
    for (let round = 0; round < 10; round++) {
      for (const client of clients) {
        const ack = await client
          .timeout(5000)
          .emitWithAck('conversation:read', { conversationId: c.id, seq: latest.seq });
        expect(ack).toEqual({ ok: true, data: { lastReadSeq: latest.seq } });
      }
    }
    expect(httpReads).toEqual([]);
    for (const user of accounts) expect((await summary(user, c)).unreadCount).toBe(0);
    const denied = await clients[0]!
      .timeout(3000)
      .emitWithAck('conversation:read', { conversationId: c.id, seq: '999' });
    expect(denied).toMatchObject({ ok: false, status: 400 });
  } finally {
    for (const client of clients) client.disconnect();
    await limited.app.close();
  }
});
