import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@tricord/shared';
import { SESSION_COOKIE, identity, approved, equal } from '../auth/service.js';
import { HttpError, input, uuid } from '../auth/validation.js';
import { ChatService } from './service.js';
export function registerChat(
  app: FastifyInstance,
  service: ChatService,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  limits: boolean,
) {
  const token = (req: FastifyRequest) => req.cookies[SESSION_COOKIE] ?? '';
  async function guard(req: FastifyRequest) {
    const auth = approved(await identity(service.pool, token(req)));
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      !equal(req.headers['x-csrf-token'], auth.csrfToken)
    )
      throw new HttpError(403, 'Invalid CSRF token.');
  }
  // Rooms are subscriptions, never authorization. Every delivery is checked again.
  async function publish(conversationId?: string, messageId?: string) {
    for (const socket of io.sockets.sockets.values()) {
      try {
        const auth = await identity(service.pool, socket.data.token);
        if (!auth || auth.user.status !== 'approved') continue;
        if (!messageId) socket.emit('inbox:changed');
        if (conversationId) {
          try {
            await service.get(socket.data.token, conversationId);
            if (socket.rooms.has('conversation:' + conversationId)) {
              if (messageId) {
                try {
                  await service.one(socket.data.token, conversationId, messageId, true);
                } catch {
                  continue;
                }
              }
              socket.emit('conversation:changed', { conversationId });
            }
          } catch {
            if (socket.rooms.has('conversation:' + conversationId)) {
              await socket.leave('conversation:' + conversationId);
              socket.emit('conversation:closed', { conversationId });
            }
          }
        }
      } catch {
        /* Database outage: fail closed. Reconnect synchronization reads persisted state. */
      }
    }
  }
  const mutation = {
    preHandler: guard,
    config: { rateLimit: limits ? { max: 60, timeWindow: 60000 } : (false as const) },
  };
  app.get('/api/conversations', { preHandler: guard }, async (req) => ({
    conversations: await service.list(token(req)),
  }));
  app.post('/api/conversations', mutation, async (req, reply) => {
    const conversation = await service.create(token(req), req.body);
    await publish();
    return reply.code(201).send({ conversation });
  });
  app.get<{ Params: { id: string } }>(
    '/api/conversations/:id',
    { preHandler: guard },
    async (req) => ({ conversation: await service.get(token(req), uuid(req.params.id)) }),
  );
  app.patch<{ Params: { id: string } }>('/api/conversations/:id', mutation, async (req) => {
    const conversation = await service.update(token(req), uuid(req.params.id), req.body);
    await publish(conversation.id);
    return { conversation };
  });
  app.get('/api/invitations', { preHandler: guard }, async (req) => ({
    invitations: await service.invites(token(req)),
  }));
  app.post<{ Params: { id: string } }>(
    '/api/conversations/:id/invitations',
    mutation,
    async (req) => {
      const result = await service.invite(token(req), uuid(req.params.id), req.body);
      await publish();
      return result;
    },
  );
  app.post<{ Params: { id: string } }>('/api/invitations/:id', mutation, async (req) => {
    const result = await service.respond(token(req), uuid(req.params.id), req.body);
    await publish();
    return result;
  });
  app.post<{ Params: { id: string } }>(
    '/api/conversations/:id/membership',
    mutation,
    async (req) => {
      const id = uuid(req.params.id);
      const result = await service.membership(token(req), id, req.body);
      await publish(id);
      return result;
    },
  );
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    '/api/conversations/:id/messages',
    { preHandler: guard },
    async (req) => service.read(token(req), uuid(req.params.id), req.query),
  );
  app.get<{ Params: { id: string; messageId: string } }>(
    '/api/conversations/:id/messages/:messageId',
    { preHandler: guard },
    async (req) => ({
      message: await service.one(token(req), uuid(req.params.id), uuid(req.params.messageId)),
    }),
  );
  app.post<{ Params: { id: string } }>('/api/conversations/:id/messages', mutation, async (req) => {
    const message = await service.send(token(req), uuid(req.params.id), req.body);
    await publish(message.conversationId, message.id);
    return { message };
  });
  app.patch<{ Params: { id: string; messageId: string } }>(
    '/api/conversations/:id/messages/:messageId',
    mutation,
    async (req) => {
      const message = await service.edit(
        token(req),
        uuid(req.params.id),
        uuid(req.params.messageId),
        req.body,
      );
      await publish(message.conversationId, message.id);
      return { message };
    },
  );
  app.delete<{ Params: { id: string; messageId: string } }>(
    '/api/conversations/:id/messages/:messageId',
    mutation,
    async (req) => {
      const message = await service.edit(
        token(req),
        uuid(req.params.id),
        uuid(req.params.messageId),
        undefined,
        true,
      );
      await publish(message.conversationId, message.id);
      return { message };
    },
  );
  io.on('connection', (socket) => {
    let events = 0,
      windowStart = Date.now();
    const budget = () => {
      if (Date.now() - windowStart >= 60000) {
        events = 0;
        windowStart = Date.now();
      }
      if (++events > 60) throw new HttpError(429, 'Too many messaging events.');
    };
    socket.on('conversation:join', async (data, ack) => {
      if (typeof ack !== 'function') return;
      try {
        budget();
        const body = input(data, ['conversationId']);
        const id = uuid(body.conversationId);
        await service.get(socket.data.token, id);
        for (const room of socket.rooms)
          if (room.startsWith('conversation:')) await socket.leave(room);
        await socket.join('conversation:' + id);
        ack({ ok: true, data: { joined: true } });
      } catch (error) {
        ack({
          ok: false,
          status: error instanceof HttpError ? error.statusCode : 503,
          error: error instanceof HttpError ? error.message : 'Messaging temporarily unavailable.',
        });
      }
    });
    socket.on('message:send', async (data, ack) => {
      if (typeof ack !== 'function') return;
      try {
        budget();
        const body = input(data, ['conversationId', 'clientId', 'body']);
        const result = await service.send(socket.data.token, uuid(body.conversationId), {
          body: body.body,
          clientId: body.clientId,
        });
        ack({ ok: true, data: result });
        await publish(result.conversationId, result.id);
      } catch (error) {
        ack({
          ok: false,
          status: error instanceof HttpError ? error.statusCode : 503,
          error: error instanceof HttpError ? error.message : 'Messaging temporarily unavailable.',
        });
      }
    });
  });
}
