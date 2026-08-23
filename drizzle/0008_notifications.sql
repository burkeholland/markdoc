CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"user_login" text NOT NULL,
	"document_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_login" text,
	"actor_name" text,
	"ref_id" text NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_user_kind_ref_idx" ON "notification" USING btree ("user_login","kind","ref_id");--> statement-breakpoint
CREATE INDEX "notification_user_read_created_idx" ON "notification" USING btree ("user_login","read_at","created_at" DESC NULLS LAST);--> statement-breakpoint
-- Hand-written (drizzle-kit only generates DDL): carry existing @mentions over as notifications of kind 'mention',
-- then drop the old table. ref_id is the comment/reply id the mention appeared in; snippets are clipped to 120 chars.
INSERT INTO "notification" ("id", "user_login", "document_id", "kind", "actor_login", "actor_name", "ref_id", "snippet", "created_at", "read_at")
SELECT "id", lower("mentioned_login"), "document_id", 'mention', "by_login", "by_login", "comment_id", left("snippet", 120), "created_at", "read_at"
FROM "mention"
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TABLE "mention" CASCADE;
