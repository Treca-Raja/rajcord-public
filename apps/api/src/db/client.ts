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
  // pg removes failed idle clients itself; never retry writes or log connection strings.
  // Expected restarts are reflected by /ready and recover through the pool's next connection.
  pool.on('error', (error: Error & { code?: string }) => {
    if (
      !['57P01', '57P02', '57P03', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(error.code ?? '')
    )
      console.warn('Unexpected idle database connection failure; the pool will reconnect.');
  });
  return { pool, db: drizzle(pool, { schema }) };
}
