import { pgTable, uuid, varchar, timestamp, pgEnum } from 'drizzle-orm/pg-core';
export const approvalStatus = pgEnum('approval_status', ['pending', 'approved']);
// Schema foundation only: no account endpoints or authorization behavior yet.
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: varchar('username', { length: 32 }).notNull().unique(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  status: approvalStatus('status').default('pending').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
