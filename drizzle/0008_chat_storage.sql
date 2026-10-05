-- Encrypted personal chat state. Existing record-table policies deliberately retain their
-- compatibility fallback for background sync; these new tables are fail-closed from day one.
CREATE TABLE "chat_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"sealed_title" text,
	"archived_at" timestamp with time zone,
	"next_message_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"sealed_content" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"parent_message_id" uuid NOT NULL,
	"assistant_message_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"execution_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"cancellation_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"next_event_sequence" integer DEFAULT 0 NOT NULL,
	"next_worker_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_tool_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"call_order" integer NOT NULL,
	"tool_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sealed_arguments" text NOT NULL,
	"sealed_context" text,
	"sealed_result" text,
	"result_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"worker_sequence" integer NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"sealed_payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"originating_run_id" uuid,
	"idempotency_key" text NOT NULL,
	"sealed_title" text NOT NULL,
	"sealed_content" text NOT NULL,
	"freshness" text DEFAULT 'fresh' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "summary_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"summary_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"record_id" uuid,
	"attachment_id" uuid,
	"sealed_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- A deleted source record leaves an encrypted provenance descriptor and a null target. Reading
	-- the summary marks it stale; do not block a source/account purge with this evidence row.
	CONSTRAINT "summary_evidence_target_kind" CHECK (("kind" = 'record' AND "attachment_id" IS NULL) OR ("kind" = 'note' AND "record_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_conversation_id_chat_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_run" ADD CONSTRAINT "chat_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_run" ADD CONSTRAINT "chat_run_conversation_id_chat_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_run" ADD CONSTRAINT "chat_run_parent_message_id_chat_message_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."chat_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_run" ADD CONSTRAINT "chat_run_assistant_message_id_chat_message_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."chat_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_tool_call" ADD CONSTRAINT "chat_tool_call_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_tool_call" ADD CONSTRAINT "chat_tool_call_conversation_id_chat_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_tool_call" ADD CONSTRAINT "chat_tool_call_run_id_chat_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_event" ADD CONSTRAINT "chat_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_event" ADD CONSTRAINT "chat_event_conversation_id_chat_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_event" ADD CONSTRAINT "chat_event_run_id_chat_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_summary" ADD CONSTRAINT "user_summary_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_summary" ADD CONSTRAINT "user_summary_originating_run_id_chat_run_id_fk" FOREIGN KEY ("originating_run_id") REFERENCES "public"."chat_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_evidence" ADD CONSTRAINT "summary_evidence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_evidence" ADD CONSTRAINT "summary_evidence_summary_id_user_summary_id_fk" FOREIGN KEY ("summary_id") REFERENCES "public"."user_summary"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_evidence" ADD CONSTRAINT "summary_evidence_record_id_fhir_resource_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."fhir_resource"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_evidence" ADD CONSTRAINT "summary_evidence_attachment_id_fhir_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."fhir_attachment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversation_user_updated_idx" ON "chat_conversation" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversation_user_id_idx" ON "chat_conversation" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_conversation_sequence_idx" ON "chat_message" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_owner_parent_idx" ON "chat_message" USING btree ("user_id","conversation_id","id");--> statement-breakpoint
CREATE INDEX "chat_message_user_conversation_idx" ON "chat_message" USING btree ("user_id","conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_run_user_idempotency_idx" ON "chat_run" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_run_owner_parent_idx" ON "chat_run" USING btree ("user_id","conversation_id","id");--> statement-breakpoint
CREATE INDEX "chat_run_claim_idx" ON "chat_run" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "chat_run_user_conversation_idx" ON "chat_run" USING btree ("user_id","conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_tool_call_run_order_idx" ON "chat_tool_call" USING btree ("run_id","call_order");--> statement-breakpoint
CREATE INDEX "chat_tool_call_user_run_idx" ON "chat_tool_call" USING btree ("user_id","run_id","call_order");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_event_run_sequence_idx" ON "chat_event" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_event_run_attempt_event_idx" ON "chat_event" USING btree ("run_id","attempt","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_event_run_attempt_worker_sequence_idx" ON "chat_event" USING btree ("run_id","attempt","worker_sequence");--> statement-breakpoint
CREATE INDEX "chat_event_user_run_idx" ON "chat_event" USING btree ("user_id","run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "user_summary_user_idempotency_idx" ON "user_summary" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "user_summary_owner_parent_idx" ON "user_summary" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "user_summary_user_updated_idx" ON "user_summary" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "summary_evidence_user_summary_idx" ON "summary_evidence" USING btree ("user_id","summary_id");--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_owner_conversation_fk" FOREIGN KEY ("user_id","conversation_id") REFERENCES "public"."chat_conversation"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_run" ADD CONSTRAINT "chat_run_owner_conversation_fk" FOREIGN KEY ("user_id","conversation_id") REFERENCES "public"."chat_conversation"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_run" ADD CONSTRAINT "chat_run_owner_parent_message_fk" FOREIGN KEY ("user_id","conversation_id","parent_message_id") REFERENCES "public"."chat_message"("user_id","conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_run" ADD CONSTRAINT "chat_run_owner_assistant_message_fk" FOREIGN KEY ("user_id","conversation_id","assistant_message_id") REFERENCES "public"."chat_message"("user_id","conversation_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_tool_call" ADD CONSTRAINT "chat_tool_call_owner_run_fk" FOREIGN KEY ("user_id","conversation_id","run_id") REFERENCES "public"."chat_run"("user_id","conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_event" ADD CONSTRAINT "chat_event_owner_run_fk" FOREIGN KEY ("user_id","conversation_id","run_id") REFERENCES "public"."chat_run"("user_id","conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_evidence" ADD CONSTRAINT "summary_evidence_owner_summary_fk" FOREIGN KEY ("user_id","summary_id") REFERENCES "public"."user_summary"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- New personal tables never inherit the legacy no-context fallback. A connection has to set
-- app.user_id transaction-locally through asUser before it can see or modify any chat row.
ALTER TABLE "chat_conversation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_conversation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "chat_conversation" FOR ALL USING ("user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
ALTER TABLE "chat_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "chat_message" FOR ALL USING ("user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
ALTER TABLE "chat_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "chat_run" FOR ALL USING ("user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
ALTER TABLE "chat_tool_call" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_tool_call" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "chat_tool_call" FOR ALL USING ("user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
ALTER TABLE "chat_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "chat_event" FOR ALL USING ("user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
ALTER TABLE "user_summary" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_summary" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "user_summary" FOR ALL USING ("user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
ALTER TABLE "summary_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "summary_evidence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "summary_evidence" FOR ALL USING ("user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), ''));
