CREATE TABLE "mention" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"comment_id" text NOT NULL,
	"mentioned_login" text NOT NULL,
	"by_login" text,
	"snippet" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mention" ADD CONSTRAINT "mention_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mention_comment_login_idx" ON "mention" USING btree ("comment_id","mentioned_login");--> statement-breakpoint
CREATE INDEX "mention_login_idx" ON "mention" USING btree ("mentioned_login");