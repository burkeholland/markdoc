CREATE TABLE "folder_notification" (
	"id" text PRIMARY KEY NOT NULL,
	"user_login" text NOT NULL,
	"folder_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_login" text,
	"actor_name" text,
	"ref_id" text NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "folder" ADD COLUMN "link_access" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "folder_notification" ADD CONSTRAINT "folder_notification_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folder_notification_user_kind_ref_idx" ON "folder_notification" USING btree ("user_login","kind","ref_id");--> statement-breakpoint
CREATE INDEX "folder_notification_user_read_created_idx" ON "folder_notification" USING btree ("user_login","read_at","created_at" DESC NULLS LAST);