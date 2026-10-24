CREATE TYPE "public"."conversation_kind" AS ENUM('channel', 'dm', 'group');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "conversation_kind" NOT NULL,
	"name" varchar(80),
	"creator_id" uuid,
	"manager_id" uuid,
	"pair_low" uuid,
	"pair_high" uuid,
	"archived" boolean DEFAULT false NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"last_change" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_pair_shape" CHECK (("conversations"."kind"='dm' AND "conversations"."pair_low" IS NOT NULL AND "conversations"."pair_high" IS NOT NULL AND "conversations"."pair_low"<"conversations"."pair_high") OR ("conversations"."kind"<>'dm' AND "conversations"."pair_low" IS NULL AND "conversations"."pair_high" IS NULL)),
	CONSTRAINT "conversation_counters" CHECK ("conversations"."last_seq">=0 AND "conversations"."last_change">=0)
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"inviter_id" uuid NOT NULL,
	"invitee_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "invitation_status" CHECK ("invitations"."status" IN ('pending','accepted','declined','revoked'))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"start_seq" bigint NOT NULL,
	"end_seq" bigint,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "membership_bounds" CHECK ("memberships"."start_seq">0 AND ("memberships"."end_seq" IS NULL OR "memberships"."end_seq">="memberships"."start_seq"-1))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"seq" bigint NOT NULL,
	"change" bigint NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "message_content" CHECK (("messages"."deleted_at" IS NULL AND "messages"."body" IS NOT NULL AND length("messages"."body") BETWEEN 1 AND 4000) OR ("messages"."deleted_at" IS NOT NULL AND "messages"."body" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_pair_low_users_id_fk" FOREIGN KEY ("pair_low") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_pair_high_users_id_fk" FOREIGN KEY ("pair_high") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invitee_id_users_id_fk" FOREIGN KEY ("invitee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_dm_pair" ON "conversations" USING btree ("pair_low","pair_high");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_channel_name" ON "conversations" USING btree (lower("name")) WHERE "conversations"."kind"='channel';--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_pending" ON "invitations" USING btree ("conversation_id","invitee_id") WHERE "invitations"."status"='pending';--> statement-breakpoint
CREATE INDEX "invitation_inbox" ON "invitations" USING btree ("invitee_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_current" ON "memberships" USING btree ("conversation_id","user_id") WHERE "memberships"."end_seq" IS NULL;--> statement-breakpoint
CREATE INDEX "membership_history" ON "memberships" USING btree ("conversation_id","user_id","start_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "message_order" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "message_idempotency" ON "messages" USING btree ("conversation_id","author_id","client_id");--> statement-breakpoint
CREATE INDEX "message_changes" ON "messages" USING btree ("conversation_id","change");--> statement-breakpoint
CREATE INDEX "message_author_rate" ON "messages" USING btree ("author_id","created_at");
--> statement-breakpoint
INSERT INTO conversations(kind,name) VALUES ('channel','general');
