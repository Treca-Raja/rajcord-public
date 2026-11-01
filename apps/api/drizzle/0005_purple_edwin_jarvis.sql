CREATE TABLE "channel_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(48) NOT NULL,
	"name_key" varchar(96) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "channel_category_bounds" CHECK ("channel_categories"."position">=0 AND "channel_categories"."revision">=0)
);
--> statement-breakpoint
DROP INDEX "conversation_channel_name";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "name_key" varchar(160);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "topic" varchar(500) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "metadata_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "conversations" SET "name_key"=lower("name") WHERE "kind"='channel';--> statement-breakpoint
-- Older server images write only legacy ASCII names and do not supply metadata revisions.
CREATE FUNCTION maintain_channel_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='channel' THEN
    IF (TG_OP='INSERT' OR NEW.name IS DISTINCT FROM OLD.name)
       AND NEW.name ~ '^[a-z0-9][a-z0-9-]{0,47}$' THEN
      NEW.name_key := NEW.name;
    END IF;
    IF TG_OP='UPDATE' AND NEW.metadata_revision=OLD.metadata_revision
       AND ROW(NEW.name,NEW.topic,NEW.category_id,NEW.position,NEW.archived)
           IS DISTINCT FROM ROW(OLD.name,OLD.topic,OLD.category_id,OLD.position,OLD.archived) THEN
      NEW.metadata_revision := OLD.metadata_revision+1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER conversation_metadata_compatibility BEFORE INSERT OR UPDATE ON "conversations"
FOR EACH ROW EXECUTE FUNCTION maintain_channel_metadata();--> statement-breakpoint
CREATE UNIQUE INDEX "channel_category_name_key" ON "channel_categories" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "channel_category_order" ON "channel_categories" USING btree ("position","id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_category_id_channel_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."channel_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_channel_name_key" ON "conversations" USING btree ("name_key") WHERE "conversations"."kind"='channel';--> statement-breakpoint
CREATE INDEX "conversation_channel_order" ON "conversations" USING btree ("category_id","position","id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversation_metadata_shape" CHECK ("conversations"."position">=0 AND "conversations"."metadata_revision">=0 AND (("conversations"."kind"='channel' AND "conversations"."name_key" IS NOT NULL) OR ("conversations"."kind"<>'channel' AND "conversations"."name_key" IS NULL AND "conversations"."category_id" IS NULL AND "conversations"."topic"='' AND "conversations"."position"=0)));