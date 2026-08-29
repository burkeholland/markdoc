CREATE TABLE "ownership_transfer" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_user_json" jsonb NOT NULL,
	"moved_rows_json" jsonb NOT NULL,
	"post_fingerprints_json" jsonb NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL
);
