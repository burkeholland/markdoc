CREATE TABLE "agent_request" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"user_id" text NOT NULL,
	"instruction" text NOT NULL,
	"selection" jsonb,
	"mode" text DEFAULT 'suggest' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"claimed_by" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_request" ADD CONSTRAINT "agent_request_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_request" ADD CONSTRAINT "agent_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_request_document_status_idx" ON "agent_request" USING btree ("document_id","status");--> statement-breakpoint
CREATE INDEX "agent_request_status_created_idx" ON "agent_request" USING btree ("status","created_at" DESC NULLS LAST);