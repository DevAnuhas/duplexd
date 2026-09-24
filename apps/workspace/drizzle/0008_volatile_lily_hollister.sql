CREATE TYPE "public"."observation_answer" AS ENUM('met', 'needs_work', 'not_checked');--> statement-breakpoint
CREATE TABLE "call_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"author_user_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"checklist_version" integer DEFAULT 1 NOT NULL,
	"heard_expected_answer" "observation_answer" DEFAULT 'not_checked' NOT NULL,
	"correct_tool_outcome" "observation_answer" DEFAULT 'not_checked' NOT NULL,
	"honest_failure_speech" "observation_answer" DEFAULT 'not_checked' NOT NULL,
	"acceptable_interruption_waiting" "observation_answer" DEFAULT 'not_checked' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_observations" ADD CONSTRAINT "call_observations_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_observations" ADD CONSTRAINT "call_observations_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_observations_call_author_idx" ON "call_observations" USING btree ("call_id","author_user_id");