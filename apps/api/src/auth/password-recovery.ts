import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { approved, digest, identity } from './service.js';
import { checkPassword, hashPassword } from './password.js';
import { HttpError, password, username } from './validation.js';
import { withTransaction } from './transaction.js';

const invalidCode = () => new HttpError(400, 'Invalid or expired recovery code.');
export class PasswordRecoveryService {
  constructor(private readonly pool: Pool) {}

  private async store(db: PoolClient, targetId: string, issuerId: string, serverOwner = false) {
    await db.query('SELECT user_id FROM credentials WHERE user_id=$1 FOR UPDATE', [targetId]);
    const target = (await db.query('SELECT status FROM users WHERE id=$1 FOR UPDATE', [targetId]))
      .rows[0];
    const owner = (await db.query('SELECT owner_id FROM platform WHERE id=1 FOR SHARE')).rows[0];
    if (!owner || owner.owner_id !== issuerId)
      throw new HttpError(403, 'Only the current owner can issue recovery codes.');
    if (target?.status !== 'approved' || (!serverOwner && targetId === issuerId))
      throw new HttpError(409, 'Choose another approved member.');
    const code = randomBytes(32).toString('base64url');
    const result = await db.query(
      `INSERT INTO password_recovery_codes(user_id,token_hash,issued_by,expires_at)
       VALUES($1,$2,$3,clock_timestamp()+interval '15 minutes')
       ON CONFLICT(user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,issued_by=EXCLUDED.issued_by,created_at=now(),expires_at=EXCLUDED.expires_at
       RETURNING expires_at`,
      [targetId, digest(code), issuerId],
    );
    await db.query('INSERT INTO approval_history(target_id,actor_id,action) VALUES($1,$2,$3)', [
      targetId,
      issuerId,
      serverOwner ? 'owner-recovery-issued' : 'password-recovery-issued',
    ]);
    return { code, expiresAt: (result.rows[0].expires_at as Date).toISOString() };
  }

  async issue(sessionToken: string, targetId: string, currentPassword: unknown) {
    const actor = approved(await identity(this.pool, sessionToken));
    if (!actor.user.isOwner) throw new HttpError(403, 'Only the owner can issue recovery codes.');
    const secret = password(currentPassword);
    const row = (
      await this.pool.query('SELECT password_hash FROM credentials WHERE user_id=$1', [
        actor.user.id,
      ])
    ).rows[0];
    if (!row || !(await checkPassword(row.password_hash, secret)))
      throw new HttpError(403, 'Owner password is incorrect.');
    return withTransaction(this.pool, async (db) => {
      // Match the credential -> session lock order used by password changes.
      const credential = (
        await db.query('SELECT password_hash FROM credentials WHERE user_id=$1 FOR SHARE', [
          actor.user.id,
        ])
      ).rows[0];
      await db.query('SELECT id FROM sessions WHERE token_hash=$1 FOR UPDATE', [
        digest(sessionToken),
      ]);
      const current = approved(await identity(db, sessionToken));
      if (
        current.user.id !== actor.user.id ||
        !current.user.isOwner ||
        credential?.password_hash !== row.password_hash
      )
        throw new HttpError(403, 'Owner verification changed. Sign in again.');
      return this.store(db, targetId, current.user.id);
    });
  }

  async issueForOwner(name: unknown) {
    const account = username(name);
    const row = (
      await this.pool.query(
        'SELECT u.id FROM platform p JOIN users u ON u.id=p.owner_id WHERE lower(u.username)=$1',
        [account],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'The current owner username is required.');
    return withTransaction(this.pool, (db) => this.store(db, row.id, row.id, true));
  }

  async reset(name: unknown, rawCode: unknown, newPassword: unknown) {
    const account = username(name);
    const secret = password(newPassword);
    if (typeof rawCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawCode)) throw invalidCode();
    const hash = digest(rawCode);
    const target = (
      await this.pool.query(
        `SELECT u.id FROM users u JOIN password_recovery_codes r ON r.user_id=u.id
       WHERE lower(u.username)=$1 AND r.token_hash=$2 AND r.expires_at>now() AND u.status='approved'`,
        [account, hash],
      )
    ).rows[0];
    if (!target) throw invalidCode();
    const encoded = await hashPassword(secret);
    return withTransaction(this.pool, async (db) => {
      await db.query('SELECT user_id FROM credentials WHERE user_id=$1 FOR UPDATE', [target.id]);
      const user = (await db.query('SELECT status FROM users WHERE id=$1 FOR UPDATE', [target.id]))
        .rows[0];
      const owner = (await db.query('SELECT owner_id FROM platform WHERE id=1 FOR SHARE')).rows[0];
      const code = (
        await db.query(
          'SELECT issued_by FROM password_recovery_codes WHERE user_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp() FOR UPDATE',
          [target.id, hash],
        )
      ).rows[0];
      if (user?.status !== 'approved' || !code || code.issued_by !== owner?.owner_id)
        throw invalidCode();
      await db.query('DELETE FROM password_recovery_codes WHERE user_id=$1', [target.id]);
      await db.query('UPDATE credentials SET password_hash=$1,changed_at=now() WHERE user_id=$2', [
        encoded,
        target.id,
      ]);
      await db.query(
        'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
        [target.id],
      );
      await db.query(
        "INSERT INTO approval_history(target_id,actor_id,action) VALUES($1,$2,'password-recovered')",
        [target.id, code.issued_by],
      );
      return target.id as string;
    });
  }
}
