import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { io as connect } from 'socket.io-client';
import { testDatabase } from '../db/test-database.js';
import { AuthService } from '../auth/service.js';
import { ChatService } from './service.js';
import { ChatFeatures } from './features.js';
import { hydrateMessages } from './message-data.js';
import { createApp } from '../app.js';
import { chatEmoji, type Conversation } from '@tricord/shared';

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let chat: ChatService, features: ChatFeatures, auth: AuthService;
let server: ReturnType<typeof createApp>;
type Person = { id: string; username: string; token: string; csrf: string };
let a: Person, b: Person, c: Person;
const secret = 'Features-' + randomUUID();
const origin = 'http://127.0.0.1:5173';
beforeAll(async () => {
  fixture = await testDatabase();
  auth = new AuthService(fixture.database.pool);
  chat = new ChatService(fixture.database.pool);
  features = new ChatFeatures(chat);
  const owner = await auth.bootstrap('owner_' + randomUUID().slice(0, 8), 'Owner', secret);
  const login = async (username: string): Promise<Person> => {
    const result = await auth.login({ username, password: secret, remember: true }, undefined);
    return { id: result.auth.user.id, username, token: result.token, csrf: result.auth.csrfToken };
  };
  a = await login(owner.username);
  const friend = async () => {
    const user = await auth.register({
      username: 'features_' + randomUUID().replaceAll('-', '').slice(0, 20),
      displayName: 'Same display name',
      password: secret,
    });
    await auth.changeStatus(a.token, user.id, 'approve');
    return login(user.username);
  };
  [b, c] = await Promise.all([friend(), friend()]);
  server = createApp({ databaseUrl: fixture.url, rateLimits: false });
});
afterAll(async () => {
  await server?.app.close();
  await fixture?.cleanup();
});
const channel = () => chat.create(a.token, { kind: 'channel', name: 'Features ' + randomUUID() });
const send = (
  person: Person,
  conversation: Conversation,
  body: string,
  replyToId?: string,
  clientId = randomUUID(),
) =>
  chat.send(person.token, conversation.id, { body, clientId, ...(replyToId ? { replyToId } : {}) });
const request = (
  person: Person,
  url: string,
  method: 'PUT' | 'DELETE' | 'GET' = 'GET',
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url,
    payload,
    headers: { origin, cookie: 'tricord_session=' + person.token, 'x-csrf-token': person.csrf },
  });

it('keeps replies canonical, preserves immediate targets and paginates one-level threads without marking reads', async () => {
  const conversation = await channel();
  const root = await send(a, conversation, 'Root');
  const first = await send(b, conversation, 'Reply', root.id);
  const second = await send(a, conversation, 'Reply to reply', first.id);
  const history = await chat.read(c.token, conversation.id);
  expect(history.messages.map((m) => m.id)).toEqual([root.id, first.id, second.id]);
  expect(history.messages[0]?.replyCount).toBe(2);
  expect(second.replyTo).toMatchObject({ available: true, id: first.id });
  expect(second.threadRoot).toMatchObject({ available: true, id: root.id });
  const page = await features.thread(c.token, conversation.id, second.id, { limit: 1 });
  expect(page.root?.id).toBe(root.id);
  expect(page.messages.map((m) => m.id)).toEqual([second.id]);
  expect(
    (
      await features.thread(c.token, conversation.id, first.id, {
        limit: 1,
        before: page.nextBefore,
      })
    ).messages[0]?.id,
  ).toBe(first.id);
  expect((await chat.get(c.token, conversation.id)).lastReadSeq).toBe('0');
  expect((await chat.get(c.token, conversation.id)).unreadCount).toBe(3);
});

it('includes the reply target in send idempotency without changing legacy send retries', async () => {
  const conversation = await channel(),
    root = await send(a, conversation, 'Root');
  const clientId = randomUUID();
  const first = await send(b, conversation, 'One reply', root.id, clientId);
  expect((await send(b, conversation, 'One reply', root.id, clientId)).id).toBe(first.id);
  await expect(send(b, conversation, 'One reply', first.id, clientId)).rejects.toMatchObject({
    statusCode: 409,
  });
  await expect(send(b, conversation, 'One reply', undefined, clientId)).rejects.toMatchObject({
    statusCode: 409,
  });
  const legacyId = randomUUID();
  expect((await send(a, conversation, 'Legacy', undefined, legacyId)).id).toBe(
    (await send(a, conversation, 'Legacy', undefined, legacyId)).id,
  );
  await expect(
    chat.edit(b.token, conversation.id, root.id, { body: 'Not mine' }),
  ).rejects.toMatchObject({ statusCode: 403 });
});

it('filters every ancestor, pin, count and thread item through membership periods', async () => {
  const group = await chat.create(a.token, { kind: 'group', name: 'Membership threads' });
  const root = await send(a, group, 'Hidden root');
  const invitation = await chat.invite(a.token, group.id, { userId: b.id });
  await chat.respond(b.token, invitation.id, { accept: true });
  const visible = await send(a, group, 'Visible reply', root.id);
  await features.pin(a.token, group.id, root.id, false);
  await features.pin(a.token, group.id, visible.id, false);
  const history = await chat.read(b.token, group.id);
  expect(history.messages).toHaveLength(1);
  expect(history.messages[0]).toMatchObject({
    replyTo: { available: false },
    threadRoot: { available: false },
    replyCount: 1,
  });
  expect(JSON.stringify(history)).not.toContain(root.id);
  expect(JSON.stringify(history)).not.toContain('Hidden root');
  const thread = await features.thread(b.token, group.id, visible.id, {});
  expect(thread.root).toBeNull();
  expect(thread.messages.map((m) => m.id)).toEqual([visible.id]);
  const pins = await features.pins(b.token, group.id, {});
  expect(pins.total).toBe(1);
  expect(pins.messages[0]?.id).toBe(visible.id);
  await expect(features.thread(b.token, group.id, root.id, {})).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(
    features.react(b.token, group.id, root.id, { emoji: '👍' }, false),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(features.pin(b.token, group.id, visible.id, false)).rejects.toMatchObject({
    statusCode: 403,
  });
  await chat.membership(b.token, group.id, { action: 'leave' });
  const gap = await send(a, group, 'Hidden gap', root.id);
  await expect(features.pins(b.token, group.id, {})).rejects.toMatchObject({ statusCode: 404 });
  const rejoin = await chat.invite(a.token, group.id, { userId: b.id });
  await chat.respond(b.token, rejoin.id, { accept: true });
  const after = await send(a, group, 'Visible after return', gap.id);
  const restored = await features.thread(b.token, group.id, after.id, {});
  expect(restored.messages.map((m) => m.id)).toEqual([visible.id, after.id]);
  expect(restored.messages[1]?.replyTo).toEqual({ available: false });
  expect(restored.messages[1]?.replyCount).toBe(2);
  await expect(send(b, group, 'Forged ancestor', root.id)).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(features.pins(c.token, group.id, {})).rejects.toMatchObject({ statusCode: 404 });
});

it('makes pins and own reactions idempotent under concurrency without changing unread counts', async () => {
  const conversation = await channel(),
    root = await send(a, conversation, 'React here');
  const before = await chat.get(b.token, conversation.id);
  await Promise.all(
    Array.from({ length: 8 }, () => features.pin(b.token, conversation.id, root.id, false)),
  );
  expect((await features.pins(c.token, conversation.id, {})).total).toBe(1);
  await Promise.all([
    ...Array.from({ length: 8 }, () =>
      features.react(a.token, conversation.id, root.id, { emoji: '👍' }, false),
    ),
    features.react(b.token, conversation.id, root.id, { emoji: '👍' }, false),
  ]);
  expect((await chat.one(a.token, conversation.id, root.id)).reactions).toEqual([
    { emoji: '👍', count: 2, mine: true },
  ]);
  await Promise.all(
    Array.from({ length: 4 }, () =>
      features.react(a.token, conversation.id, root.id, { emoji: '👍' }, true),
    ),
  );
  expect((await chat.one(a.token, conversation.id, root.id)).reactions).toEqual([
    { emoji: '👍', count: 1, mine: false },
  ]);
  const after = await chat.get(b.token, conversation.id);
  expect(after.unreadCount).toBe(before.unreadCount);
  expect(after.lastReadSeq).toBe(before.lastReadSeq);
  const path = '/api/conversations/' + conversation.id + '/messages/' + root.id;
  expect(
    (await request(a, path + '/reactions', 'PUT', { emoji: '👍', userId: b.id })).statusCode,
  ).toBe(400);
  expect((await request(a, path + '/reactions', 'PUT', { emoji: '<script>' })).statusCode).toBe(
    400,
  );
  expect((await request(a, path + '/pin', 'PUT', { userId: b.id })).statusCode).toBe(400);
});

it('removes stale pins, quotes, mentions and reactions on deletion without removing replies', async () => {
  const conversation = await channel(),
    root = await send(a, conversation, 'Mention @' + b.username);
  const reply = await send(b, conversation, 'My reply', root.id);
  expect(root.mentions.map((m) => m.id)).toEqual([b.id]);
  await features.pin(c.token, conversation.id, root.id, false);
  await features.react(c.token, conversation.id, root.id, { emoji: '❤️' }, false);
  const edited = await chat.edit(a.token, conversation.id, root.id, { body: 'Changed quote' });
  expect(edited.mentions).toEqual([]);
  expect((await chat.one(c.token, conversation.id, reply.id)).replyTo).toMatchObject({
    available: true,
    body: 'Changed quote',
  });
  await chat.edit(a.token, conversation.id, root.id, undefined, true);
  expect((await features.pins(c.token, conversation.id, {})).total).toBe(0);
  expect((await chat.one(c.token, conversation.id, reply.id)).replyTo).toMatchObject({
    available: true,
    body: null,
    deleted: true,
  });
  expect((await features.thread(c.token, conversation.id, reply.id, {})).root).toMatchObject({
    deleted: true,
    body: null,
    reactions: [],
    mentions: [],
  });
  expect((await chat.read(c.token, conversation.id)).messages.map((m) => m.id)).toEqual([reply.id]);
});

it('jumps to originals beyond loaded history with bounded pages and counts', async () => {
  const conversation = await channel(),
    root = await send(a, conversation, 'Old original');
  await fixture.database.pool.query(
    `INSERT INTO messages(conversation_id,author_id,client_id,request_hash,seq,change,body,created_at)
     SELECT $1,$2,gen_random_uuid(),$3,n,n,'History '||n,now()-interval '2 minutes' FROM generate_series(2,70) n`,
    [conversation.id, c.id, 'a'.repeat(64)],
  );
  await fixture.database.pool.query(
    'UPDATE conversations SET last_seq=70,last_change=70 WHERE id=$1',
    [conversation.id],
  );
  const client = await fixture.database.pool.connect();
  try {
    const rows = (
      await client.query(
        'SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id WHERE m.conversation_id=$1 ORDER BY m.seq LIMIT 50',
        [conversation.id],
      )
    ).rows;
    const query = vi.spyOn(client, 'query');
    try {
      await hydrateMessages(client, b.id, conversation, rows.slice(0, 1));
      expect(query).toHaveBeenCalledTimes(5);
      query.mockClear();
      await hydrateMessages(client, b.id, conversation, rows);
      expect(query).toHaveBeenCalledTimes(5);
    } finally {
      query.mockRestore();
    }
  } finally {
    client.release();
  }
  await fixture.database.pool.query(
    'INSERT INTO message_pins(message_id,pinned_by) SELECT id,$2 FROM messages WHERE conversation_id=$1',
    [conversation.id, a.id],
  );
  expect((await chat.read(b.token, conversation.id)).messages.some((m) => m.id === root.id)).toBe(
    false,
  );
  const context = await features.context(b.token, conversation.id, root.id, {});
  expect(context.messages[0]?.id).toBe(root.id);
  expect(context.messages.length).toBeLessThanOrEqual(50);
  expect(context.hasNewer).toBe(true);
  expect((await chat.get(b.token, conversation.id)).lastReadSeq).toBe('0');
  const pins = await features.pins(b.token, conversation.id, {});
  expect(pins.messages).toHaveLength(50);
  expect(pins.total).toBe(70);
  const older = await features.pins(b.token, conversation.id, { before: pins.nextBefore });
  expect(older.messages).toHaveLength(20);
  expect(new Set([...pins.messages, ...older.messages].map((m) => m.id)).size).toBe(70);
  for (const limit of [0, 101, 1.5])
    await expect(
      features.context(b.token, conversation.id, root.id, { limit }),
    ).rejects.toMatchObject({ statusCode: 400 });
});

it('blocks new-feature mutations on archives, preserves author edits and requires CSRF', async () => {
  const conversation = await channel(),
    root = await send(a, conversation, 'Archive original');
  const archived = await chat.update(a.token, conversation.id, {
    archived: true,
    expectedRevision: conversation.metadataRevision,
  });
  await expect(features.pin(a.token, conversation.id, root.id, false)).rejects.toMatchObject({
    statusCode: 409,
  });
  await expect(
    features.react(a.token, conversation.id, root.id, { emoji: '👍' }, false),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(send(b, conversation, 'No reply', root.id)).rejects.toMatchObject({
    statusCode: 409,
  });
  expect(
    (await chat.edit(a.token, conversation.id, root.id, { body: 'Author edit still works' })).body,
  ).toBe('Author edit still works');
  await chat.update(a.token, conversation.id, {
    archived: false,
    expectedRevision: archived.metadataRevision,
  });
  const noCsrf = await server.app.inject({
    method: 'PUT',
    url: '/api/conversations/' + conversation.id + '/messages/' + root.id + '/pin',
    headers: { origin, cookie: 'tricord_session=' + b.token },
  });
  expect(noCsrf.statusCode).toBe(403);
  await expect(send(b, await channel(), 'Wrong conversation', root.id)).rejects.toMatchObject({
    statusCode: 404,
  });
});
it('matches server mentions to exact client token boundaries and stable account IDs', async () => {
  const conversation = await channel();
  for (const body of [
    'é@' + b.username + '.test',
    '@' + b.username + 'é',
    'email@' + b.username + '.com',
    '@' + b.username + '_extra',
  ]) {
    expect((await send(c, conversation, body)).mentions).toEqual([]);
  }
  const mention = await send(c, conversation, '@' + b.username.toUpperCase() + ' @' + b.username);
  expect(mention.mentions).toEqual([{ id: b.id, username: b.username }]);
  const self = await send(b, conversation, '@' + b.username);
  expect(self.mentions).toEqual([]);
  expect((await chat.get(b.token, conversation.id)).mentionCount).toBe(1);
});
it('persists full-catalog Unicode reactions with tones, flags and joined sequences', async () => {
  const conversation = await channel();
  const root = await send(b, conversation, 'All Unicode emoji');
  for (const emoji of ['🇭🇷', '👍🏽', '👩🏽‍💻', '🫩']) {
    const result = await features.react(c.token, conversation.id, root.id, { emoji }, false);
    expect(result.reactions).toContainEqual({ emoji, count: 1, mine: true });
    await features.react(c.token, conversation.id, root.id, { emoji }, false);
  }
  expect((await chat.one(c.token, conversation.id, root.id)).reactions).toHaveLength(4);
});
it('retains the previous 32-kind reaction payload bound while allowing retries and existing choices', async () => {
  const conversation = await channel();
  const root = await send(b, conversation, 'Bounded full-catalog reactions');
  await fixture.database.pool.query(
    'INSERT INTO message_reactions(message_id,user_id,emoji) SELECT $1,$2,unnest($3::text[])',
    [root.id, b.id, chatEmoji],
  );
  await expect(
    features.react(c.token, conversation.id, root.id, { emoji: '🪼' }, false),
  ).rejects.toMatchObject({ statusCode: 409 });
  await features.react(c.token, conversation.id, root.id, { emoji: '👍' }, false);
  await features.react(c.token, conversation.id, root.id, { emoji: '👍' }, false);
  expect(
    (await chat.one(c.token, conversation.id, root.id)).reactions.find(
      (reaction) => reaction.emoji === '👍',
    )?.count,
  ).toBe(2);
  await features.react(b.token, conversation.id, root.id, { emoji: chatEmoji[0] }, true);
  await features.react(c.token, conversation.id, root.id, { emoji: '🪼' }, false);
  expect((await chat.one(c.token, conversation.id, root.id)).reactions).toHaveLength(32);
});
it('reports transient delivery failures without revoking the subscribed room', async () => {
  const conversation = await channel();
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const socket = connect(address, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin, cookie: 'tricord_session=' + b.token },
    auth: { csrfToken: b.csrf },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    expect(
      await socket
        .timeout(2000)
        .emitWithAck('conversation:join', { conversationId: conversation.id }),
    ).toMatchObject({ ok: true });
    let closed = 0;
    socket.on('conversation:closed', () => closed++);
    const unavailable = new Promise<void>((resolve) => socket.once('chat:unavailable', resolve));
    const failure = vi
      .spyOn(ChatService.prototype, 'delivery')
      .mockRejectedValueOnce(Object.assign(new Error('Disposable outage'), { code: 'ECONNRESET' }));
    try {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/conversations/' + conversation.id + '/messages',
        headers: { origin, cookie: 'tricord_session=' + a.token, 'x-csrf-token': a.csrf },
        payload: { body: 'Persisted despite a delivery outage', clientId: randomUUID() },
      });
      expect(response.statusCode).toBe(200);
      await unavailable;
    } finally {
      failure.mockRestore();
    }
    await socket.timeout(2000).emitWithAck('connection:ping');
    expect(closed).toBe(0);
    const changed = new Promise<void>((resolve) => socket.once('conversation:changed', resolve));
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/conversations/' + conversation.id + '/messages',
      headers: { origin, cookie: 'tricord_session=' + a.token, 'x-csrf-token': a.csrf },
      payload: { body: 'Delivery recovered in the same room', clientId: randomUUID() },
    });
    expect(response.statusCode).toBe(200);
    await changed;
    expect(closed).toBe(0);
    expect((await chat.read(b.token, conversation.id)).messages).toHaveLength(2);
  } finally {
    socket.disconnect();
  }
});
