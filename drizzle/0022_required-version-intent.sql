CREATE TABLE "required_version_intent" (
	"document_id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"created_by" text,
	"created_by_name" text,
	"applied" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "required_version_intent_version_id_unique" UNIQUE("version_id")
);
--> statement-breakpoint
ALTER TABLE "required_version_intent" ADD CONSTRAINT "required_version_intent_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;