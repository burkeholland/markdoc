ALTER TABLE "api_token" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "document_ids" text[];