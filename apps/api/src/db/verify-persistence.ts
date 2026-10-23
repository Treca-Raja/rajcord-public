import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { users } from './schema.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/tricord')
  throw new Error('Persistence probe only supports the local tricord database.');
const compose = fileURLToPath(new URL('../../../../infrastructure/compose.yaml', import.meta.url));
const id = randomUUID();
let database = createDatabase(url);
let inserted = false;
try {
  const [row] = await database.db
    .insert(users)
    .values({
      id,
      username: 'persist_' + id.replaceAll('-', '').slice(0, 24),
      displayName: 'Disposable persistence probe',
    })
    .returning();
  inserted = true;
  await database.pool.end();
  console.log('Committed disposable row; restarting PostgreSQL without removing its volume.');
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
  const [restored] = await database.db.select().from(users).where(eq(users.id, id));
  assert.deepEqual(restored, row);
  console.log('PASS: committed row persisted across container restart.');
} finally {
  if (inserted) {
    try {
      await database.pool.end();
    } catch {
      /* pool may already be closed */
    }
    database = createDatabase(url);
    await database.db.delete(users).where(eq(users.id, id));
    assert.equal((await database.db.select().from(users).where(eq(users.id, id))).length, 0);
    console.log('PASS: only the disposable persistence row was removed.');
  }
  await database.pool.end();
}
