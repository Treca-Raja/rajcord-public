CREATE TABLE "voice_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(48) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "voice_channel_name" ON "voice_channels" USING btree (lower("name"));
--> statement-breakpoint
INSERT INTO voice_channels(name) VALUES ('The lounge');
