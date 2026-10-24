import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  pgEnum,
  text,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'suspended',
  'removed',
]);
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    username: varchar('username', { length: 32 }).notNull().unique(),
    displayName: varchar('display_name', { length: 80 }).notNull(),
    status: approvalStatus('status').default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('users_username_lower_unique').on(sql`lower(${table.username})`)],
);
export const credentials = pgTable('credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  passwordHash: text('password_hash').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
});
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    csrfToken: varchar('csrf_token', { length: 64 }).notNull(),
    remember: boolean('remember').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    deviceLabel: varchar('device_label', { length: 80 }).notNull(),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_expiry_idx').on(table.expiresAt),
  ],
);
export const platform = pgTable(
  'platform',
  {
    id: integer('id').primaryKey().default(1),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
  },
  (table) => [check('platform_singleton', sql`${table.id}=1`)],
);
export const approvalHistory = pgTable('approval_history', {
  id: uuid('id').defaultRandom().primaryKey(),
  targetId: uuid('target_id')
    .notNull()
    .references(() => users.id),
  actorId: uuid('actor_id')
    .notNull()
    .references(() => users.id),
  action: varchar('action', { length: 32 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conversationKind = pgEnum('conversation_kind', ['channel', 'dm', 'group']);
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: conversationKind('kind').notNull(),
    name: varchar('name', { length: 80 }),
    creatorId: uuid('creator_id').references(() => users.id),
    managerId: uuid('manager_id').references(() => users.id),
    pairLow: uuid('pair_low').references(() => users.id),
    pairHigh: uuid('pair_high').references(() => users.id),
    archived: boolean('archived').default(false).notNull(),
    lastSeq: bigint('last_seq', { mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    lastChange: bigint('last_change', { mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('conversation_dm_pair').on(t.pairLow, t.pairHigh),
    uniqueIndex('conversation_channel_name')
      .on(sql`lower(${t.name})`)
      .where(sql`${t.kind}='channel'`),
    check(
      'conversation_pair_shape',
      sql`(${t.kind}='dm' AND ${t.pairLow} IS NOT NULL AND ${t.pairHigh} IS NOT NULL AND ${t.pairLow}<${t.pairHigh}) OR (${t.kind}<>'dm' AND ${t.pairLow} IS NULL AND ${t.pairHigh} IS NULL)`,
    ),
    check('conversation_counters', sql`${t.lastSeq}>=0 AND ${t.lastChange}>=0`),
  ],
);
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    startSeq: bigint('start_seq', { mode: 'bigint' }).notNull(),
    endSeq: bigint('end_seq', { mode: 'bigint' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('membership_current')
      .on(t.conversationId, t.userId)
      .where(sql`${t.endSeq} IS NULL`),
    index('membership_history').on(t.conversationId, t.userId, t.startSeq),
    check(
      'membership_bounds',
      sql`${t.startSeq}>0 AND (${t.endSeq} IS NULL OR ${t.endSeq}>=${t.startSeq}-1)`,
    ),
  ],
);
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id),
    inviteeId: uuid('invitee_id')
      .notNull()
      .references(() => users.id),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('invitation_pending')
      .on(t.conversationId, t.inviteeId)
      .where(sql`${t.status}='pending'`),
    index('invitation_inbox').on(t.inviteeId, t.status),
    check('invitation_status', sql`${t.status} IN ('pending','accepted','declined','revoked')`),
  ],
);
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    clientId: uuid('client_id').notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    change: bigint('change', { mode: 'bigint' }).notNull(),
    body: text('body'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('message_order').on(t.conversationId, t.seq),
    uniqueIndex('message_idempotency').on(t.conversationId, t.authorId, t.clientId),
    index('message_changes').on(t.conversationId, t.change),
    index('message_author_rate').on(t.authorId, t.createdAt),
    check(
      'message_content',
      sql`(${t.deletedAt} IS NULL AND ${t.body} IS NOT NULL AND length(${t.body}) BETWEEN 1 AND 4000) OR (${t.deletedAt} IS NOT NULL AND ${t.body} IS NULL)`,
    ),
  ],
);

export const voiceChannels = pgTable(
  'voice_channels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 48 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('voice_channel_name').on(sql`lower(${t.name})`)],
);
