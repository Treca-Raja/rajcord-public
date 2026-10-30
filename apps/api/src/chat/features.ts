import {
  isChatEmoji,
  type ChatMessage,
  type MessageContext,
  type PinnedPage,
  type ThreadPage,
} from '@tricord/shared';
import type { PoolClient } from 'pg';
import { HttpError, input, uuid } from '../auth/validation.js';
import type { ChatService } from './service.js';
import { hydrateMessages, messageVisibility } from './message-data.js';

const missing = () => new HttpError(404, 'Conversation or message not found.');
function pageQuery(query: Record<string, unknown>) {
  input(query, ['before', 'limit']);
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const before = query.before;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (before !== undefined &&
      (typeof before !== 'string' ||
        !/^\d{1,19}$/.test(before) ||
        BigInt(before) > 9223372036854775807n))
  )
    throw new HttpError(400, 'Invalid pagination.');
  return { limit, before: before ?? null };
}
export class ChatFeatures {
  constructor(private readonly service: ChatService) {}

  private async target(
    db: PoolClient,
    userId: string,
    c: { id: string; kind: string },
    id: string,
    deleted = false,
  ) {
    const row = (
      await db.query(
        `SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id
       WHERE m.conversation_id=$1 AND ($3='channel' OR ${messageVisibility}) AND m.id=$4`,
        [c.id, userId, c.kind, uuid(id)],
      )
    ).rows[0];
    if (!row || (!deleted && row.deleted_at)) throw missing();
    return row;
  }
  private async changed(db: PoolClient, conversationId: string, messageId: string) {
    const counter = (
      await db.query(
        'UPDATE conversations SET last_change=last_change+1 WHERE id=$1 RETURNING last_change',
        [conversationId],
      )
    ).rows[0];
    await db.query('UPDATE messages SET change=$1 WHERE id=$2', [counter.last_change, messageId]);
  }
  async pin(
    token: string,
    conversationId: string,
    messageId: string,
    remove: boolean,
  ): Promise<ChatMessage> {
    return this.service.run(token, async (db, user) => {
      const c = await this.service.access(db, user.id, uuid(conversationId));
      if (c.archived) throw new HttpError(409, 'This channel is archived.');
      if (c.kind === 'group' && c.manager_id !== user.id)
        throw new HttpError(403, 'Only the group manager can manage pins.');
      await this.target(db, user.id, c, messageId);
      const result = remove
        ? await db.query('DELETE FROM message_pins WHERE message_id=$1', [messageId])
        : await db.query(
            'INSERT INTO message_pins(message_id,pinned_by) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [messageId, user.id],
          );
      if (result.rowCount) await this.changed(db, conversationId, messageId);
      return (
        await hydrateMessages(db, user.id, c, [await this.target(db, user.id, c, messageId)])
      )[0]!;
    });
  }
  async react(
    token: string,
    conversationId: string,
    messageId: string,
    value: unknown,
    remove: boolean,
  ): Promise<ChatMessage> {
    const body = input(value, ['emoji']);
    if (!isChatEmoji(body.emoji)) throw new HttpError(400, 'Choose a supported Unicode emoji.');
    return this.service.run(token, async (db, user) => {
      const c = await this.service.access(db, user.id, uuid(conversationId));
      if (c.archived) throw new HttpError(409, 'This channel is archived.');
      await this.target(db, user.id, c, messageId);
      if (!remove) {
        const summary = (
          await db.query(
            'SELECT count(DISTINCT emoji)::int total,bool_or(emoji=$2) existing FROM message_reactions WHERE message_id=$1',
            [messageId, body.emoji],
          )
        ).rows[0];
        if (summary.total >= 32 && !summary.existing)
          throw new HttpError(
            409,
            'This message has 32 different reactions. Choose an existing reaction or remove one of yours first.',
          );
      }
      const values = [messageId, user.id, body.emoji];
      const result = remove
        ? await db.query(
            'DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3',
            values,
          )
        : await db.query(
            'INSERT INTO message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            values,
          );
      if (result.rowCount) await this.changed(db, conversationId, messageId);
      return (
        await hydrateMessages(db, user.id, c, [await this.target(db, user.id, c, messageId)])
      )[0]!;
    });
  }
  async pins(
    token: string,
    conversationId: string,
    query: Record<string, unknown>,
  ): Promise<PinnedPage> {
    const { before, limit } = pageQuery(query);
    return this.service.run(token, async (db, user) => {
      const c = await this.service.access(db, user.id, uuid(conversationId));
      const predicate = `m.conversation_id=$1 AND ($3='channel' OR ${messageVisibility}) AND m.deleted_at IS NULL`;
      const rows = (
        await db.query(
          `SELECT m.*,u.username,u.display_name FROM message_pins p JOIN messages m ON m.id=p.message_id JOIN users u ON u.id=m.author_id
         WHERE ${predicate} AND ($4::bigint IS NULL OR m.seq<$4::bigint) ORDER BY m.seq DESC LIMIT $5`,
          [c.id, user.id, c.kind, before, limit + 1],
        )
      ).rows;
      const total = (
        await db.query(
          `SELECT count(*)::int count FROM message_pins p JOIN messages m ON m.id=p.message_id WHERE ${predicate}`,
          [c.id, user.id, c.kind],
        )
      ).rows[0].count;
      const selected = rows.slice(0, limit);
      return {
        messages: await hydrateMessages(db, user.id, c, selected),
        nextBefore: rows.length > limit ? String(selected.at(-1)!.seq) : null,
        total: Number(total),
      };
    });
  }
  async thread(
    token: string,
    conversationId: string,
    anchorId: string,
    query: Record<string, unknown>,
  ): Promise<ThreadPage> {
    const { before, limit } = pageQuery(query);
    return this.service.run(token, async (db, user) => {
      const c = await this.service.access(db, user.id, uuid(conversationId));
      const anchor = await this.target(db, user.id, c, anchorId, true);
      const rootId = String(anchor.thread_root_id ?? anchor.id);
      const rootRows = (
        await db.query(
          `SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id
         WHERE m.conversation_id=$1 AND ($3='channel' OR ${messageVisibility}) AND m.id=$4`,
          [c.id, user.id, c.kind, rootId],
        )
      ).rows;
      const rows = (
        await db.query(
          `SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id
         WHERE m.conversation_id=$1 AND ($3='channel' OR ${messageVisibility})
         AND m.thread_root_id=$4 AND m.deleted_at IS NULL AND ($5::bigint IS NULL OR m.seq<$5::bigint)
         ORDER BY m.seq DESC LIMIT $6`,
          [c.id, user.id, c.kind, rootId, before, limit + 1],
        )
      ).rows;
      const selected = rows.slice(0, limit).reverse();
      return {
        root: (await hydrateMessages(db, user.id, c, rootRows))[0] ?? null,
        messages: await hydrateMessages(db, user.id, c, selected),
        nextBefore: rows.length > limit ? String(selected[0]!.seq) : null,
        hasMore: rows.length > limit,
        change: String(c.last_change),
      };
    });
  }
  async context(
    token: string,
    conversationId: string,
    messageId: string,
    query: Record<string, unknown>,
  ): Promise<MessageContext> {
    input(query, ['limit']);
    const { limit } = pageQuery(query);
    return this.service.run(token, async (db, user) => {
      const c = await this.service.access(db, user.id, uuid(conversationId));
      const anchor = await this.target(db, user.id, c, messageId);
      const select = `SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id
        WHERE m.conversation_id=$1 AND ($3='channel' OR ${messageVisibility}) AND m.deleted_at IS NULL`;
      const older = (
        await db.query(select + ' AND m.seq<=$4 ORDER BY m.seq DESC LIMIT $5', [
          c.id,
          user.id,
          c.kind,
          anchor.seq,
          Math.ceil(limit / 2),
        ])
      ).rows.reverse();
      const newer = (
        await db.query(select + ' AND m.seq>$4 ORDER BY m.seq ASC LIMIT $5', [
          c.id,
          user.id,
          c.kind,
          anchor.seq,
          Math.floor(limit / 2),
        ])
      ).rows;
      const rows = [...older, ...newer];
      const boundaries = (
        await db.query(
          `SELECT EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=$1 AND ($3='channel' OR ${messageVisibility}) AND m.deleted_at IS NULL AND m.seq<$4) older,
         EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=$1 AND ($3='channel' OR ${messageVisibility}) AND m.deleted_at IS NULL AND m.seq>$5) newer`,
          [c.id, user.id, c.kind, rows[0]!.seq, rows.at(-1)!.seq],
        )
      ).rows[0];
      return {
        anchorId: messageId,
        messages: await hydrateMessages(db, user.id, c, rows),
        nextBefore: boundaries.older ? String(rows[0]!.seq) : null,
        hasMore: Boolean(boundaries.older),
        hasNewer: Boolean(boundaries.newer),
        change: String(c.last_change),
      };
    });
  }
  async unreadContext(token: string, conversationId: string): Promise<MessageContext> {
    const id = await this.service.run(token, async (db, user) => {
      const c = await this.service.access(db, user.id, uuid(conversationId));
      const row = (
        await db.query(
          `SELECT m.id FROM messages m LEFT JOIN conversation_reads r ON r.conversation_id=m.conversation_id AND r.user_id=$2
         WHERE m.conversation_id=$1 AND ($3='channel' OR ${messageVisibility})
         AND m.deleted_at IS NULL AND m.author_id<>$2 AND m.seq>coalesce(r.last_seq,0) ORDER BY m.seq LIMIT 1`,
          [c.id, user.id, c.kind],
        )
      ).rows[0];
      if (!row) throw new HttpError(409, 'No unread messages remain. Open the latest messages.');
      return String(row.id);
    });
    return this.context(token, conversationId, id, {});
  }
}
