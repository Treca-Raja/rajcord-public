import type { PoolClient } from 'pg';
import type { AuthUser, Conversation, ChatMessage, MessagePage, Invitation } from '@tricord/shared';
import { AuthService, approved, identity, digest } from '../auth/service.js';
import { HttpError, input, text, uuid } from '../auth/validation.js';
const missing = () => new HttpError(404, 'Conversation or message not found.');
const visible =
  'EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=m.conversation_id AND h.user_id=$2 AND m.seq>=h.start_seq AND (h.end_seq IS NULL OR m.seq<=h.end_seq))';
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
function message(row: Record<string, unknown>): ChatMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    clientId: String(row.client_id),
    seq: String(row.seq),
    change: String(row.change),
    author: {
      id: String(row.author_id),
      username: String(row.username),
      displayName: String(row.display_name),
    },
    body: row.deleted_at ? null : String(row.body),
    deleted: !!row.deleted_at,
    createdAt: (row.created_at as Date).toISOString(),
    editedAt: row.edited_at ? (row.edited_at as Date).toISOString() : null,
  };
}
export class ChatService extends AuthService {
  async run<T>(token: string, work: (db: PoolClient, user: AuthUser) => Promise<T>) {
    return this.transaction(async (db) => work(db, approved(await identity(db, token)).user));
  }
  async access(db: PoolClient, userId: string, id: string) {
    const row = (
      await db.query(
        "SELECT c.* FROM conversations c WHERE c.id=$1 AND (c.kind='channel' OR EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=$2 AND h.end_seq IS NULL)) FOR UPDATE",
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
        count(m.id) FILTER (WHERE m.body ~* ('(^|[^a-zA-Z0-9_@])@' || u.username || '($|[^a-zA-Z0-9_])'))::int mention_count
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
          "SELECT c.id FROM conversations c WHERE c.kind='channel' OR EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=$1 AND h.end_seq IS NULL) ORDER BY c.created_at,c.id",
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
  // Central contact-policy boundary for future blocking; no implicit admin bypass.
  async contact(db: PoolClient, userId: string, target: string) {
    if (target === userId) throw new HttpError(400, 'Choose another member.');
    if (
      !(await db.query("SELECT id FROM users WHERE id=$1 AND status='approved'", [target])).rowCount
    )
      throw missing();
  }
  async create(token: string, value: unknown) {
    const body = input(value, ['kind', 'name', 'userId', 'userIds']);
    if (!['channel', 'dm', 'group'].includes(String(body.kind)))
      throw new HttpError(400, 'Invalid conversation type.');
    return this.run(token, async (db, user) => {
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
        let name = text(body.name, 1, 80, 'conversation name');
        if (body.kind === 'channel') {
          name = name.toLowerCase();
          if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name))
            throw new HttpError(400, 'Use 1–48 lowercase letters, numbers or hyphens.');
          if (
            (
              await db.query(
                "SELECT id FROM conversations WHERE kind='channel' AND lower(name)=$1",
                [name],
              )
            ).rowCount
          )
            throw new HttpError(409, 'Channel name already exists.');
        }
        let invitees: string[] = [];
        if (body.kind === 'group' && body.userIds !== undefined) {
          if (!Array.isArray(body.userIds) || body.userIds.length > 9)
            throw new HttpError(400, 'Choose up to nine members.');
          invitees = [...new Set(body.userIds.map(uuid))];
          for (const target of invitees) await this.contact(db, user.id, target);
        }
        id = (
          await db.query(
            'INSERT INTO conversations(kind,name,creator_id,manager_id) VALUES($1,$2,$3,$4) RETURNING id',
            [body.kind, name, user.id, body.kind === 'group' ? user.id : null],
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
    const body = input(value, ['name', 'archived']);
    return this.run(token, async (db, user) => {
      const c = await this.access(db, user.id, uuid(id));
      if (c.kind === 'dm' || (c.kind === 'group' && c.manager_id !== user.id))
        throw new HttpError(403, 'Only the group manager can rename this conversation.');
      if (body.name !== undefined) {
        let name = text(body.name, 1, 80, 'conversation name');
        if (c.kind === 'channel') {
          name = name.toLowerCase();
          if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name))
            throw new HttpError(400, 'Invalid channel name.');
          if (
            (
              await db.query(
                "SELECT id FROM conversations WHERE kind='channel' AND lower(name)=$1 AND id<>$2",
                [name, id],
              )
            ).rowCount
          )
            throw new HttpError(409, 'Channel name already exists.');
        }
        await db.query('UPDATE conversations SET name=$1 WHERE id=$2', [name, id]);
      }
      if (body.archived !== undefined) {
        if (c.kind !== 'channel' || typeof body.archived !== 'boolean')
          throw new HttpError(400, 'Only channels can be archived or restored.');
        await db.query('UPDATE conversations SET archived=$1 WHERE id=$2', [body.archived, id]);
      }
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
        messages: (after !== undefined ? selected : selected.reverse()).map(message),
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
      return message(row);
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
    const body = input(value, ['body', 'clientId']);
    const raw = content(body.body),
      clientId = uuid(body.clientId);
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
        if (previous.request_hash !== digest(raw))
          throw new HttpError(409, 'This message identifier was already used.');
        return { message: message(previous), created: false };
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
          'INSERT INTO messages(conversation_id,author_id,client_id,request_hash,seq,change,body) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [id, user.id, clientId, digest(raw), counters.last_seq, counters.last_change, raw],
        )
      ).rows[0];
      return {
        message: message({ ...row, username: user.username, display_name: user.displayName }),
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
      return message({ ...result, username: user.username, display_name: user.displayName });
    });
  }
}
