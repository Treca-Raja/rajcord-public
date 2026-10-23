import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  pgEnum,
  text,
  boolean,
  integer,
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
