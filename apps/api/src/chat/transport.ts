import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, Conversation } from '@tricord/shared';
import { SESSION_COOKIE, identity, approved, equal } from '../auth/service.js';
import { HttpError, input, uuid } from '../auth/validation.js';
import { ChatService } from './service.js';
import { ChatFeatures } from './features.js';
import { noticePreferences, registerNotificationPreferences } from './notification-preferences.js';
import { registerGifSearch, type GifSearchOptions } from './gif-search.js';
export function registerChat(
  app: FastifyInstance,
  service: ChatService,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  limits: boolean,
  gifOptions: Pick<GifSearchOptions, 'config' | 'fetcher'> = { config: {} },
) {
  const features = new ChatFeatures(service);
  const token = (req: FastifyRequest) => req.cookies[SESSION_COOKIE] ?? '';
  async function guard(req: FastifyRequest) {
    const auth = approved(await identity(service.pool, token(req)));
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      !equal(req.headers['x-csrf-token'], auth.csrfToken)
    )
      throw new HttpError(403, 'Invalid CSRF token.');
  }
  const unread = (conversation: Conversation) => ({
    id: conversation.id,
    unreadCount: conversation.unreadCount,
    mentionCount: conversation.mentionCount,
    lastReadSeq: conversation.lastReadSeq,
    activity: conversation.activity,
  });
  async function publishRead(token: string, id: string) {
    const reader = await identity(service.pool, token);
    for (const socket of io.sockets.sockets.values()) {
      try {
        const auth = await identity(service.pool, socket.data.token);
        if (auth?.user.status === 'approved' && auth.user.id === reader?.user.id)
          socket.emit('unread:changed', unread(await service.get(socket.data.token, id)));
      } catch {
        /* Reconnect reloads persisted read progress. */
      }
    }
  }
  // Rooms are subscriptions, never authorization. Every delivery is checked again.
  async function publish(conversationId?: string, messageId?: string, created = false) {
    for (const socket of io.sockets.sockets.values()) {
      try {
        const auth = await identity(service.pool, socket.data.token);
        if (!auth || auth.user.status !== 'approved') continue;
        if (!messageId) socket.emit('inbox:changed');
        if (conversationId) {
          try {
            const delivery = messageId
              ? await service.delivery(socket.data.token, conversationId, messageId)
              : {
                  conversation: await service.get(socket.data.token, conversationId),
                  notice: null,
                  deleted: false,
                };
            const { conversation } = delivery;
            if (messageId) {
              // A historical edit outside this membership period must not evict a current subscriber.
              if (!delivery.notice) continue;
              socket.emit('unread:changed', unread(conversation));
              if (created && !delivery.deleted && delivery.notice.authorId !== auth.user.id)
                socket.emit('message:created', {
                  ...delivery.notice,
                  preferences: await noticePreferences(
                    service,
                    socket.data.token,
                    conversationId,
                    delivery.notice.authorId,
                  ),
                });
            }
            if (socket.rooms.has('conversation:' + conversationId)) {
              socket.emit('conversation:changed', { conversationId });
            }
          } catch (error) {
            const denied = error instanceof HttpError && [401, 403, 404].includes(error.statusCode);
            if (denied && socket.rooms.has('conversation:' + conversationId)) {
              await socket.leave('conversation:' + conversationId);
              socket.emit('conversation:closed', { conversationId });
            } else if (!denied) {
              app.log.error(
                { code: error instanceof Error && 'code' in error ? error.code : 'internal' },
                'Chat delivery unavailable',
              );
              socket.emit('chat:unavailable');
            }
          }
        }
      } catch (error) {
        app.log.error(
          { code: error instanceof Error && 'code' in error ? error.code : 'internal' },
          'Chat delivery unavailable',
        );
        socket.emit('chat:unavailable');
      }
    }
  }
  const mutation = {
    preHandler: guard,
    config: { rateLimit: limits ? { max: 60, timeWindow: 60000 } : (false as const) },
  };
  registerNotificationPreferences(app, service, io, { token, guard, mutation });
  registerGifSearch(app, { ...gifOptions, guard, limits });
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    '/api/conversations/:id/pins',
    { preHandler: guard },
    async (req) => features.pins(token(req), uuid(req.params.id), req.query),
  );
  app.get<{ Params: { id: string; messageId: string }; Querystring: Record<string, unknown> }>(
    '/api/conversations/:id/messages/:messageId/context',
    { preHandler: guard },
    async (req) =>
      features.context(token(req), uuid(req.params.id), uuid(req.params.messageId), req.query),
  );
  app.get<{ Params: { id: string } }>(
    '/api/conversations/:id/messages/unread-context',
    { preHandler: guard },
    async (req) => features.unreadContext(token(req), uuid(req.params.id)),
  );
  app.get<{ Params: { id: string; anchorId: string }; Querystring: Record<string, unknown> }>(
    '/api/conversations/:id/threads/:anchorId',
    { preHandler: guard },
    async (req) =>
      features.thread(token(req), uuid(req.params.id), uuid(req.params.anchorId), req.query),
  );
  for (const remove of [false, true]) {
    app.route<{ Params: { id: string; messageId: string } }>({
      method: remove ? 'DELETE' : 'PUT',
      url: '/api/conversations/:id/messages/:messageId/pin',
      ...mutation,
      handler: async (req) => {
        if (req.body !== undefined) input(req.body, []);
        const message = await features.pin(
          token(req),
          uuid(req.params.id),
          uuid(req.params.messageId),
          remove,
        );
        await publish(message.conversationId, message.id);
        return { message };
      },
    });
    app.route<{ Params: { id: string; messageId: string } }>({
      method: remove ? 'DELETE' : 'PUT',
      url: '/api/conversations/:id/messages/:messageId/reactions',
      ...mutation,
      handler: async (req) => {
        const message = await features.react(
          token(req),
          uuid(req.params.id),
          uuid(req.params.messageId),
          req.body,
          remove,
        );
        await publish(message.conversationId, message.id);
        return { message };
      },
    });
  }
  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/channel-categories',
    { preHandler: guard },
    async (req) => service.categories(token(req), req.query),
  );
  app.post('/api/channel-categories', mutation, async (req, reply) => {
    const category = await service.createCategory(token(req), req.body);
    await publish();
    return reply.code(201).send({ category });
  });
  app.patch<{ Params: { id: string } }>('/api/channel-categories/:id', mutation, async (req) => {
    const category = await service.updateCategory(token(req), uuid(req.params.id), req.body);
    await publish();
    return { category };
  });
  app.delete<{ Params: { id: string } }>('/api/channel-categories/:id', mutation, async (req) => {
    await service.updateCategory(token(req), uuid(req.params.id), req.body, true);
    await publish();
    return { removed: true };
  });
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
  app.post<{ Params: { id: string } }>('/api/conversations/:id/read', mutation, async (req) => {
    const result = await service.markRead(token(req), uuid(req.params.id), req.body);
    await publishRead(token(req), uuid(req.params.id));
    return result;
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
    const { message, created } = await service.sendResult(
      token(req),
      uuid(req.params.id),
      req.body,
    );
    await publish(message.conversationId, message.id, created);
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
    socket.on('conversation:read', async (data, ack) => {
      if (typeof ack !== 'function') return;
      try {
        budget();
        const body = input(data, ['conversationId', 'seq']);
        const id = uuid(body.conversationId);
        const result = await service.markRead(socket.data.token, id, { seq: body.seq });
        ack({ ok: true, data: result });
        await publishRead(socket.data.token, id);
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
        const body = input(data, ['conversationId', 'clientId', 'body', 'replyToId']);
        const { message: result, created } = await service.sendResult(
          socket.data.token,
          uuid(body.conversationId),
          {
            body: body.body,
            clientId: body.clientId,
            replyToId: body.replyToId,
          },
        );
        ack({ ok: true, data: result });
        await publish(result.conversationId, result.id, created);
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
