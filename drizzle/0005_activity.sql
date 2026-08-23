CREATE TABLE "activity" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"actor_id" text,
	"actor_name" text NOT NULL,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_document_created_idx" ON "activity" USING btree ("document_id","created_at" DESC NULLS LAST);