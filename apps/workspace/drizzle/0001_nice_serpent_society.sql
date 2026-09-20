CREATE TABLE "call_rate_limits" (
	"api_key_id" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "call_rate_limits_api_key_id_window_started_at_pk" PRIMARY KEY("api_key_id","window_started_at")
);
--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "assistant_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "duration_secs" SET DATA TYPE numeric(12, 3);--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "agent_token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "config_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_rate_limits" ADD CONSTRAINT "call_rate_limits_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_starting_idx" ON "calls" USING btree ("state") WHERE "calls"."state" = 'starting';