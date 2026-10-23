import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createDatabase } from './client.js';
import { AuthService, identity } from '../auth/service.js';
import { checkPassword } from '../auth/password.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/tricord')
  throw new Error('Persistence probe only supports the local tricord database.');
const compose = fileURLToPath(new URL('../../../../infrastructure/compose.yaml', import.meta.url));
const secret = randomUUID() + '-Persistence',
  username = 'persist_' + randomUUID().replaceAll('-', '').slice(0, 24);
let database = createDatabase(url),
  id: string | undefined;
try {
  const service = new AuthService(database.pool);
  const user = await service.register({
    username,
    displayName: 'Disposable persistence probe',
    password: secret,
  });
  id = user.id;
  const { token, auth } = await service.login(
    { username, password: secret, remember: true },
    undefined,
  );
  await database.pool.query(
    "INSERT INTO approval_history(target_id,actor_id,action) VALUES($1,$1,'persistence-probe')",
    [id],
  );
  const before = (await database.pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  const journal = (
    await database.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')
  ).rows;
  await database.pool.end();
  console.log(
    'Committed disposable account/session/audit records; restarting PostgreSQL with its existing volume.',
  );
  execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      fileURLToPath(new URL('../../../../infrastructure/.env', import.meta.url)),
      '-f',
      compose,
      'restart',
      'postgres',
    ],
    { stdio: 'inherit', timeout: 60000 },
  );
  database = createDatabase(url);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await database.pool.query('SELECT 1');
      ready = true;
      break;
    } catch {
      await delay(1000);
    }
  }
  assert.ok(ready, 'PostgreSQL did not recover');
  assert.deepEqual(
    (await database.pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0],
    before,
  );
  assert.deepEqual(
    (await database.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows,
    journal,
  );
  assert.equal((await identity(database.pool, token))?.sessionId, auth.sessionId);
  const encoded = (
    await database.pool.query('SELECT password_hash FROM credentials WHERE user_id=$1', [id])
  ).rows[0].password_hash;
  assert.equal(await checkPassword(encoded, secret), true);
  assert.equal(
    (await database.pool.query('SELECT id FROM approval_history WHERE target_id=$1', [id]))
      .rowCount,
    1,
  );
  console.log(
    'PASS: account, password hash, remembered session, audit record and migration journal survived container restart.',
  );
} finally {
  try {
    await database.pool.end();
  } catch {
    /* May already be closed before restart. */
  }
  database = createDatabase(url);
  try {
    if (id) {
      await database.pool.query('DELETE FROM approval_history WHERE target_id=$1 AND actor_id=$1', [
        id,
      ]);
      await database.pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await database.pool.query('DELETE FROM credentials WHERE user_id=$1', [id]);
      await database.pool.query('DELETE FROM users WHERE id=$1', [id]);
      assert.equal(
        (await database.pool.query('SELECT id FROM users WHERE id=$1', [id])).rowCount,
        0,
      );
      console.log('PASS: only this run’s disposable records were removed.');
    }
  } finally {
    await database.pool.end();
  }
}
