import { randomUUID } from 'node:crypto';
import { createDatabase } from './client.js';
import { applyMigrations } from './migrations.js';
// Never reset the development database. Each auth suite owns a newly-created database.
export async function testDatabase({ migrate = true }: { migrate?: boolean } = {}) {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL missing. Run db:setup first.');
  const url = new URL(source);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Tests require loopback PostgreSQL.');
  const name = 'tricord_test_' + randomUUID().replaceAll('-', '');
  const admin = createDatabase(source);
  let created = false;
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    await admin.pool.query('CREATE DATABASE "' + name + '"');
    created = true;
    url.pathname = '/' + name;
    database = createDatabase(url.toString());
    if (migrate) await applyMigrations(database);
    return {
      database,
      url: url.toString(),
      async cleanup() {
        await database!.pool.end();
        // name is generated here, never taken from an environment variable or user input.
        await admin.pool.query('DROP DATABASE "' + name + '"');
        await admin.pool.end();
      },
    };
  } catch (error) {
    await database?.pool.end();
    if (created) await admin.pool.query('DROP DATABASE "' + name + '"');
    await admin.pool.end();
    throw error;
  }
}
