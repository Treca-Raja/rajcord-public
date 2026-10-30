import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, it } from 'vitest';
import { testDatabase } from './test-database.js';
import { applyMigrations } from './migrations.js';

it('upgrades existing chat data and keeps legacy ASCII writes and repeat startups compatible', async () => {
  const fixture = await testDatabase({ migrate: false });
  const folder = await mkdtemp(path.join(tmpdir(), 'tricord-channel-migration-'));
  try {
    const source = fileURLToPath(new URL('../../drizzle/', import.meta.url));
    const journal = JSON.parse(await readFile(path.join(source, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const earlier = { ...journal, entries: journal.entries.slice(0, 5) };
    await mkdir(path.join(folder, 'meta'));
    await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify(earlier));
    for (const entry of earlier.entries)
      await writeFile(
        path.join(folder, entry.tag + '.sql'),
        await readFile(path.join(source, entry.tag + '.sql')),
      );
    await migrate(fixture.database.db, { migrationsFolder: folder });
    const pool = fixture.database.pool;
    const userId = randomUUID(),
      conversationId = randomUUID(),
      messageId = randomUUID();
    const readerId = randomUUID();
    await pool.query(
      "INSERT INTO users(id,username,display_name,status) VALUES($1,'migration_user','Migration user','approved')",
      [userId],
    );
    await pool.query(
      "INSERT INTO users(id,username,display_name,status) VALUES($1,'migration_reader','Historical reader','suspended')",
      [readerId],
    );
    await pool.query(
      "INSERT INTO conversations(id,kind,name,archived,last_seq,last_change) VALUES($1,'channel','preserved-channel',true,1,1)",
      [conversationId],
    );
    await pool.query(
      'INSERT INTO messages(id,conversation_id,author_id,client_id,request_hash,seq,change,body) VALUES($1,$2,$3,$4,$5,1,1,$6)',
      [
        messageId,
        conversationId,
        userId,
        randomUUID(),
        'a'.repeat(64),
        'Existing message @migration_reader',
      ],
    );
    await pool.query(
      'INSERT INTO conversation_reads(conversation_id,user_id,last_seq) VALUES($1,$2,1)',
      [conversationId, userId],
    );
    const before = {
      ...(await pool.query('SELECT * FROM messages WHERE id=$1', [messageId])).rows[0],
      reply_to_id: null,
      thread_root_id: null,
    };
    const previousJournal = (
      await pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')
    ).rows;
    await applyMigrations(fixture.database);
    expect(
      (await pool.query('SELECT user_id FROM message_mentions WHERE message_id=$1', [messageId]))
        .rows,
    ).toEqual([{ user_id: readerId }]);
    expect((await pool.query('SELECT * FROM messages WHERE id=$1', [messageId])).rows[0]).toEqual(
      before,
    );
    expect(
      (await pool.query('SELECT * FROM conversations WHERE id=$1', [conversationId])).rows[0],
    ).toMatchObject({
      id: conversationId,
      name: 'preserved-channel',
      name_key: 'preserved-channel',
      archived: true,
      topic: '',
      category_id: null,
      position: 0,
      metadata_revision: '0',
      last_seq: '1',
      last_change: '1',
    });
    expect(
      (
        await pool.query(
          'SELECT last_seq FROM conversation_reads WHERE conversation_id=$1 AND user_id=$2',
          [conversationId, userId],
        )
      ).rows[0].last_seq,
    ).toBe('1');
    const upgradedJournal = (
      await pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')
    ).rows;
    expect(upgradedJournal.slice(0, previousJournal.length)).toEqual(previousJournal);
    expect(upgradedJournal).toHaveLength(8);
    const legacy = (
      await pool.query(
        "INSERT INTO conversations(kind,name) VALUES('channel','legacy-write') RETURNING *",
      )
    ).rows[0];
    expect(legacy.name_key).toBe('legacy-write');
    const renamed = (
      await pool.query("UPDATE conversations SET name='legacy-renamed' WHERE id=$1 RETURNING *", [
        legacy.id,
      ])
    ).rows[0];
    expect(renamed).toMatchObject({ name_key: 'legacy-renamed', metadata_revision: '1' });
    await expect(
      pool.query(
        "INSERT INTO conversations(kind,name,name_key) VALUES('channel','Legacy-renamed','legacy-renamed')",
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await applyMigrations(fixture.database);
    expect(
      (await pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows,
    ).toEqual(upgradedJournal);
    expect((await pool.query('SELECT * FROM messages WHERE id=$1', [messageId])).rows[0]).toEqual(
      before,
    );
  } finally {
    await fixture.cleanup();
    await rm(folder, { recursive: true, force: true });
  }
});
