CREATE TABLE "chat_model_warmup" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"model_fingerprint" text NOT NULL,
	"coordinator_id" uuid,
	"lease_id" uuid,
	"claim_request_id" uuid,
	"lease_owner" text,
	"grant_hash" text,
	"lease_expires_at" timestamp with time zone,
	"ready_until" timestamp with time zone,
	"retry_after_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
