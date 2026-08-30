ALTER TABLE "agent_request" ADD COLUMN "thread_id" text;--> statement-breakpoint
CREATE INDEX "agent_request_document_thread_idx" ON "agent_request" USING btree ("document_id","thread_id");