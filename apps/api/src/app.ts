import { ChatService } from './chat/service.js';
import { registerChat } from './chat/transport.js';
import { createDatabase } from './db/client.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { Server } from 'socket.io';
import type { HealthResponse, ServerToClientEvents, ClientToServerEvents } from '@tricord/shared';
import { identity, equal, SESSION_COOKIE } from './auth/service.js';
import { registerAuth } from './auth/routes.js';
import { HttpError } from './auth/validation.js';

export function createApp({
  logger = false,
  databaseUrl,
  allowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:3001'],
  secureCookies = false,
  rateLimits = true,
  staticRoot,
}: {
  logger?: boolean;
  databaseUrl?: string;
  allowedOrigins?: string[];
  secureCookies?: boolean;
  rateLimits?: boolean;
  staticRoot?: string;
} = {}) {
  if (
    allowedOrigins.some((origin) => {
      try {
        const u = new URL(origin);
        return (
          u.origin !== origin ||
          !['http:', 'https:'].includes(u.protocol) ||
          (secureCookies && u.protocol !== 'https:')
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error('WEB_ORIGINS must contain exact HTTP origins (HTTPS in production).');
  const app = Fastify({ logger, bodyLimit: 16384, requestTimeout: 15000 });
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  app.setErrorHandler((error, req, reply) => {
    const status =
      error instanceof HttpError
        ? error.statusCode
        : ((error as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500)
      req.log.error({ code: (error as { code?: string }).code ?? 'internal' }, 'Request failed');
    reply.code(status).send({
      error:
        status >= 500
          ? 'Service temporarily unavailable.'
          : error instanceof HttpError
            ? error.message
            : status === 429
              ? 'Too many requests. Try again later.'
              : 'Invalid request.',
    });
  });
  app.register(cookie);
  app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
  });
  app.register(rateLimit, { global: rateLimits, max: 120, timeWindow: 60000 });
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
      .header('Content-Security-Policy', "frame-ancestors 'none'");
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (
      req.url.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (!req.headers.origin || !allowedOrigins.includes(req.headers.origin))
    )
      throw new HttpError(403, 'Untrusted request origin.');
  });
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
    cors: { origin: allowedOrigins, credentials: true },
    allowRequest: (req, callback) =>
      callback(null, !!req.headers.origin && allowedOrigins.includes(req.headers.origin)),
    maxHttpBufferSize: 16384,
  });
  io.use(async (socket, next) => {
    try {
      const raw = app.parseCookie(socket.request.headers.cookie ?? '')[SESSION_COOKIE];
      const auth = database ? await identity(database.pool, raw) : null;
      if (!auth || !equal(socket.handshake.auth.csrfToken, auth.csrfToken))
        return next(new Error('Sign in required.'));
      socket.data.token = raw;
      socket.data.auth = auth;
      next();
    } catch {
      next(new Error('Authentication unavailable.'));
    }
  });
  io.on('connection', (socket) => {
    const auth = socket.data.auth;
    void socket.join(['user:' + auth.user.id, 'session:' + auth.sessionId]);
    if (auth.user.status === 'approved')
      socket.emit('connection:welcome', {
        message: 'Connected to Tricord.',
        connectedAt: new Date().toISOString(),
      });
    socket.on('connection:ping', async (ack) => {
      try {
        const fresh = database ? await identity(database.pool, socket.data.token) : null;
        if (!fresh || fresh.user.status !== 'approved') {
          if (typeof ack === 'function') ack({ ok: false });
          if (!fresh) socket.disconnect(true);
          return;
        }
        if (typeof ack === 'function') ack({ ok: true });
      } catch {
        socket.disconnect(true);
      }
    });
  });
  const expiry = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      void (async () => {
        try {
          if (!database || !(await identity(database.pool, socket.data.token)))
            socket.disconnect(true);
        } catch {
          socket.disconnect(true);
        }
      })();
    }
  }, 15000);
  expiry.unref();
  app.register(async (routes) => {
    if (database) {
      registerAuth(routes, database.pool, io, secureCookies, rateLimits);
      registerChat(routes, new ChatService(database.pool), io, rateLimits);
    } else
      routes.all('/api/*', async () => {
        throw new HttpError(503, 'Database not configured.');
      });
  });
  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'tricord-api',
    milestone: 2,
  }));
  app.get('/ready', async (_req, reply) => {
    if (!database)
      return reply.code(503).send({ status: 'unavailable', database: 'not_configured' });
    try {
      await database.pool.query('SELECT 1');
      return { status: 'ok', database: 'connected' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'unavailable' });
    }
  });
  if (staticRoot) app.register(staticFiles, { root: staticRoot });
  app.addHook('preClose', async () => {
    clearInterval(expiry);
    io.disconnectSockets(true);
    io.close();
  });
  app.addHook('onClose', async () => {
    await database?.pool.end();
  });
  return { app, io };
}
