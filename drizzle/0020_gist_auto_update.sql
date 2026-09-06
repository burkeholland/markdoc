CREATE TABLE "gist_auto_update" (
	"document_id" text PRIMARY KEY NOT NULL,
	"publisher_id" text NOT NULL,
	"gist_id" text NOT NULL,
	"filename" text NOT NULL,
	"account_login" text NOT NULL,
	"is_public" boolean NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	"generation" text NOT NULL,
	"queued_version" integer DEFAULT 1 NOT NULL,
	"synced_version" integer DEFAULT 0 NOT NULL,
	"active_version" integer,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'off' NOT NULL,
	"synced_at" timestamp with time zone,
	"message" text
);
--> statement-breakpoint
ALTER TABLE "gist_auto_update" ADD CONSTRAINT "gist_auto_update_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gist_auto_update_due_idx" ON "gist_auto_update" USING btree ("enabled","status","due_at");
--> statement-breakpoint
CREATE FUNCTION markdoc_queue_gist_save() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage <> 'gist' OR NEW.gist_id IS DISTINCT FROM OLD.gist_id
     OR NEW.gist_file IS DISTINCT FROM OLD.gist_file OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.deleted_at IS NOT NULL THEN
    UPDATE gist_auto_update SET enabled = false, status = 'off', message = NULL
    WHERE document_id = NEW.id;
  ELSIF NEW.content IS DISTINCT FROM OLD.content OR NEW.ystate IS DISTINCT FROM OLD.ystate THEN
    UPDATE gist_auto_update
    SET queued_version = queued_version + 1,
        due_at = GREATEST(NEW.updated_at, clock_timestamp()) + interval '2 seconds',
        status = CASE WHEN status IN ('failed', 'conflict', 'syncing') THEN status ELSE 'pending' END
    WHERE document_id = NEW.id AND enabled;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER document_gist_saved AFTER UPDATE ON "document"
FOR EACH ROW EXECUTE FUNCTION markdoc_queue_gist_save();