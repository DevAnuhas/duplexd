CREATE TABLE "assistant_samples" (
	"assistant_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"definitions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_invocations" (
	"call_id" text NOT NULL,
	"invocation_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"tool_name" text NOT NULL,
	"scenario" text NOT NULL,
	"status_code" integer NOT NULL,
	"response_body" jsonb,
	"ready_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_invocations_call_id_invocation_id_pk" PRIMARY KEY("call_id","invocation_id")
);
--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "source" text DEFAULT 'integration' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "test_mode" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "config_source" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "base_assistant_revision" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "config_digest" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "practice_compiler_version" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "practice_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "practice_secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "execution_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "stop_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assistant_samples" ADD CONSTRAINT "assistant_samples_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_samples" ADD CONSTRAINT "assistant_samples_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_invocations" ADD CONSTRAINT "practice_invocations_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_samples_account_idx" ON "assistant_samples" USING btree ("account_id");