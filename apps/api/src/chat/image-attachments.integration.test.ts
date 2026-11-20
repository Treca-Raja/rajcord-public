import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { io as connect, type Socket } from 'socket.io-client';
import type { ChatMessage, ChatImageUpload, Conversation } from '@tricord/shared';
import { testDatabase } from '../db/test-database.js';
import { createApp } from '../app.js';
import { digest } from '../auth/service.js';
import { ChatService } from './service.js';
import * as images from './image-attachment.js';

const origin = 'http://127.0.0.1:5173';
type Person = { id: string; token: string; csrf: string; cookie: string };
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  server: ReturnType<typeof createApp>,
  chat: ChatService,
  address: string;
let image: ChatImageUpload, bytes: Buffer;
const sockets: Socket[] = [];
beforeAll(async () => {
  fixture = await testDatabase();
  chat = new ChatService(fixture.database.pool);
  server = createApp({ databaseUrl: fixture.url, rateLimits: false });
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  bytes = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#4e83b2' } })
    .png()
    .toBuffer();
  image = { mimeType: 'image/png', base64: bytes.toString('base64') };
});
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await server?.app.close();
  await fixture?.cleanup();
});
async function person(status = 'approved'): Promise<Person> {
  const id = randomUUID(),
    token = randomBytes(32).toString('hex'),
    csrf = randomBytes(32).toString('hex');
  await fixture.database.pool.query(
    'INSERT INTO users(id,username,display_name,status) VALUES($1,$2,$3,$4)',
    [id, 'image_' + id.replaceAll('-', '').slice(0, 20), 'Image fixture', status],
  );
  await fixture.database.pool.query(
    "INSERT INTO sessions(user_id,token_hash,csrf_token,remember,expires_at,device_label) VALUES($1,$2,$3,false,now()+interval '1 hour','Image fixture')",
    [id, digest(token), csrf],
  );
  return { id, token, csrf, cookie: 'tricord_session=' + token };
}
function request(
  user: Person | undefined,
  url: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  payload?: unknown,
) {
  return server.app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload } : {}),
    headers: { origin, ...(user ? { cookie: user.cookie, 'x-csrf-token': user.csrf } : {}) },
  });
}
const channel = (user: Person) =>
  chat.create(user.token, { kind: 'channel', name: 'Images ' + randomUUID() });
const send = (
  user: Person,
  conversation: Conversation,
  body = '',
  clientId = randomUUID(),
  attachment = image,
  replyToId?: string,
) =>
  request(user, `/api/conversations/${conversation.id}/messages/with-attachment`, 'POST', {
    body,
    clientId,
    attachment,
    ...(replyToId ? { replyToId } : {}),
  });
const media = (
  user: Person | undefined,
  conversation: Conversation,
  message: ChatMessage,
  query = '',
) => request(user, `/media/chat-attachments/${conversation.id}/${message.id}${query}`);
async function join(manager: Person, member: Person, conversation: Conversation) {
  const invitation = await chat.invite(manager.token, conversation.id, { userId: member.id });
  await chat.respond(member.token, invitation.id, { accept: true });
}
async function socket(user: Person) {
  const result = connect(address, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin, cookie: user.cookie },
    auth: { csrfToken: user.csrf },
  });
  sockets.push(result);
  await new Promise<void>((resolve, reject) => {
    result.once('connect', resolve);
    result.once('connect_error', reject);
    result.connect();
  });
  return result;
}

it('atomically sends image-only messages, stores original bytes and exposes metadata across history and canonical lookup', async () => {
  const author = await person(),
    viewer = await person(),
    c = await channel(author);
  const response = await send(author, c);
  expect(response.statusCode, response.body).toBe(200);
  const message = response.json().message as ChatMessage;
  expect(message.body).toBe('');
  expect(message.seq).toBe('1');
  expect(message.attachment).toEqual({ mimeType: 'image/png', size: bytes.length });
  expect(Object.keys(message.attachment!).sort()).toEqual(['mimeType', 'size']);
  expect((await chat.read(viewer.token, c.id)).messages[0]!.attachment).toEqual(message.attachment);
  expect((await chat.one(viewer.token, c.id, message.id)).attachment).toEqual(message.attachment);
  const stored = await fixture.database.pool.query(
    'SELECT image,size FROM message_attachments WHERE message_id=$1',
    [message.id],
  );
  expect(stored.rows[0]).toEqual({ image: bytes, size: bytes.length });
  const fetched = await media(viewer, c, message);
  expect(fetched.statusCode).toBe(200);
  expect(fetched.rawPayload).toEqual(bytes);
  expect(fetched.headers).toMatchObject({
    'content-type': 'image/png',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  });
  const download = await media(viewer, c, message, '?download=1');
  expect(download.headers['content-disposition']).toBe(
    `attachment; filename="rajcord-image-${message.id}.png"`,
  );
  expect((await media(viewer, c, message, '?download=unsafe')).statusCode).toBe(400);
  expect((await media(undefined, c, message)).statusCode).toBe(401);
});

it('keeps concurrent retries exactly once, conflicts on changed image/body/reply and separates text-only intent hashes', async () => {
  const author = await person(),
    c = await channel(author),
    key = randomUUID();
  const [first, second] = await Promise.all([
    send(author, c, 'Screenshot', key),
    send(author, c, 'Screenshot', key),
  ]);
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  const message = first.json().message as ChatMessage;
  expect(second.json().message.id).toBe(message.id);
  expect((await chat.read(author.token, c.id)).messages).toHaveLength(1);
  expect(
    (
      await fixture.database.pool.query('SELECT 1 FROM message_attachments WHERE message_id=$1', [
        message.id,
      ])
    ).rowCount,
  ).toBe(1);
  const alternate = await sharp({
    create: { width: 20, height: 20, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  expect(
    (
      await send(author, c, 'Screenshot', key, {
        mimeType: 'image/png',
        base64: alternate.toString('base64'),
      })
    ).statusCode,
  ).toBe(409);
  expect((await send(author, c, 'Other caption', key)).statusCode).toBe(409);
  const root = await chat.send(author.token, c.id, {
    body: 'Reply target',
    clientId: randomUUID(),
  });
  expect((await send(author, c, 'Screenshot', key, image, root.id)).statusCode).toBe(409);
  const collisionKey = randomUUID();
  const collisionText = JSON.stringify([
    'image',
    '',
    null,
    image.mimeType,
    createHash('sha256').update(bytes).digest('hex'),
  ]);
  await chat.send(author.token, c.id, { body: collisionText, clientId: collisionKey });
  expect((await send(author, c, '', collisionKey)).statusCode).toBe(409);
  const reply = (await send(author, c, '', randomUUID(), image, root.id)).json()
    .message as ChatMessage;
  expect(reply.replyTo?.available && reply.replyTo.id).toBe(root.id);
});

it('preserves current membership periods for raw media, history and direct lookups', async () => {
  const manager = await person(),
    member = await person(),
    stranger = await person();
  const c = await chat.create(manager.token, { kind: 'group', name: 'Private screenshots' });
  const hidden = (await send(manager, c)).json().message as ChatMessage;
  expect((await media(member, c, hidden)).statusCode).toBe(404);
  await join(manager, member, c);
  const visible = (await send(manager, c)).json().message as ChatMessage;
  expect((await media(member, c, visible)).statusCode).toBe(200);
  expect((await media(stranger, c, visible)).statusCode).toBe(404);
  await chat.membership(member.token, c.id, { action: 'leave' });
  expect((await media(member, c, visible)).statusCode).toBe(404);
  const absent = (await send(manager, c)).json().message as ChatMessage;
  await join(manager, member, c);
  expect((await media(member, c, visible)).statusCode).toBe(200);
  for (const message of [hidden, absent])
    expect((await media(member, c, message)).statusCode).toBe(404);
  await fixture.database.pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [
    member.id,
  ]);
  expect((await media(member, c, visible)).statusCode).toBe(401);
});

it('edits only captions, clears bytes atomically on author deletion and never resurrects them on retry', async () => {
  const author = await person(),
    other = await person(),
    c = await channel(author),
    key = randomUUID();
  const message = (await send(author, c, 'Caption', key)).json().message as ChatMessage;
  expect(
    (await request(other, `/api/conversations/${c.id}/messages/${message.id}`, 'DELETE'))
      .statusCode,
  ).toBe(403);
  const edited = await chat.edit(author.token, c.id, message.id, { body: '' });
  expect(edited.attachment).toEqual(message.attachment);
  expect((await media(other, c, message)).rawPayload).toEqual(bytes);
  const deleted = await chat.edit(author.token, c.id, message.id, undefined, true);
  expect(deleted.body).toBeNull();
  expect(deleted.attachment).toBeUndefined();
  expect(
    (
      await fixture.database.pool.query('SELECT 1 FROM message_attachments WHERE message_id=$1', [
        message.id,
      ])
    ).rowCount,
  ).toBe(0);
  expect((await media(author, c, message)).statusCode).toBe(404);
  const retry = (await send(author, c, 'Caption', key)).json().message as ChatMessage;
  expect(retry.id).toBe(message.id);
  expect(retry.deleted).toBe(true);
  expect(retry.attachment).toBeUndefined();
  const plain = await chat.send(author.token, c.id, { body: 'Text', clientId: randomUUID() });
  await expect(chat.edit(author.token, c.id, plain.id, { body: '' })).rejects.toMatchObject({
    statusCode: 400,
  });
});

it('checks identity/approval/CSRF before large-body image work while retaining normal message limits', async () => {
  const author = await person(),
    pending = await person('pending'),
    c = await channel(author);
  const path = `/api/conversations/${c.id}/messages/with-attachment`;
  const payload = {
    body: '',
    clientId: randomUUID(),
    attachment: { mimeType: 'image/png', base64: 'x'.repeat(17000) },
  };
  expect((await request(undefined, path, 'POST', payload)).statusCode).toBe(401);
  expect((await request(pending, path, 'POST', payload)).statusCode).toBe(403);
  expect((await request({ ...author, csrf: 'wrong' }, path, 'POST', payload)).statusCode).toBe(403);
  expect((await request(author, path, 'POST', payload)).statusCode).toBe(400);
  expect(
    (await request(author, `/api/conversations/${c.id}/messages`, 'POST', payload)).statusCode,
  ).toBe(413);
  const noisy = await sharp(randomBytes(128 * 128 * 3), {
    raw: { width: 128, height: 128, channels: 3 },
  })
    .png()
    .toBuffer();
  expect(noisy.length).toBeGreaterThan(16384);
  expect(
    (
      await send(author, c, '', randomUUID(), {
        mimeType: 'image/png',
        base64: noisy.toString('base64'),
      })
    ).statusCode,
  ).toBe(200);
  await chat.update(author.token, c.id, { archived: true, expectedRevision: '0' });
  expect((await send(author, c)).statusCode).toBe(409);
});

it.each(['membership', 'session'] as const)(
  'decodes outside locks, then rechecks %s before committing',
  async (change) => {
    const manager = await person(),
      writer = await person();
    const c = await chat.create(manager.token, { kind: 'group', name: 'Race fixture' });
    await join(manager, writer, c);
    let decoded!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      decoded = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validate = images.validateChatImage;
    vi.spyOn(images, 'validateChatImage').mockImplementation(async (value) => {
      const checked = await validate(value);
      decoded();
      await gate;
      return checked;
    });
    const outcome = chat
      .sendWithAttachmentResult(writer.token, c.id, {
        body: '',
        clientId: randomUUID(),
        attachment: image,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    try {
      await ready;
      if (change === 'membership')
        await chat.membership(manager.token, c.id, { action: 'remove', userId: writer.id });
      else
        await fixture.database.pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [
          writer.id,
        ]);
      release();
      expect(await outcome).toMatchObject({ statusCode: change === 'membership' ? 404 : 401 });
      expect(
        (
          await fixture.database.pool.query('SELECT 1 FROM messages WHERE conversation_id=$1', [
            c.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect((await chat.get(manager.token, c.id)).activity).toBe('0');
    } finally {
      release();
      await outcome;
    }
  },
);

it('keeps image announcements metadata-only, exactly once and unavailable to unrelated sockets', async () => {
  const author = await person(),
    member = await person(),
    stranger = await person();
  const c = await chat.create(author.token, { kind: 'group', name: 'Image delivery' });
  await join(author, member, c);
  const client = await socket(member),
    unrelated = await socket(stranger);
  const notices: Record<string, unknown>[] = [],
    forbidden = vi.fn();
  client.on('message:created', (value: Record<string, unknown>) => notices.push(value));
  unrelated.on('message:created', forbidden);
  const key = randomUUID();
  expect((await send(author, c, '', key)).statusCode).toBe(200);
  await vi.waitFor(() => expect(notices).toHaveLength(1));
  expect((await send(author, c, '', key)).statusCode).toBe(200);
  expect(notices).toHaveLength(1);
  expect(forbidden).not.toHaveBeenCalled();
  expect(JSON.stringify(notices)).not.toContain(image.base64);
  expect(Object.keys(notices[0]!).sort()).toEqual([
    'authorId',
    'conversationId',
    'kind',
    'mention',
    'messageId',
    'preferences',
    'reply',
    'seq',
  ]);
});

it('rolls back the message, image and sequence when attachment storage fails', async () => {
  const author = await person(),
    c = await channel(author);
  await fixture.database.pool.query(
    "CREATE FUNCTION reject_fixture_attachment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Disposable image write failure'; END $$",
  );
  await fixture.database.pool.query(
    'CREATE TRIGGER reject_fixture_attachment BEFORE INSERT ON message_attachments FOR EACH ROW EXECUTE FUNCTION reject_fixture_attachment()',
  );
  try {
    expect((await send(author, c)).statusCode).toBe(500);
    expect(
      (await fixture.database.pool.query('SELECT 1 FROM messages WHERE conversation_id=$1', [c.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await fixture.database.pool.query(
          'SELECT last_seq,last_change FROM conversations WHERE id=$1',
          [c.id],
        )
      ).rows[0],
    ).toMatchObject({ last_seq: '0', last_change: '0' });
  } finally {
    await fixture.database.pool.query(
      'DROP TRIGGER reject_fixture_attachment ON message_attachments',
    );
    await fixture.database.pool.query('DROP FUNCTION reject_fixture_attachment()');
  }
  expect((await send(author, c)).json().message.seq).toBe('1');
});
