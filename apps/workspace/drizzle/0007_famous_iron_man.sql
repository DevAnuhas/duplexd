CREATE TABLE "sandbox_evidence" (
	"call_id" text PRIMARY KEY NOT NULL,
	"last_cursor" integer DEFAULT 0 NOT NULL,
	"total_events" integer DEFAULT 0 NOT NULL,
	"total_bytes" integer DEFAULT 0 NOT NULL,
	"contiguous_seq" integer DEFAULT 0 NOT NULL,
	"final_seq" integer,
	"completion_digest" text,
	"producer_loss" boolean DEFAULT false NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"integrity_conflict" boolean DEFAULT false NOT NULL,
	"reconciled" boolean DEFAULT false NOT NULL,
	"last_empty_at" timestamp with time zone,
	"invalid_window_at" timestamp with time zone,
	"invalid_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_events" ADD COLUMN "ingest_cursor" integer;--> statement-breakpoint
ALTER TABLE "call_events" ADD COLUMN "content_digest" text;--> statement-breakpoint
ALTER TABLE "call_events" ADD COLUMN "byte_length" integer;--> statement-breakpoint
ALTER TABLE "sandbox_evidence" ADD CONSTRAINT "sandbox_evidence_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_events_ingest_cursor_idx" ON "call_events" USING btree ("call_id","ingest_cursor");