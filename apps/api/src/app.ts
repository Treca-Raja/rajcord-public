import { createDatabase } from './db/client.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import type { HealthResponse, ServerToClientEvents, ClientToServerEvents } from '@tricord/shared';
export function createApp({
  logger = false,
  databaseUrl,
  allowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'],
}: { logger?: boolean; allowedOrigins?: string[]; databaseUrl?: string } = {}) {
  const app = Fastify({ logger });
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  app.get('/ready', async (_request, reply) => {
    if (!database)
      return reply.code(503).send({ status: 'unavailable', database: 'not_configured' });
    try {
      await database.pool.query('SELECT 1');
      return { status: 'ok', database: 'connected' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'unavailable' });
    }
  });
  app.addHook('onClose', async () => {
    await database?.pool.end();
  });
  // File-origin Electron is supported only by this loopback-only, unauthenticated foundation.
  const localOrigins = [...allowedOrigins, 'null', 'file://'];
  app.register(cors, { origin: localOrigins });
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
    cors: { origin: localOrigins },
    allowRequest: (req, callback) =>
      callback(null, !req.headers.origin || localOrigins.includes(req.headers.origin)),
  });
  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'tricord-api',
    milestone: 1,
  }));
  io.on('connection', (socket) => {
    socket.emit('connection:welcome', {
      message: 'Connected to Tricord. Messaging is not implemented yet.',
      connectedAt: new Date().toISOString(),
    });
    socket.on('connection:ping', (ack) => {
      if (typeof ack === 'function') ack({ ok: true });
    });
  });
  app.addHook('preClose', async () => {
    io.disconnectSockets(true);
    io.close();
  });
  return { app, io };
}
