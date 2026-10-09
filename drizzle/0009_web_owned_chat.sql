CREATE TABLE "chat_coordinator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_hash" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"claim_window_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_event" ADD COLUMN "request_digest" text;--> statement-breakpoint
ALTER TABLE "chat_run" ADD COLUMN "initiating_session_id" text;--> statement-breakpoint
ALTER TABLE "chat_run" ADD COLUMN "coordinator_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_run" ADD COLUMN "claim_request_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_run" ADD COLUMN "granted_worker_id" text;--> statement-breakpoint
ALTER TABLE "chat_run" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_run" ADD COLUMN "execution_grant_hash" text;--> statement-breakpoint
ALTER TABLE "chat_run" ADD COLUMN "control_grant_hash" text;--> statement-breakpoint
ALTER TABLE "chat_run" ADD COLUMN "grants_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_tool_call" ADD COLUMN "request_digest" text;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_coordinator_credential_idx" ON "chat_coordinator" USING btree ("credential_hash");--> statement-breakpoint
ALTER TABLE "chat_run" ADD CONSTRAINT "chat_run_coordinator_id_chat_coordinator_id_fk" FOREIGN KEY ("coordinator_id") REFERENCES "public"."chat_coordinator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_run_coordinator_claim_idx" ON "chat_run" USING btree ("coordinator_id","claim_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_run_execution_grant_idx" ON "chat_run" USING btree ("execution_grant_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_run_control_grant_idx" ON "chat_run" USING btree ("control_grant_hash");
--> statement-breakpoint
-- The data role cannot update authentication rows. This fixed metadata-only function
-- serializes a fenced operation with Better Auth's ordinary DELETE/UPDATE of its session.
CREATE FUNCTION public.chat_lock_session(p_session_id text, p_user_id text)
RETURNS timestamp LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.expires_at FROM public.session s JOIN public."user" u ON u.id=s.user_id
  WHERE s.id=p_session_id AND s.user_id=p_user_id AND s.expires_at > clock_timestamp()
    AND u.email_verified=true FOR SHARE OF s, u
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.chat_lock_session(text, text) FROM PUBLIC;
