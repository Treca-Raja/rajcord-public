import type { PoolClient } from 'pg';
import {
  chatMetadataLimits,
  type AuthUser,
  type Conversation,
  type ChatMessage,
  type MessagePage,
  type Invitation,
  type ChannelCategory,
  type ChannelCategoryPage,
  type MessageNotice,
} from '@tricord/shared';
import { AuthService, approved, identity, digest } from '../auth/service.js';
import { HttpError, input, text, uuid } from '../auth/validation.js';
import { chatName, channelTopic, metadataPosition, checkMetadataRevision } from './metadata.js';
import { hydrateMessages, messageVisibility } from './message-data.js';
const missing = () => new HttpError(404, 'Conversation or message not found.');
const visible = messageVisibility;
function content(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000)
    throw new HttpError(400, 'Messages must contain 1–4000 characters.');
  return value;
}
function cursor(value: unknown) {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !/^\d{1,19}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new HttpError(400, 'Invalid message cursor.');
  return value;
}
function category(row: Record<string, unknown>): ChannelCategory {
  return {
    id: String(row.id),
    name: String(row.name),
    position: Number(row.position),
    revision: String(row.revision),
  };
}
export class ChatService extends AuthService {
  async run<T>(token: string, work: (db: PoolClient, user: AuthUser) => Promise<T>) {
    try {
      return await this.transaction(async (db) =>
        work(db, approved(await identity(db, token)).user),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === '23505' &&
        'constraint' in error &&
        ['conversation_channel_name_key', 'channel_category_name_key'].includes(
          String(error.constraint),
        )
      )
        throw new HttpError(409, 'That name is already in use.');
      throw error;
    }
  }
  async access(db: PoolClient, userId: string, id: string) {
    const row = (
      await db.query(
        "SELECT c.*,k.name category_name,k.position category_position,k.revision category_revision FROM conversations c LEFT JOIN channel_categories k ON k.id=c.category_id WHERE c.id=$1 AND (c.kind='channel' OR EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=$2 AND h.end_seq IS NULL)) FOR UPDATE OF c",
        [id, userId],
      )
    ).rows[0];
    if (!row) throw missing();
    return row;
  }
  async detail(db: PoolClient, userId: string, id: string): Promise<Conversation> {
    const row = await this.access(db, userId, id);
    const members = (
      await db.query(
        row.kind === 'channel'
          ? "SELECT id,username,display_name,status FROM users WHERE status='approved' ORDER BY username"
          : 'SELECT u.id,u.username,u.display_name,u.status FROM users u JOIN memberships h ON h.user_id=u.id WHERE h.conversation_id=$1 AND h.end_seq IS NULL ORDER BY u.username',
        row.kind === 'channel' ? [] : [id],
      )
    ).rows;
    const unread = (
      await db.query(
        `SELECT coalesce(r.last_seq,0)::text last_read_seq,
        count(m.id)::int unread_count,
        count(m.id) FILTER (WHERE EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=u.id))::int mention_count
      FROM users u LEFT JOIN conversation_reads r ON r.user_id=u.id AND r.conversation_id=$1
      LEFT JOIN messages m ON m.conversation_id=$1 AND m.seq>coalesce(r.last_seq,0)
        AND m.author_id<>u.id AND m.deleted_at IS NULL
        AND ($3='channel' OR EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=m.conversation_id AND h.user_id=u.id AND m.seq>=h.start_seq AND (h.end_seq IS NULL OR m.seq<=h.end_seq)))
      WHERE u.id=$2 GROUP BY r.last_seq`,
        [id, userId, row.kind],
      )
    ).rows[0];
    return {
      unreadCount: unread.unread_count,
      mentionCount: unread.mention_count,
      lastReadSeq: unread.last_read_seq,
      activity: String(row.last_change),
      id: row.id,
      kind: row.kind,
      name:
        row.kind === 'dm'
          ? (members.find((x) => x.id !== userId)?.display_name ?? 'Direct message')
          : row.name,
      archived: row.archived,
      topic: row.topic,
      category: row.category_id
        ? category({
            id: row.category_id,
            name: row.category_name,
            position: row.category_position,
            revision: row.category_revision,
          })
        : null,
      position: row.position,
      metadataRevision: String(row.metadata_revision),
      managerId: row.manager_id,
      members: members.map((x) => ({
        id: x.id,
        username: x.username,
        displayName: x.display_name,
        status: x.status,
      })),
    };
  }
  async list(token: string) {
    return this.run(token, async (db, user) => {
      const rows = (
        await db.query(
          "SELECT c.id FROM conversations c LEFT JOIN channel_categories k ON k.id=c.category_id WHERE c.kind='channel' OR EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=$1 AND h.end_seq IS NULL) ORDER BY CASE WHEN c.kind='channel' THEN 0 ELSE 1 END,k.position NULLS LAST,k.id,c.position,c.created_at,c.id",
          [user.id],
        )
      ).rows;
      const result: Conversation[] = [];
      for (const row of rows) result.push(await this.detail(db, user.id, row.id));
      return result;
    });
  }
  async markRead(token: string, id: string, value: unknown) {
    const body = input(value, ['seq']);
    const seq = cursor(body.seq);
    if (seq === undefined) throw new HttpError(400, 'A message cursor is required.');
    return this.run(token, async (db, user) => {
      const c = await this.access(db, user.id, uuid(id));
      if (BigInt(seq) > BigInt(c.last_seq))
        throw new HttpError(400, 'Cursor is ahead of this conversation.');
      if (
        BigInt(seq) !== 0n &&
        !(
          await db.query(
            `SELECT m.id FROM messages m WHERE m.conversation_id=$1 AND m.seq=$4 AND ($3='channel' OR ` +
              visible +
              ')',
            [id, user.id, c.kind, seq],
          )
        ).rowCount
      )
        throw missing();
      const result = await db.query(
        'INSERT INTO conversation_reads(conversation_id,user_id,last_seq) VALUES($1,$2,$3) ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_seq=greatest(conversation_reads.last_seq,EXCLUDED.last_seq) RETURNING last_seq',
        [id, user.id, seq],
      );
      return { lastReadSeq: String(result.rows[0].last_seq) };
    });
  }
  async get(token: string, id: string) {
    return this.run(token, (db, user) => this.detail(db, user.id, uuid(id)));
  }
  async delivery(token: string, id: string, messageId: string) {
    return this.run(token, async (db, user) => {
      const conversation = await this.detail(db, user.id, uuid(id));
      const row = (
        await db.query(
          `SELECT m.id,m.seq,m.author_id,m.deleted_at,
         EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=$2) mention,
         EXISTS(SELECT 1 FROM messages p WHERE p.id=m.reply_to_id AND p.conversation_id=m.conversation_id AND p.author_id=$2
           AND ($3='channel' OR EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=p.conversation_id AND h.user_id=$2
             AND p.seq>=h.start_seq AND (h.end_seq IS NULL OR p.seq<=h.end_seq)))) reply
         FROM messages m WHERE m.conversation_id=$1 AND ($3='channel' OR ${visible}) AND m.id=$4`,
          [id, user.id, conversation.kind, uuid(messageId)],
        )
      ).rows[0];
      const notice: MessageNotice | null = row
        ? {
            conversationId: id,
            messageId,
            seq: String(row.seq),
            authorId: String(row.author_id),
            kind: conversation.kind,
            mention: Boolean(row.mention),
            reply: Boolean(row.reply),
          }
        : null;
      return { conversation, notice, deleted: !!row?.deleted_at };
    });
  }
  // Central contact-policy boundary for future blocking; no implicit admin bypass.
  async contact(db: PoolClient, userId: string, target: string) {
    if (target === userId) throw new HttpError(400, 'Choose another member.');
    if (
      !(await db.query("SELECT id FROM users WHERE id=$1 AND status='approved'", [target])).rowCount
    )
      throw missing();
  }
  private async categoryId(db: PoolClient, value: unknown): Promise<string | null> {
    if (value === undefined || value === null) return null;
    const id = uuid(value);
    if (!(await db.query('SELECT id FROM channel_categories WHERE id=$1', [id])).rowCount)
      throw new HttpError(409, 'This category no longer exists. Reload channel details.');
    return id;
  }
  async categories(
    token: string,
    query: Record<string, unknown> = {},
  ): Promise<ChannelCategoryPage> {
    input(query, ['after', 'limit']);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    let position = -1;
    let afterId = '00000000-0000-4000-8000-000000000000';
    if (query.after !== undefined) {
      if (typeof query.after !== 'string' || !/^\d{1,10}:[0-9a-f-]{36}$/i.test(query.after))
        throw new HttpError(400, 'Invalid category cursor.');
      const [order, id] = query.after.split(':');
      position = metadataPosition(Number(order));
      afterId = uuid(id);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new HttpError(400, 'Invalid category page size.');
    return this.run(token, async (db) => {
      const rows = (
        await db.query(
          'SELECT * FROM channel_categories WHERE (position,id)>($1,$2::uuid) ORDER BY position,id LIMIT $3',
          [position, afterId, limit + 1],
        )
      ).rows;
      const categories = rows.slice(0, limit).map(category);
      const last = categories.at(-1);
      return {
        categories,
        nextAfter: rows.length > limit && last ? `${last.position}:${last.id}` : null,
      };
    });
  }
  async createCategory(token: string, value: unknown): Promise<ChannelCategory> {
    const body = input(value, ['name', 'position']);
    const name = chatName(body.name, chatMetadataLimits.categoryName, 'Category name');
    const position = body.position === undefined ? 0 : metadataPosition(body.position);
    return this.run(token, async (db) => {
      const result = await db.query(
        'INSERT INTO channel_categories(name,name_key,position) VALUES($1,$2,$3) RETURNING *',
        [name.name, name.key, position],
      );
      return category(result.rows[0]);
    });
  }
  async updateCategory(token: string, id: string, value: unknown, remove = false) {
    const body = input(
      value,
      remove ? ['expectedRevision'] : ['name', 'position', 'expectedRevision'],
    );
    return this.run(token, async (db) => {
      const row = (
        await db.query('SELECT * FROM channel_categories WHERE id=$1 FOR UPDATE', [uuid(id)])
      ).rows[0];
      if (!row) throw new HttpError(404, 'Category not found.');
      checkMetadataRevision(body.expectedRevision, row.revision);
      if (remove) {
        await db.query(
          'UPDATE conversations SET category_id=NULL,metadata_revision=metadata_revision+1 WHERE category_id=$1',
          [id],
        );
        await db.query('DELETE FROM channel_categories WHERE id=$1', [id]);
        return null;
      }
      if (body.name === undefined && body.position === undefined)
        throw new HttpError(400, 'Choose category details to change.');
      const name =
        body.name === undefined
          ? { name: row.name, key: row.name_key }
          : chatName(body.name, chatMetadataLimits.categoryName, 'Category name');
      const position = body.position === undefined ? row.position : metadataPosition(body.position);
      const result = await db.query(
        'UPDATE channel_categories SET name=$1,name_key=$2,position=$3,revision=revision+1 WHERE id=$4 RETURNING *',
        [name.name, name.key, position, id],
      );
      return category(result.rows[0]);
    });
  }
  async create(token: string, value: unknown) {
    const body = input(value, [
      'kind',
      'name',
      'userId',
      'userIds',
      'topic',
      'categoryId',
      'position',
    ]);
    if (!['channel', 'dm', 'group'].includes(String(body.kind)))
      throw new HttpError(400, 'Invalid conversation type.');
    return this.run(token, async (db, user) => {
      if (
        body.kind !== 'channel' &&
        ['topic', 'categoryId', 'position'].some((key) => body[key] !== undefined)
      )
        throw new HttpError(400, 'These details apply only to public channels.');
      let id: string;
      if (body.kind === 'dm') {
        const target = uuid(body.userId);
        await this.contact(db, user.id, target);
        const pair = [user.id, target].sort();
        const found = (
          await db.query(
            "SELECT id FROM conversations WHERE kind='dm' AND pair_low=$1 AND pair_high=$2",
            pair,
          )
        ).rows[0];
        if (found) return this.detail(db, user.id, found.id);
        id = (
          await db.query(
            "INSERT INTO conversations(kind,creator_id,pair_low,pair_high) VALUES('dm',$1,$2,$3) RETURNING id",
            [user.id, ...pair],
          )
        ).rows[0].id;
        for (const member of pair)
          await db.query(
            'INSERT INTO memberships(conversation_id,user_id,start_seq) VALUES($1,$2,1)',
            [id, member],
          );
      } else {
        let name: string;
        let nameKey: string | null = null;
        let topic = '';
        let categoryId: string | null = null;
        let position = 0;
        if (body.kind === 'channel') {
          const normalized = chatName(body.name, chatMetadataLimits.channelName, 'Channel name');
          name = normalized.name;
          nameKey = normalized.key;
          topic = channelTopic(body.topic);
          categoryId = await this.categoryId(db, body.categoryId);
          position = body.position === undefined ? 0 : metadataPosition(body.position);
          if (
            (
              await db.query("SELECT id FROM conversations WHERE kind='channel' AND name_key=$1", [
                nameKey,
              ])
            ).rowCount
          )
            throw new HttpError(409, 'Channel name already exists.');
        } else name = text(body.name, 1, 80, 'conversation name');
        let invitees: string[] = [];
        if (body.kind === 'group' && body.userIds !== undefined) {
          if (!Array.isArray(body.userIds) || body.userIds.length > 9)
            throw new HttpError(400, 'Choose up to nine members.');
          invitees = [...new Set(body.userIds.map(uuid))];
          for (const target of invitees) await this.contact(db, user.id, target);
        }
        id = (
          await db.query(
            'INSERT INTO conversations(kind,name,creator_id,manager_id,name_key,topic,category_id,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
            [
              body.kind,
              name,
              user.id,
              body.kind === 'group' ? user.id : null,
              nameKey,
              topic,
              categoryId,
              position,
            ],
          )
        ).rows[0].id;
        if (body.kind === 'group') {
          await db.query(
            'INSERT INTO memberships(conversation_id,user_id,start_seq) VALUES($1,$2,1)',
            [id, user.id],
          );
          for (const target of invitees)
            await db.query(
              'INSERT INTO invitations(conversation_id,inviter_id,invitee_id) VALUES($1,$2,$3)',
              [id, user.id, target],
            );
        }
      }
      return this.detail(db, user.id, id);
    });
  }
  async update(token: string, id: string, value: unknown) {
    const body = input(value, [
      'name',
      'archived',
      'topic',
      'categoryId',
      'position',
      'expectedRevision',
    ]);
    return this.run(token, async (db, user) => {
      const c = await this.access(db, user.id, uuid(id));
      if (c.kind === 'dm' || (c.kind === 'group' && c.manager_id !== user.id))
        throw new HttpError(403, 'Only the group manager can rename this conversation.');
      if (c.kind === 'channel') {
        checkMetadataRevision(body.expectedRevision, c.metadata_revision);
        if (
          !['name', 'archived', 'topic', 'categoryId', 'position'].some(
            (key) => body[key] !== undefined,
          )
        )
          throw new HttpError(400, 'Choose channel details to change.');
        if (
          c.archived &&
          ['name', 'topic', 'categoryId', 'position'].some((key) => body[key] !== undefined)
        )
          throw new HttpError(409, 'Restore this channel before changing its details.');
        const name =
          body.name === undefined
            ? { name: c.name, key: c.name_key }
            : chatName(body.name, chatMetadataLimits.channelName, 'Channel name');
        if (body.archived !== undefined && typeof body.archived !== 'boolean')
          throw new HttpError(400, 'Invalid archive setting.');
        await db.query(
          'UPDATE conversations SET name=$1,name_key=$2,topic=$3,category_id=$4,position=$5,archived=$6,metadata_revision=metadata_revision+1 WHERE id=$7',
          [
            name.name,
            name.key,
            body.topic === undefined ? c.topic : channelTopic(body.topic),
            body.categoryId === undefined
              ? c.category_id
              : await this.categoryId(db, body.categoryId),
            body.position === undefined ? c.position : metadataPosition(body.position),
            body.archived === undefined ? c.archived : body.archived,
            id,
          ],
        );
        return this.detail(db, user.id, id);
      }
      if (
        ['topic', 'categoryId', 'position', 'expectedRevision'].some(
          (key) => body[key] !== undefined,
        )
      )
        throw new HttpError(400, 'These details apply only to public channels.');
      if (body.archived !== undefined)
        throw new HttpError(400, 'Only channels can be archived or restored.');
      if (body.name !== undefined)
        await db.query('UPDATE conversations SET name=$1 WHERE id=$2', [
          text(body.name, 1, 80, 'conversation name'),
          id,
        ]);
      return this.detail(db, user.id, id);
    });
  }
  async invites(token: string): Promise<Invitation[]> {
    return this.run(token, async (db, user) =>
      (
        await db.query(
          "SELECT i.id,i.conversation_id,c.name,u.display_name inviter FROM invitations i JOIN conversations c ON c.id=i.conversation_id JOIN users u ON u.id=i.inviter_id WHERE i.invitee_id=$1 AND i.status='pending' AND NOT c.archived ORDER BY i.created_at",
          [user.id],
        )
      ).rows.map((x) => ({
        id: x.id,
        conversationId: x.conversation_id,
        name: x.name,
        inviter: x.inviter,
      })),
    );
  }
  async invite(token: string, id: string, value: unknown) {
    const body = input(value, ['userId']);
    return this.run(token, async (db, user) => {
      const c = await this.access(db, user.id, uuid(id));
      if (c.kind !== 'group' || c.archived) throw missing();
      const target = uuid(body.userId);
      await this.contact(db, user.id, target);
      if (
        (
          await db.query(
            'SELECT id FROM memberships WHERE conversation_id=$1 AND user_id=$2 AND end_seq IS NULL',
            [id, target],
          )
        ).rowCount
      )
        throw new HttpError(409, 'Already a member.');
      const row = (
        await db.query(
          "INSERT INTO invitations(conversation_id,inviter_id,invitee_id) VALUES($1,$2,$3) ON CONFLICT(conversation_id,invitee_id) WHERE status='pending' DO UPDATE SET inviter_id=EXCLUDED.inviter_id RETURNING id",
          [id, user.id, target],
        )
      ).rows[0];
      return { id: row.id };
    });
  }
  async respond(token: string, id: string, value: unknown) {
    const body = input(value, ['accept']);
    if (typeof body.accept !== 'boolean') throw new HttpError(400, 'Accept must be true or false.');
    return this.run(token, async (db, user) => {
      const invitation = (
        await db.query(
          "SELECT i.*,c.last_seq,c.archived FROM invitations i JOIN conversations c ON c.id=i.conversation_id WHERE i.id=$1 AND i.invitee_id=$2 AND i.status='pending' FOR UPDATE OF i,c",
          [uuid(id), user.id],
        )
      ).rows[0];
      if (!invitation || invitation.archived) throw missing();
      if (body.accept)
        await db.query(
          'INSERT INTO memberships(conversation_id,user_id,start_seq) VALUES($1,$2,$3)',
          [invitation.conversation_id, user.id, (BigInt(invitation.last_seq) + 1n).toString()],
        );
      await db.query('UPDATE invitations SET status=$1,responded_at=now() WHERE id=$2', [
        body.accept ? 'accepted' : 'declined',
        id,
      ]);
      return { conversationId: invitation.conversation_id };
    });
  }
  async membership(token: string, id: string, value: unknown) {
    const body = input(value, ['action', 'userId']);
    return this.run(token, async (db, user) => {
      const c = await this.access(db, user.id, uuid(id));
      if (c.kind !== 'group') throw missing();
      const action = body.action,
        target = action === 'leave' ? user.id : uuid(body.userId);
      if (!['leave', 'remove', 'transfer'].includes(String(action)))
        throw new HttpError(400, 'Invalid membership action.');
      if (action !== 'leave' && c.manager_id !== user.id)
        throw new HttpError(403, 'Only the group manager can do this.');
      const member = (
        await db.query(
          'SELECT id FROM memberships WHERE conversation_id=$1 AND user_id=$2 AND end_seq IS NULL',
          [id, target],
        )
      ).rows[0];
      if (!member) throw missing();
      if (action === 'transfer') {
        await this.contact(db, user.id, target);
        await db.query('UPDATE conversations SET manager_id=$1 WHERE id=$2', [target, id]);
      } else {
        if (target === c.manager_id) {
          const count = (
            await db.query(
              'SELECT count(*) FROM memberships WHERE conversation_id=$1 AND end_seq IS NULL',
              [id],
            )
          ).rows[0].count;
          if (action !== 'leave' || Number(count) > 1)
            throw new HttpError(409, 'Transfer group management before leaving.');
          await db.query('UPDATE conversations SET archived=true,manager_id=NULL WHERE id=$1', [
            id,
          ]);
          await db.query(
            "UPDATE invitations SET status='revoked',responded_at=now() WHERE conversation_id=$1 AND status='pending'",
            [id],
          );
        }
        await db.query('UPDATE memberships SET end_seq=$1,left_at=now() WHERE id=$2', [
          c.last_seq,
          member.id,
        ]);
        await db.query(
          "UPDATE invitations SET status='revoked',responded_at=now() WHERE conversation_id=$1 AND inviter_id=$2 AND status='pending'",
          [id, target],
        );
      }
      return { ok: true };
    });
  }
  async read(token: string, id: string, query: Record<string, unknown> = {}): Promise<MessagePage> {
    input(query, ['before', 'afterChange', 'limit']);
    const before = cursor(query.before),
      after = cursor(query.afterChange);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (before !== undefined && after !== undefined)
    )
      throw new HttpError(400, 'Invalid pagination.');
    return this.run(token, async (db, user) => {
      const c = await this.access(db, user.id, uuid(id));
      const values = [id, user.id, c.kind, after ?? before ?? null, limit + 1, c.last_change];
      const rows = (
        await db.query(
          "SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id WHERE m.conversation_id=$1 AND ($3='channel' OR " +
            visible +
            ') AND ' +
            (after !== undefined
              ? 'm.change>$4::bigint AND m.change<=$6::bigint'
              : 'm.deleted_at IS NULL AND ($4::bigint IS NULL OR m.seq<$4::bigint) AND m.change<=$6::bigint') +
            ' ORDER BY ' +
            (after !== undefined ? 'm.change ASC' : 'm.seq DESC') +
            ' LIMIT $5',
          values,
        )
      ).rows;
      const hasMore = rows.length > limit,
        selected = rows.slice(0, limit);
      return {
        messages: await hydrateMessages(
          db,
          user.id,
          c,
          after !== undefined ? selected : selected.reverse(),
        ),
        hasMore,
        nextBefore: after === undefined && hasMore ? String(selected[0]?.seq) : null,
        change:
          after !== undefined && hasMore
            ? String(selected[selected.length - 1]?.change)
            : String(c.last_change),
      };
    });
  }
  async one(token: string, id: string, messageId: string, includeDeleted = false) {
    return this.run(token, async (db, user) => {
      const c = await this.access(db, user.id, uuid(id));
      const row = (
        await db.query(
          "SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id WHERE m.id=$1 AND m.conversation_id=$3 AND ($4='channel' OR " +
            visible +
            ')',
          [uuid(messageId), user.id, id, c.kind],
        )
      ).rows[0];
      if (!row || (!includeDeleted && row.deleted_at)) throw missing();
      return (await hydrateMessages(db, user.id, c, [row]))[0]!;
    });
  }
  async send(token: string, id: string, value: unknown): Promise<ChatMessage> {
    return (await this.sendResult(token, id, value)).message;
  }
  async sendResult(
    token: string,
    id: string,
    value: unknown,
  ): Promise<{ message: ChatMessage; created: boolean }> {
    const body = input(value, ['body', 'clientId', 'replyToId']);
    const raw = content(body.body),
      clientId = uuid(body.clientId);
    const replyToId =
      body.replyToId === undefined || body.replyToId === null ? null : uuid(body.replyToId);
    const requestHash = digest(replyToId ? JSON.stringify([raw, replyToId]) : raw);
    return this.run(token, async (db, user) => {
      const c = await this.access(db, user.id, uuid(id));
      if (c.archived) throw new HttpError(409, 'This channel is archived.');
      if (c.kind === 'dm')
        await this.contact(db, user.id, c.pair_low === user.id ? c.pair_high : c.pair_low);
      const previous = (
        await db.query(
          'SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id WHERE m.conversation_id=$1 AND m.author_id=$2 AND m.client_id=$3',
          [id, user.id, clientId],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new HttpError(409, 'This message identifier was already used.');
        return { message: (await hydrateMessages(db, user.id, c, [previous]))[0]!, created: false };
      }
      let threadRootId: string | null = null;
      if (replyToId) {
        const target = (
          await db.query(
            `SELECT m.* FROM messages m WHERE m.conversation_id=$1 AND ($3='channel' OR ${visible}) AND m.id=$4 AND m.deleted_at IS NULL`,
            [id, user.id, c.kind, replyToId],
          )
        ).rows[0];
        if (!target) throw missing();
        threadRootId = String(target.thread_root_id ?? target.id);
      }
      const count = Number(
        (
          await db.query(
            "SELECT count(*) FROM messages WHERE author_id=$1 AND created_at>now()-interval '1 minute'",
            [user.id],
          )
        ).rows[0].count,
      );
      if (count >= 30) throw new HttpError(429, 'You are sending too quickly. Try again shortly.');
      const counters = (
        await db.query(
          'UPDATE conversations SET last_seq=last_seq+1,last_change=last_change+1 WHERE id=$1 RETURNING last_seq,last_change',
          [id],
        )
      ).rows[0];
      const row = (
        await db.query(
          'INSERT INTO messages(conversation_id,author_id,client_id,request_hash,seq,change,body,reply_to_id,thread_root_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            id,
            user.id,
            clientId,
            requestHash,
            counters.last_seq,
            counters.last_change,
            raw,
            replyToId,
            threadRootId,
          ],
        )
      ).rows[0];
      return {
        message: (
          await hydrateMessages(db, user.id, c, [
            { ...row, username: user.username, display_name: user.displayName },
          ])
        )[0]!,
        created: true,
      };
    });
  }
  async edit(
    token: string,
    id: string,
    messageId: string,
    value: unknown,
    remove = false,
  ): Promise<ChatMessage> {
    const raw = remove ? null : content(input(value, ['body']).body);
    return this.run(token, async (db, user) => {
      const c = await this.access(db, user.id, uuid(id));
      const row = (
        await db.query(
          "SELECT m.* FROM messages m WHERE m.id=$1 AND m.conversation_id=$3 AND ($4='channel' OR " +
            visible +
            ')',
          [uuid(messageId), user.id, id, c.kind],
        )
      ).rows[0];
      if (!row || row.deleted_at) throw missing();
      if (row.author_id !== user.id)
        throw new HttpError(403, 'Only the author can change this message.');
      const counters = (
        await db.query(
          'UPDATE conversations SET last_change=last_change+1 WHERE id=$1 RETURNING last_change',
          [id],
        )
      ).rows[0];
      const result = (
        await db.query(
          'UPDATE messages SET body=$1,change=$2,edited_at=CASE WHEN $3 THEN edited_at ELSE now() END,deleted_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$4 RETURNING *',
          [raw, counters.last_change, remove, messageId],
        )
      ).rows[0];
      return (
        await hydrateMessages(db, user.id, c, [
          { ...result, username: user.username, display_name: user.displayName },
        ])
      )[0]!;
    });
  }
}
