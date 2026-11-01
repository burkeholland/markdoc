CREATE TABLE "video_storage_cleanup" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "video_storage_cleanup_created_idx" ON "video_storage_cleanup" USING btree ("created_at");