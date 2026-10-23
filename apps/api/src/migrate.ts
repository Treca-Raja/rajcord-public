import { createDatabase } from './db/client.js';
import { applyMigrations } from './db/migrations.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required. Run pnpm db:setup first.');
const database = createDatabase(url);
try {
  await applyMigrations(database);
  console.log('Database migrations applied.');
} finally {
  await database.pool.end();
}
