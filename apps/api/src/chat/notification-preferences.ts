import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  ConversationAlertMode,
  ConversationAlertPreference,
  NoticePreferences,
  SenderAlertPreference,
  SenderAlertPreferencePage,
} from '@tricord/shared';
import { HttpError, input, uuid } from '../auth/validation.js';
import type { ChatService } from './service.js';

type Options = {
  token: (request: FastifyRequest) => string;
  guard: (request: FastifyRequest) => Promise<void>;
  mutation: RouteShorthandOptions;
};
const defaultMode = (kind: string): ConversationAlertMode =>
  kind === 'channel' ? 'mentions' : 'all';

export function conversationAlertInput(value: unknown): ConversationAlertMode | null {
  const body = input(value, ['mode']);
  if (
    body.mode !== null &&
    (typeof body.mode !== 'string' || !['all', 'mentions', 'muted'].includes(body.mode))
  )
    throw new HttpError(400, 'Choose all messages, mentions and replies, or muted.');
  return body.mode as ConversationAlertMode | null;
}
export function senderAlertInput(value: unknown) {
  const body = input(value, ['muted', 'priority']);
  if (!Object.keys(body).length || Object.values(body).some((item) => typeof item !== 'boolean'))
    throw new HttpError(400, 'Choose a sender mute or priority setting.');
  return body as { muted?: boolean; priority?: boolean };
}
export function senderAlertPage(value: unknown) {
  const query = input(value, ['after', 'limit']);
  const after = query.after === undefined ? null : uuid(query.after);
  if (
    query.limit !== undefined &&
    (typeof query.limit !== 'string' || !/^(?:[1-9]\d?|100)$/.test(query.limit))
  )
    throw new HttpError(400, 'Limit must be between 1 and 100.');
  return { after, limit: query.limit === undefined ? 50 : Number(query.limit) };
}
function sender(row: Record<string, unknown>): SenderAlertPreference {
  return {
    senderId: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    muted: row.muted === true,
    priority: row.priority === true,
  };
}
export async function noticePreferences(
  service: ChatService,
  token: string,
  conversationId: string,
  authorId: string,
): Promise<NoticePreferences> {
  return service.run(token, async (db, user) => {
    const conversation = await service.access(db, user.id, uuid(conversationId));
    const row = (
      await db.query(
        `SELECT c.mode,s.muted,s.priority
         FROM (SELECT 1) seed
         LEFT JOIN conversation_alert_preferences c ON c.user_id=$1 AND c.conversation_id=$2
         LEFT JOIN sender_alert_preferences s ON s.user_id=$1 AND s.sender_id=$3`,
        [user.id, conversationId, uuid(authorId)],
      )
    ).rows[0];
    return {
      mode: conversation.archived ? 'muted' : (row.mode ?? defaultMode(conversation.kind)),
      senderMuted: row.muted === true,
      priority: row.priority === true,
    };
  });
}
export function registerNotificationPreferences(
  app: FastifyInstance,
  service: ChatService,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  { token, guard, mutation }: Options,
) {
  async function changed(userId: string) {
    for (const socket of io.sockets.sockets.values()) {
      try {
        await service.run(socket.data.token, async (_db, user) => {
          if (user.id === userId) socket.emit('notification:preferences-changed');
        });
      } catch {
        // Expired or revoked sockets must not receive private preference changes.
      }
    }
  }
  async function conversationPreference(
    auth: string,
    id: string,
    change?: ConversationAlertMode | null,
  ) {
    return service.run(auth, async (db, user) => {
      const conversation = await service.access(db, user.id, id);
      if (change !== undefined) {
        if (conversation.archived)
          throw new HttpError(409, 'Archived conversation preferences cannot be changed.');
        if (change === null)
          await db.query(
            'DELETE FROM conversation_alert_preferences WHERE user_id=$1 AND conversation_id=$2',
            [user.id, id],
          );
        else
          await db.query(
            `INSERT INTO conversation_alert_preferences(user_id,conversation_id,mode) VALUES($1,$2,$3)
             ON CONFLICT(user_id,conversation_id) DO UPDATE SET mode=EXCLUDED.mode`,
            [user.id, id, change],
          );
      }
      const row = (
        await db.query(
          'SELECT mode FROM conversation_alert_preferences WHERE user_id=$1 AND conversation_id=$2',
          [user.id, id],
        )
      ).rows[0];
      const preference: ConversationAlertPreference = {
        conversationId: id,
        mode: row?.mode ?? defaultMode(conversation.kind),
        defaultMode: defaultMode(conversation.kind),
        overridden: !!row,
      };
      return { userId: user.id, preference };
    });
  }
  app.get<{ Params: { id: string } }>(
    '/api/conversations/:id/notification-preference',
    { preHandler: guard },
    async (request) =>
      (await conversationPreference(token(request), uuid(request.params.id))).preference,
  );
  app.patch<{ Params: { id: string } }>(
    '/api/conversations/:id/notification-preference',
    mutation,
    async (request) => {
      const result = await conversationPreference(
        token(request),
        uuid(request.params.id),
        conversationAlertInput(request.body),
      );
      await changed(result.userId);
      return result.preference;
    },
  );
  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/sender-alert-preferences',
    { preHandler: guard },
    async (request): Promise<SenderAlertPreferencePage> => {
      const { after, limit } = senderAlertPage(request.query);
      return service.run(token(request), async (db, user) => {
        const rows = (
          await db.query(
            `SELECT u.id,u.username,u.display_name,p.muted,p.priority FROM users u
             LEFT JOIN sender_alert_preferences p ON p.user_id=$1 AND p.sender_id=u.id
             WHERE u.status='approved' AND u.id<>$1 AND ($2::uuid IS NULL OR u.id>$2)
             ORDER BY u.id LIMIT $3`,
            [user.id, after, limit + 1],
          )
        ).rows;
        const senders = rows.slice(0, limit).map(sender);
        return {
          senders,
          nextCursor: rows.length > limit ? senders[senders.length - 1]!.senderId : null,
        };
      });
    },
  );
  app.patch<{ Params: { id: string } }>(
    '/api/sender-alert-preferences/:id',
    mutation,
    async (request) => {
      const id = uuid(request.params.id);
      const body = senderAlertInput(request.body);
      const result = await service.run(token(request), async (db, user) => {
        await service.contact(db, user.id, id);
        const row = (
          await db.query(
            `INSERT INTO sender_alert_preferences(user_id,sender_id,muted,priority)
             VALUES($1,$2,coalesce($3,false),coalesce($4,false))
             ON CONFLICT(user_id,sender_id) DO UPDATE SET
               muted=coalesce($3,sender_alert_preferences.muted),
               priority=coalesce($4,sender_alert_preferences.priority)
             RETURNING muted,priority`,
            [user.id, id, body.muted ?? null, body.priority ?? null],
          )
        ).rows[0];
        return { userId: user.id, sender: { senderId: id, ...row } };
      });
      await changed(result.userId);
      return result.sender as Pick<SenderAlertPreference, 'senderId' | 'muted' | 'priority'>;
    },
  );
}
