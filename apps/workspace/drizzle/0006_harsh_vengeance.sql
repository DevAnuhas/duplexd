CREATE TABLE "sandbox_sessions" (
	"attempt_id" text NOT NULL,
	"session_id" text NOT NULL,
	"resource_state" text DEFAULT 'possible' NOT NULL,
	"stop_attempts" integer DEFAULT 0 NOT NULL,
	"next_reconcile_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciliation_blocked" boolean DEFAULT false NOT NULL,
	"reconcile_token" text,
	"confirmed_stopped_at" timestamp with time zone,
	CONSTRAINT "sandbox_sessions_attempt_id_session_id_pk" PRIMARY KEY("attempt_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "dispatch_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "protocol" text;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "resource_state" text DEFAULT 'not_dispatched' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "startup_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "presence_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "runtime_session_id" text;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "runtime_boot_id" text;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "join_ciphertext" text;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "join_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "reporting_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD COLUMN "identity_conflict_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_attempt_id_sandbox_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."sandbox_attempts"("id") ON DELETE cascade ON UPDATE no action;