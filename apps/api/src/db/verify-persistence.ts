import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createDatabase } from './client.js';
import { testDatabase } from './test-database.js';
import { AuthService, identity } from '../auth/service.js';
import { ChatService } from '../chat/service.js';
import { checkPassword } from '../auth/password.js';
import { createApp } from '../app.js';
const source = process.env.DATABASE_URL;
if (!source) throw new Error('DATABASE_URL required.');
const target = new URL(source);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/tricord')
  throw new Error('Persistence probe only supports the local tricord database.');
const original = createDatabase(source),
  fixture = await testDatabase(),
  database = fixture.database;
const api = createApp({ databaseUrl: fixture.url, rateLimits: false }).app;
try {
  const journal = (
    await original.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')
  ).rows;
  const auth = new AuthService(database.pool),
    chat = new ChatService(database.pool),
    secret = randomUUID() + '-Persistence';
  const owner = await auth.bootstrap('probe_owner', 'Disposable owner', secret),
    member = await auth.register({
      username: 'probe_member',
      displayName: 'Disposable member',
      password: secret,
    });
  const first = await auth.login(
    { username: owner.username, password: secret, remember: true },
    undefined,
  );
  await auth.changeStatus(first.token, member.id, 'approve');
  const second = await auth.login(
    { username: member.username, password: secret, remember: true },
    undefined,
  );
  const channel = await chat.create(first.token, { kind: 'channel', name: 'persistence-probe' }),
    dm = await chat.create(first.token, { kind: 'dm', userId: member.id }),
    group = await chat.create(first.token, {
      kind: 'group',
      name: 'Persistence group',
      userIds: [member.id],
    });
  const hidden = await chat.send(first.token, group.id, {
    body: 'Before joining',
    clientId: randomUUID(),
  });
  const invitation = (await chat.invites(second.token))[0]!;
  await chat.respond(second.token, invitation.id, { accept: true });
  const records = [];
  for (const c of [channel, dm, group])
    records.push(
      await chat.send(first.token, c.id, {
        body: 'Survives PostgreSQL restart',
        clientId: randomUUID(),
      }),
    );
  assert.equal((await api.inject('/ready')).statusCode, 200);
  await database.pool.query('SELECT 1');
  console.log(
    'Restarting the existing PostgreSQL container; development data and volume remain intact.',
  );
  execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      fileURLToPath(new URL('../../../../infrastructure/.env', import.meta.url)),
      '-f',
      fileURLToPath(new URL('../../../../infrastructure/compose.yaml', import.meta.url)),
      'restart',
      'postgres',
    ],
    { stdio: 'inherit', timeout: 60000 },
  );
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await api.inject('/ready')).statusCode === 200) {
        ready = true;
        break;
      }
    } catch {
      /* Retry readiness only, never replay a mutation. */
    }
    await delay(1000);
  }
  assert.ok(ready, 'The existing Fastify pool did not recover.');
  assert.deepEqual(
    (await original.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows,
    journal,
  );
  assert.equal((await identity(database.pool, first.token))?.sessionId, first.auth.sessionId);
  const encoded = (
    await database.pool.query('SELECT password_hash FROM credentials WHERE user_id=$1', [owner.id])
  ).rows[0].password_hash;
  assert.ok(await checkPassword(encoded, secret));
  for (const message of records) {
    const restored = await chat.one(second.token, message.conversationId, message.id);
    assert.equal(restored.body, message.body);
    assert.equal(restored.seq, message.seq);
    assert.equal(restored.author.id, owner.id);
    const retry = await chat.send(first.token, message.conversationId, {
      body: message.body,
      clientId: message.clientId,
    });
    assert.equal(retry.id, message.id);
  }
  await assert.rejects(chat.one(second.token, group.id, hidden.id), { statusCode: 404 });
  assert.equal(
    (await database.pool.query('SELECT status FROM invitations WHERE id=$1', [invitation.id]))
      .rows[0].status,
    'accepted',
  );
  assert.equal(
    (await database.pool.query('SELECT count(*) FROM approval_history')).rows[0].count,
    '2',
  );
  const subsequent = await chat.send(second.token, group.id, {
    body: 'Pool recovered without replacing the application',
    clientId: randomUUID(),
  });
  assert.equal(subsequent.seq, '3');
  console.log(
    'PASS: channels, DMs, group history boundaries, messages, idempotency, credentials, sessions, invitations and audit survive restart.',
  );
  console.log(
    'PASS: existing Fastify/pg pools recover; original development migration journal is unchanged.',
  );
} finally {
  await api.close();
  await fixture.cleanup();
  await original.pool.end();
}
