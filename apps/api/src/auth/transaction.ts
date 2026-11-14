import type { Pool, PoolClient } from 'pg';

/** Run work under the same advisory lock and transaction policy used by auth. */
export async function withTransaction<T>(
  pool: Pool,
  work: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(716204)');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
