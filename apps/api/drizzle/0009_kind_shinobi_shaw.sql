CREATE TABLE "message_attachments" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"mime_type" varchar(32) NOT NULL,
	"size" integer NOT NULL,
	"image" "bytea" NOT NULL,
	CONSTRAINT "message_attachment_mime" CHECK ("message_attachments"."mime_type" IN ('image/png','image/jpeg','image/webp')),
	CONSTRAINT "message_attachment_size" CHECK ("message_attachments"."size" BETWEEN 1 AND 8388608 AND octet_length("message_attachments"."image")="message_attachments"."size")
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "message_content";--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "message_content" CHECK (("messages"."deleted_at" IS NULL AND "messages"."body" IS NOT NULL AND length("messages"."body") BETWEEN 0 AND 4000) OR ("messages"."deleted_at" IS NOT NULL AND "messages"."body" IS NULL));