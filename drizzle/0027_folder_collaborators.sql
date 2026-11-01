CREATE TABLE "folder_collaborator" (
	"folder_id" text NOT NULL,
	"login" text NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folder_collaborator_folder_id_login_pk" PRIMARY KEY("folder_id","login")
);
--> statement-breakpoint
ALTER TABLE "folder_collaborator" ADD CONSTRAINT "folder_collaborator_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folder_collaborator_login_idx" ON "folder_collaborator" USING btree ("login");