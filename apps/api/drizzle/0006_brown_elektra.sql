CREATE TABLE "conversation_alert_preferences" (
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"mode" varchar(16) NOT NULL,
	CONSTRAINT "conversation_alert_preferences_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id"),
	CONSTRAINT "conversation_alert_mode" CHECK ("conversation_alert_preferences"."mode" IN ('all','mentions','muted'))
);
--> statement-breakpoint
CREATE TABLE "message_mentions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "message_mentions_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message_pins" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"pinned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" varchar(32) NOT NULL,
	CONSTRAINT "message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "sender_alert_preferences" (
	"user_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"priority" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sender_alert_preferences_user_id_sender_id_pk" PRIMARY KEY("user_id","sender_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "thread_root_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_alert_preferences" ADD CONSTRAINT "conversation_alert_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_alert_preferences" ADD CONSTRAINT "conversation_alert_preferences_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_pins" ADD CONSTRAINT "message_pins_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_pins" ADD CONSTRAINT "message_pins_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_alert_preferences" ADD CONSTRAINT "sender_alert_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_alert_preferences" ADD CONSTRAINT "sender_alert_preferences_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_mentions_user" ON "message_mentions" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_conversation_id" ON "messages" USING btree ("conversation_id","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "message_reply_conversation" FOREIGN KEY ("conversation_id","reply_to_id") REFERENCES "public"."messages"("conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "message_thread_conversation" FOREIGN KEY ("conversation_id","thread_root_id") REFERENCES "public"."messages"("conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_thread_order" ON "messages" USING btree ("conversation_id","thread_root_id","seq");--> statement-breakpoint
CREATE INDEX "message_reply_target" ON "messages" USING btree ("reply_to_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "message_reply_shape" CHECK (("messages"."reply_to_id" IS NULL AND "messages"."thread_root_id" IS NULL) OR ("messages"."reply_to_id" IS NOT NULL AND "messages"."thread_root_id" IS NOT NULL AND "messages"."reply_to_id"<>"messages"."id" AND "messages"."thread_root_id"<>"messages"."id"));--> statement-breakpoint
-- Keep resolved mentions and deletion cleanup correct for older server-image writes, too.
CREATE FUNCTION maintain_message_features() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM message_mentions WHERE message_id=NEW.id;
  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM message_pins WHERE message_id=NEW.id;
    DELETE FROM message_reactions WHERE message_id=NEW.id;
  ELSE
    INSERT INTO message_mentions(message_id,user_id)
    SELECT NEW.id,u.id FROM users u JOIN conversations c ON c.id=NEW.conversation_id
    WHERE u.status='approved' AND u.id<>NEW.author_id
      AND NEW.body ~* ('(^|[^a-zA-Z0-9_@])@' || u.username || '($|[^a-zA-Z0-9_])')
      AND (c.kind='channel' OR (
        EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=u.id AND h.end_seq IS NULL)
        AND EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=u.id
          AND NEW.seq>=h.start_seq AND (h.end_seq IS NULL OR NEW.seq<=h.end_seq))
      ));
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER message_features_compatibility AFTER INSERT OR UPDATE OF body,deleted_at ON messages
FOR EACH ROW EXECUTE FUNCTION maintain_message_features();--> statement-breakpoint
INSERT INTO message_mentions(message_id,user_id)
SELECT m.id,u.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
JOIN users u ON u.status='approved' AND u.id<>m.author_id
WHERE m.deleted_at IS NULL
  AND m.body ~* ('(^|[^a-zA-Z0-9_@])@' || u.username || '($|[^a-zA-Z0-9_])')
  AND (c.kind='channel' OR (
    EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=u.id AND h.end_seq IS NULL)
    AND EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=u.id
      AND m.seq>=h.start_seq AND (h.end_seq IS NULL OR m.seq<=h.end_seq))
  ));