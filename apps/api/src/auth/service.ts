import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuthUser, AccountStatus } from '@tricord/shared';
import { HttpError, username, password, text } from './validation.js';
import { hashPassword, verifyLogin } from './password.js';
export const SESSION_COOKIE = 'tricord_session';
export const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export function equal(a: unknown, b: string) {
  return (
    typeof a === 'string' &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
type Queryable = Pool | PoolClient;
export interface Identity {
  user: AuthUser;
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
  remember: boolean;
  tokenHash: string;
}
export function publicUser(row: Record<string, unknown>): AuthUser {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    status: row.status as AccountStatus,
    isOwner: row.is_owner === true,
  };
}
export async function identity(db: Queryable, token: unknown): Promise<Identity | null> {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await db.query(
    `SELECT u.*,s.id session_id,s.csrf_token,s.expires_at,s.remember,s.token_hash,EXISTS(SELECT 1 FROM platform WHERE owner_id=u.id) is_owner FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status NOT IN ('suspended','removed')`,
    [digest(token)],
  );
  const row = rows[0];
  return row
    ? {
        user: publicUser(row),
        sessionId: row.session_id,
        csrfToken: row.csrf_token,
        expiresAt: row.expires_at,
        remember: row.remember,
        tokenHash: row.token_hash,
      }
    : null;
}
export function approved(auth: Identity | null) {
  if (!auth) throw new HttpError(401, 'Sign in required.');
  if (auth.user.status !== 'approved') throw new HttpError(403, 'An approved account is required.');
  return auth;
}
export class AuthService {
  constructor(readonly pool: Pool) {}
  async transaction<T>(work: (db: PoolClient) => Promise<T>) {
    const db = await this.pool.connect();
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
  async register(body: Record<string, unknown>) {
    const name = username(body.username),
      displayName = text(body.displayName, 1, 80, 'display name'),
      secret = password(body.password);
    const encoded = await hashPassword(secret);
    try {
      return await this.transaction(async (db) => {
        const { rows } = await db.query(
          'INSERT INTO users(username,display_name) VALUES($1,$2) RETURNING *',
          [name, displayName],
        );
        const user = rows[0];
        await db.query('INSERT INTO credentials(user_id,password_hash) VALUES($1,$2)', [
          user.id,
          encoded,
        ]);
        return publicUser(user);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new HttpError(409, 'Unable to register with those details.');
      throw error;
    }
  }
  async login(body: Record<string, unknown>, oldToken: unknown) {
    const name = username(body.username);
    const secret = password(body.password);
    if (typeof body.remember !== 'boolean')
      throw new HttpError(400, 'Remember must be true or false.');
    const device = text(body.deviceLabel ?? 'Browser', 1, 80, 'device label');
    const found = await this.pool.query(
      'SELECT u.id,c.password_hash FROM users u LEFT JOIN credentials c ON c.user_id=u.id WHERE lower(u.username)=$1',
      [name],
    );
    const row = found.rows[0];
    const valid = await verifyLogin(row?.password_hash ?? null, secret);
    if (!valid || !row) throw new HttpError(401, 'Invalid username or password.');
    return this.transaction(async (db) => {
      const current = (
        await db.query(
          'SELECT u.*,c.password_hash FROM users u JOIN credentials c ON c.user_id=u.id WHERE u.id=$1 FOR UPDATE',
          [row.id],
        )
      ).rows[0];
      if (
        current.password_hash !== row.password_hash ||
        ['suspended', 'removed'].includes(current.status)
      )
        throw new HttpError(401, 'Invalid username or password.');
      const token = randomBytes(32).toString('hex'),
        csrf = randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + (body.remember ? 30 * 86400 : 12 * 3600) * 1000);
      if (typeof oldToken === 'string')
        await db.query(
          'UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',
          [digest(oldToken)],
        );
      await db.query(
        'INSERT INTO sessions(user_id,token_hash,csrf_token,remember,expires_at,device_label) VALUES($1,$2,$3,$4,$5,$6)',
        [row.id, digest(token), csrf, body.remember, expires, device],
      );
      return { token, auth: (await identity(db, token))! };
    });
  }
  async bootstrap(nameInput: unknown, displayInput: unknown, passwordInput: unknown) {
    const name = username(nameInput),
      display = text(displayInput, 1, 80, 'display name'),
      encoded = await hashPassword(password(passwordInput));
    return this.transaction(async (db) => {
      if ((await db.query('SELECT id FROM platform')).rowCount)
        throw new HttpError(409, 'Platform owner is already initialized. Nothing changed.');
      const { rows } = await db.query(
        "INSERT INTO users(username,display_name,status) VALUES($1,$2,'approved') RETURNING *",
        [name, display],
      );
      const user = rows[0];
      await db.query('INSERT INTO credentials(user_id,password_hash) VALUES($1,$2)', [
        user.id,
        encoded,
      ]);
      await db.query('INSERT INTO platform(id,owner_id) VALUES(1,$1)', [user.id]);
      await db.query(
        "INSERT INTO approval_history(target_id,actor_id,action) VALUES($1,$1,'bootstrap')",
        [user.id],
      );
      return { ...publicUser(user), isOwner: true };
    });
  }
  async changeStatus(token: string, targetId: string, action: string) {
    return this.transaction(async (db) => {
      const auth = approved(await identity(db, token));
      if (targetId === auth.user.id)
        throw new HttpError(403, 'You cannot perform this action on yourself.');
      const target = (await db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [targetId]))
        .rows[0];
      if (!target) throw new HttpError(404, 'Account not found.');
      const owner = (await db.query('SELECT owner_id FROM platform WHERE id=1')).rows[0]?.owner_id;
      if (targetId === owner)
        throw new HttpError(403, 'Transfer ownership before changing the owner account.');
      let next: string;
      if (action === 'approve' || action === 'reject') {
        if (target.status !== 'pending') throw new HttpError(409, 'Account is no longer pending.');
        next = action === 'approve' ? 'approved' : 'rejected';
      } else {
        if (!auth.user.isOwner) throw new HttpError(403, 'Only the platform owner can do this.');
        if (action === 'suspend' && target.status === 'approved') next = 'suspended';
        else if (action === 'remove' && ['approved', 'suspended'].includes(target.status))
          next = 'removed';
        else if (action === 'restore' && target.status === 'suspended') next = 'approved';
        else throw new HttpError(409, 'Invalid account transition.');
      }
      await db.query('UPDATE users SET status=$1 WHERE id=$2', [next, targetId]);
      await db.query('INSERT INTO approval_history(target_id,actor_id,action) VALUES($1,$2,$3)', [
        targetId,
        auth.user.id,
        action,
      ]);
      if (['suspended', 'removed'].includes(next))
        await db.query(
          'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [targetId],
        );
      return next;
    });
  }
  async transfer(token: string, targetId: string) {
    return this.transaction(async (db) => {
      const auth = approved(await identity(db, token));
      if (!auth.user.isOwner)
        throw new HttpError(403, 'Only the platform owner can transfer ownership.');
      if (targetId === auth.user.id) throw new HttpError(409, 'Already the owner.');
      const target = (await db.query('SELECT status FROM users WHERE id=$1 FOR UPDATE', [targetId]))
        .rows[0];
      if (target?.status !== 'approved') throw new HttpError(409, 'Choose an approved member.');
      await db.query('UPDATE platform SET owner_id=$1 WHERE id=1', [targetId]);
      await db.query(
        "INSERT INTO approval_history(target_id,actor_id,action) VALUES($1,$2,'transfer-owner')",
        [targetId, auth.user.id],
      );
      return auth.user.id;
    });
  }
}
