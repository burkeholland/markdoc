ALTER TABLE "agent_request" ADD COLUMN "agent_login" text;--> statement-breakpoint
ALTER TABLE "agent_request" ADD COLUMN "agent_slug" text;--> statement-breakpoint
ALTER TABLE "agent_request" ADD COLUMN "claimed_by_login" text;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "collaborators_may_ask" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_request_agent_status_idx" ON "agent_request" USING btree ("agent_login","agent_slug","status");