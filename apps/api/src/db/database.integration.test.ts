import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { applyMigrations } from './migrations.js';
import { users } from './schema.js';
import { createApp } from '../app.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing; run pnpm db:setup and pnpm db:up.');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Database tests require a loopback database.');
const database = createDatabase(url);
const ids: string[] = [];
async function insert() {
  const id = randomUUID();
  ids.push(id);
  const [row] = await database.db
    .insert(users)
    .values({
      id,
      username: 'test_' + id.replaceAll('-', '').slice(0, 24),
      displayName: 'Disposable integration test',
    })
    .returning();
  return row!;
}
async function schemaSnapshot() {
  return {
    columns: (
      await database.pool.query(
        "SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position",
      )
    ).rows,
    constraints: (
      await database.pool.query(
        "SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='public.users'::regclass ORDER BY conname",
      )
    ).rows,
    journal: (await database.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id'))
      .rows,
  };
}
beforeAll(async () => {
  await applyMigrations(database);
});
afterAll(async () => {
  try {
    for (const id of ids) await database.db.delete(users).where(eq(users.id, id));
  } finally {
    await database.pool.end();
  }
});
describe('real PostgreSQL foundation', () => {
  it('creates expected tables, types, defaults and constraints', async () => {
    const snapshot = await schemaSnapshot();
    expect(snapshot.columns.map((x) => x.column_name)).toEqual([
      'id',
      'username',
      'display_name',
      'status',
      'created_at',
    ]);
    expect(snapshot.columns.every((x) => x.is_nullable === 'NO')).toBe(true);
    expect(snapshot.columns.find((x) => x.column_name === 'id')?.column_default).toContain(
      'gen_random_uuid',
    );
    expect(snapshot.columns.find((x) => x.column_name === 'created_at')?.data_type).toBe(
      'timestamp with time zone',
    );
    expect(snapshot.columns.find((x) => x.column_name === 'status')?.column_default).toContain(
      'pending',
    );
    expect(snapshot.constraints.map((x) => x.definition)).toEqual(
      expect.arrayContaining(['PRIMARY KEY (id)', 'UNIQUE (username)']),
    );
    const labels = await database.pool.query(
      "SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_enum.enumtypid=pg_type.oid WHERE typname='approval_status' ORDER BY enumsortorder",
    );
    expect(labels.rows.map((x) => x.enumlabel)).toEqual([
      'pending',
      'approved',
      'rejected',
      'suspended',
      'removed',
    ]);
    expect(snapshot.journal).toHaveLength(8);
    const tables = await database.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'approval_history',
      'channel_categories',
      'conversation_alert_preferences',
      'conversation_reads',
      'conversations',
      'credentials',
      'invitations',
      'memberships',
      'message_mentions',
      'message_pins',
      'message_reactions',
      'messages',
      'platform',
      'sender_alert_preferences',
      'sessions',
      'users',
      'voice_channels',
    ]);
    const singleton = await database.pool.query(
      "SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='public.platform'::regclass AND contype='c'",
    );
    expect(singleton.rows[0].definition).toContain('id = 1');
  });
  it('inserts, reads and deletes only its disposable row through Drizzle', async () => {
    const row = await insert();
    expect(row.status).toBe('pending');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(await database.db.select().from(users).where(eq(users.id, row.id))).toHaveLength(1);
    await database.db.delete(users).where(eq(users.id, row.id));
    expect(await database.db.select().from(users).where(eq(users.id, row.id))).toHaveLength(0);
  });
  it('enforces unique usernames', async () => {
    const row = await insert();
    await expect(
      database.pool.query('INSERT INTO users (username,display_name) VALUES ($1,$2)', [
        row.username,
        'duplicate',
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });
  it('rejects invalid approval status', async () => {
    await expect(
      database.pool.query('UPDATE users SET status=$1 WHERE id=$2', ['invalid', randomUUID()]),
    ).rejects.toMatchObject({ code: '22P02' });
  });
  it('reruns migrations without schema, journal or fixture changes', async () => {
    const row = await insert();
    const before = await schemaSnapshot();
    await applyMigrations(database);
    await applyMigrations(database);
    expect(await schemaSnapshot()).toEqual(before);
    expect((await database.db.select().from(users).where(eq(users.id, row.id)))[0]).toEqual(row);
  });
  it('reports readiness from Fastify using its real database connection', async () => {
    const { app } = createApp({ databaseUrl: url });
    try {
      const response = await app.inject('/ready');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', database: 'connected' });
    } finally {
      await app.close();
    }
  });
  it('fails readiness without leaking credentials when PostgreSQL is unreachable', async () => {
    const bad = new URL(url);
    bad.port = '1';
    const { app } = createApp({ databaseUrl: bad.toString() });
    try {
      const response = await app.inject('/ready');
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'unavailable', database: 'unavailable' });
    } finally {
      await app.close();
    }
  });
});
