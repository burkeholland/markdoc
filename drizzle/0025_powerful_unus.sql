CREATE TABLE "video_stream_slot" (
	"id" integer PRIMARY KEY NOT NULL,
	"lease_id" text,
	"lease_until" timestamp with time zone NOT NULL
);
