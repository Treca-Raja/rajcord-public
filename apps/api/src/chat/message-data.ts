import type { PoolClient } from 'pg';
import type { ChatMessage, Conversation, MessageReference } from '@tricord/shared';

export const messageVisibility =
  'EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=m.conversation_id AND h.user_id=$2 AND m.seq>=h.start_seq AND (h.end_seq IS NULL OR m.seq<=h.end_seq))';

export function messageBase(row: Record<string, unknown>): ChatMessage {
  return {
    featureVersion: 2,
    id: String(row.id),
    conversationId: String(row.conversation_id),
    clientId: String(row.client_id),
    seq: String(row.seq),
    change: String(row.change),
    contextChange: String(row.change),
    author: {
      id: String(row.author_id),
      username: String(row.username),
      displayName: String(row.display_name),
    },
    body: row.deleted_at ? null : String(row.body),
    deleted: !!row.deleted_at,
    createdAt: (row.created_at as Date).toISOString(),
    editedAt: row.edited_at ? (row.edited_at as Date).toISOString() : null,
    replyTo: null,
    threadRoot: null,
    replyCount: 0,
    pinned: false,
    reactions: [],
    mentions: [],
  };
}

export async function hydrateMessages(
  db: PoolClient,
  userId: string,
  conversation: { id: string; kind: Conversation['kind']; last_change?: unknown },
  rows: Record<string, unknown>[],
): Promise<ChatMessage[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => String(row.id));
  const roots = [...new Set(rows.map((row) => String(row.thread_root_id ?? row.id)))];
  const references = [
    ...new Set(
      rows.flatMap((row) =>
        [row.reply_to_id, row.thread_root_id].filter((id) => typeof id === 'string'),
      ),
    ),
  ];
  const quoted = await db.query(
    `SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id
       WHERE m.conversation_id=$1 AND ($3='channel' OR ${messageVisibility}) AND m.id=ANY($4::uuid[])`,
    [conversation.id, userId, conversation.kind, references],
  );
  const counts = await db.query(
    `SELECT m.thread_root_id,count(*)::int count FROM messages m
       WHERE m.conversation_id=$1 AND ($3='channel' OR ${messageVisibility})
       AND m.deleted_at IS NULL AND m.thread_root_id=ANY($4::uuid[]) GROUP BY m.thread_root_id`,
    [conversation.id, userId, conversation.kind, roots],
  );
  const pins = await db.query(
    'SELECT message_id FROM message_pins WHERE message_id=ANY($1::uuid[])',
    [ids],
  );
  const reactions = await db.query(
    'SELECT message_id,emoji,count(*)::int count,bool_or(user_id=$2) mine FROM message_reactions WHERE message_id=ANY($1::uuid[]) GROUP BY message_id,emoji ORDER BY emoji',
    [ids, userId],
  );
  const mentions = await db.query(
    "SELECT mm.message_id,u.id,u.username FROM message_mentions mm JOIN users u ON u.id=mm.user_id WHERE mm.message_id=ANY($1::uuid[]) AND u.status='approved' ORDER BY u.username",
    [ids],
  );
  const referenceMap = new Map(
    quoted.rows.map((row) => {
      const item = messageBase(row);
      const reference: MessageReference = {
        available: true,
        id: item.id,
        seq: item.seq,
        change: item.change,
        author: item.author,
        body: item.body === null ? null : [...item.body].slice(0, 200).join(''),
        deleted: item.deleted,
      };
      return [item.id, reference];
    }),
  );
  const countMap = new Map(
    counts.rows.map((row) => [String(row.thread_root_id), Number(row.count)]),
  );
  const pinned = new Set(pins.rows.map((row) => String(row.message_id)));
  return rows.map((row) => {
    const item = messageBase(row);
    const reference = (id: unknown): MessageReference | null =>
      typeof id === 'string' ? (referenceMap.get(id) ?? { available: false }) : null;
    return {
      ...item,
      contextChange:
        BigInt(String(conversation.last_change ?? 0)) > BigInt(item.change)
          ? String(conversation.last_change)
          : item.change,
      replyTo: reference(row.reply_to_id),
      threadRoot: reference(row.thread_root_id),
      replyCount: countMap.get(String(row.thread_root_id ?? row.id)) ?? 0,
      pinned: !item.deleted && pinned.has(item.id),
      reactions: item.deleted
        ? []
        : reactions.rows
            .filter((r) => r.message_id === item.id)
            .map((r) => ({
              emoji: String(r.emoji),
              count: Number(r.count),
              mine: Boolean(r.mine),
            })),
      mentions: item.deleted
        ? []
        : mentions.rows
            .filter((r) => r.message_id === item.id)
            .map((r) => ({ id: String(r.id), username: String(r.username) })),
    };
  });
}
