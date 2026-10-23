import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Server } from 'socket.io';
import { AuthService, identity, approved, equal, SESSION_COOKIE, publicUser } from './service.js';
import { HttpError, input, text, uuid, password } from './validation.js';
import { hashPassword, checkPassword } from './password.js';

export function registerAuth(
  app: FastifyInstance,
  pool: Pool,
  io: Server,
  secure: boolean,
  limits: boolean,
) {
  const service = new AuthService(pool);
  const token = (req: FastifyRequest) => req.cookies[SESSION_COOKIE] ?? '';
  const current = async (req: FastifyRequest) => {
    const auth = await identity(pool, token(req));
    if (!auth) throw new HttpError(401, 'Sign in required.');
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      !equal(req.headers['x-csrf-token'], auth.csrfToken)
    )
      throw new HttpError(403, 'Invalid CSRF token.');
    return auth;
  };
  const cookieOptions = { httpOnly: true, secure, sameSite: 'strict' as const, path: '/' };
  const notify = (id: string) => io.to('user:' + id).emit('account:changed');
  const disconnect = (id: string) => {
    notify(id);
    io.in('user:' + id).disconnectSockets(true);
  };
  const authLimit = (max: number) => ({ rateLimit: limits ? { max, timeWindow: 60000 } : false });
  app.post('/api/auth/register', { config: authLimit(5) }, async (req, reply) => {
    const user = await service.register(input(req.body, ['username', 'displayName', 'password']));
    return reply.code(201).send({ user });
  });
  app.post('/api/auth/login', { config: authLimit(10) }, async (req, reply) => {
    const previous = await identity(pool, token(req));
    const { auth, token: raw } = await service.login(
      input(req.body, ['username', 'password', 'remember', 'deviceLabel']),
      token(req),
    );
    if (previous) io.in('session:' + previous.sessionId).disconnectSockets(true);
    reply.setCookie(SESSION_COOKIE, raw, {
      ...cookieOptions,
      ...(auth.remember ? { maxAge: 30 * 86400 } : {}),
    });
    return {
      user: auth.user,
      csrfToken: auth.csrfToken,
      expiresAt: auth.expiresAt.toISOString(),
      remember: auth.remember,
    };
  });
  app.get('/api/auth/me', async (req) => {
    const auth = await current(req);
    return {
      user: auth.user,
      csrfToken: auth.csrfToken,
      expiresAt: auth.expiresAt.toISOString(),
      remember: auth.remember,
    };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const auth = await current(req);
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [auth.sessionId]);
    io.in('session:' + auth.sessionId).disconnectSockets(true);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });
  app.get('/api/account/sessions', async (req) => {
    const auth = await current(req);
    const { rows } = await pool.query(
      'SELECT id,device_label,created_at,expires_at,remember FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC',
      [auth.user.id],
    );
    return { sessions: rows.map((row) => ({ ...row, current: row.id === auth.sessionId })) };
  });
  app.delete<{ Params: { id: string } }>('/api/account/sessions/:id', async (req, reply) => {
    const auth = await current(req),
      id = uuid(req.params.id);
    const changed = await pool.query(
      'UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',
      [id, auth.user.id],
    );
    if (changed.rowCount) io.in('session:' + id).disconnectSockets(true);
    if (id === auth.sessionId) reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });
  app.patch('/api/account', async (req) => {
    const auth = await current(req),
      body = input(req.body, ['displayName']);
    await pool.query('UPDATE users SET display_name=$1 WHERE id=$2', [
      text(body.displayName, 1, 80, 'display name'),
      auth.user.id,
    ]);
    notify(auth.user.id);
    return { ok: true };
  });
  app.post('/api/account/password', { config: authLimit(5) }, async (req, reply) => {
    const auth = await current(req),
      body = input(req.body, ['currentPassword', 'newPassword']);
    const old = password(body.currentPassword),
      next = password(body.newPassword);
    const row = (
      await pool.query('SELECT password_hash FROM credentials WHERE user_id=$1', [auth.user.id])
    ).rows[0];
    if (!row || !(await checkPassword(row.password_hash, old)))
      throw new HttpError(400, 'Current password is incorrect.');
    const encoded = await hashPassword(next);
    await service.transaction(async (db) => {
      if (!(await identity(db, token(req)))) throw new HttpError(401, 'Sign in required.');
      const changed = await db.query(
        'UPDATE credentials SET password_hash=$1,changed_at=now() WHERE user_id=$2 AND password_hash=$3',
        [encoded, auth.user.id, row.password_hash],
      );
      if (!changed.rowCount) throw new HttpError(409, 'Password changed. Sign in again.');
      await db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [auth.user.id]);
    });
    disconnect(auth.user.id);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });
  app.get('/api/members', async (req) => {
    approved(await current(req));
    const { rows } = await pool.query(
      "SELECT u.*,EXISTS(SELECT 1 FROM platform WHERE owner_id=u.id) is_owner FROM users u WHERE status='approved' ORDER BY username",
    );
    return { users: rows.map(publicUser) };
  });
  app.get('/api/admin/accounts', async (req) => {
    const auth = approved(await current(req));
    const { rows } = await pool.query(
      'SELECT u.*,EXISTS(SELECT 1 FROM platform WHERE owner_id=u.id) is_owner FROM users u WHERE status=ANY($1::approval_status[]) ORDER BY created_at',
      [
        auth.user.isOwner
          ? ['pending', 'approved', 'suspended', 'rejected', 'removed']
          : ['pending'],
      ],
    );
    return { users: rows.map(publicUser) };
  });
  app.get('/api/admin/history', async (req) => {
    approved(await current(req));
    const { rows } = await pool.query(
      'SELECT h.id,h.action,h.created_at,a.username actor,t.username target FROM approval_history h JOIN users a ON a.id=h.actor_id JOIN users t ON t.id=h.target_id ORDER BY h.created_at DESC LIMIT 100',
    );
    return { history: rows };
  });
  app.post<{ Params: { id: string } }>('/api/admin/accounts/:id', async (req) => {
    await current(req);
    const body = input(req.body, ['action']);
    if (!['approve', 'reject', 'suspend', 'remove', 'restore'].includes(String(body.action)))
      throw new HttpError(400, 'Invalid action.');
    const id = uuid(req.params.id),
      status = await service.changeStatus(token(req), id, String(body.action));
    if (['suspended', 'removed'].includes(status)) disconnect(id);
    else notify(id);
    return { ok: true, status };
  });
  app.post('/api/owner/transfer', async (req) => {
    await current(req);
    const body = input(req.body, ['userId']),
      id = uuid(body.userId),
      previous = await service.transfer(token(req), id);
    notify(previous);
    notify(id);
    return { ok: true };
  });
}
