import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    idleTimeoutMillis: 10000,
  });
  pool.on('error', () => console.error('An idle PostgreSQL connection failed.'));
  return { pool, db: drizzle(pool, { schema }) };
}
