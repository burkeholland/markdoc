CREATE TABLE "video_upload_part" (
	"upload_id" text NOT NULL,
	"part_index" integer NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "video_upload_part_upload_id_part_index_pk" PRIMARY KEY("upload_id","part_index")
);
--> statement-breakpoint
CREATE TABLE "video_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"chunk_count" integer NOT NULL,
	"storage_key" text NOT NULL,
	"state" text DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "video_upload_part" ADD CONSTRAINT "video_upload_part_upload_id_video_upload_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."video_upload"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_upload" ADD CONSTRAINT "video_upload_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_upload" ADD CONSTRAINT "video_upload_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_upload_created_idx" ON "video_upload" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "video_upload_document_idx" ON "video_upload" USING btree ("document_id");