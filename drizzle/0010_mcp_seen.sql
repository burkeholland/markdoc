ALTER TABLE "api_token" ADD COLUMN "last_mcp_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "last_mcp_call_at" timestamp with time zone;