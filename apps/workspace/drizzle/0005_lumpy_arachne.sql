CREATE TABLE "sandbox_admission_rate_limits" (
	"account_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "sandbox_admission_rate_limits_account_id_subject_type_subject_id_window_started_at_pk" PRIMARY KEY("account_id","subject_type","subject_id","window_started_at")
);
--> statement-breakpoint
CREATE TABLE "sandbox_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"initiated_by_user_id" text,
	"call_id" text NOT NULL,
	"client_attempt_id" text NOT NULL,
	"input_digest" text NOT NULL,
	"controller_proof_hash" text NOT NULL,
	"state" text NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reservation_expires_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"stop_requested_at" timestamp with time zone,
	"stop_reason" text,
	"canceled_at" timestamp with time zone,
	"expired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sandbox_slots" (
	"account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_slots_account_id_user_id_pk" PRIMARY KEY("account_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "agent_token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "initiated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "channel" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "snapshot_version" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "scenario_revision" integer;--> statement-breakpoint
ALTER TABLE "sandbox_admission_rate_limits" ADD CONSTRAINT "sandbox_admission_rate_limits_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD CONSTRAINT "sandbox_attempts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD CONSTRAINT "sandbox_attempts_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD CONSTRAINT "sandbox_attempts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_slots" ADD CONSTRAINT "sandbox_slots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_slots" ADD CONSTRAINT "sandbox_slots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_slots" ADD CONSTRAINT "sandbox_slots_attempt_id_sandbox_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."sandbox_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_attempts_owner_client_idx" ON "sandbox_attempts" USING btree ("account_id","initiated_by_user_id","client_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_attempts_call_idx" ON "sandbox_attempts" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "sandbox_attempts_account_state_idx" ON "sandbox_attempts" USING btree ("account_id","state");--> statement-breakpoint
CREATE INDEX "sandbox_attempts_reservation_expiry_idx" ON "sandbox_attempts" USING btree ("reservation_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_slots_attempt_idx" ON "sandbox_slots" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "sandbox_slots_account_idx" ON "sandbox_slots" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;