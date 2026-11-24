CREATE TABLE "daily_usage" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "daily_usage_user_id_day_kind_pk" PRIMARY KEY("user_id","day","kind")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
UPDATE "user" SET "created_at" = (
	SELECT min("at") FROM (
		SELECT min("created_at") AS "at" FROM "document" WHERE "owner_id" = "user"."id"
		UNION ALL SELECT min("created_at") FROM "folder" WHERE "owner_id" = "user"."id"
		UNION ALL SELECT min("created_at") FROM "api_token" WHERE "user_id" = "user"."id"
	) AS "first_seen"
);--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_usage_day_idx" ON "daily_usage" USING btree ("day");