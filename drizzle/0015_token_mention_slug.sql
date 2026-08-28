ALTER TABLE "api_token" ADD COLUMN "mention_slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "api_token_user_mention_slug_unique" ON "api_token" USING btree ("user_id","mention_slug");