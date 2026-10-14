CREATE TABLE "extraction_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"claim_id" uuid,
	"grant_hash" text,
	"deadline_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_job_claim_id_unique" UNIQUE("claim_id"),
	CONSTRAINT "extraction_job_grant_hash_unique" UNIQUE("grant_hash")
);
--> statement-breakpoint
CREATE TABLE "extraction_reference" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"file_id" uuid NOT NULL,
	"sealed_labels" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"file_id" uuid NOT NULL,
	"method" text NOT NULL,
	"sealed_config" text NOT NULL,
	"sealed_result" text,
	"result_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extraction_job" ADD CONSTRAINT "extraction_job_id_extraction_run_id_fk" FOREIGN KEY ("id") REFERENCES "public"."extraction_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_job" ADD CONSTRAINT "extraction_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_reference" ADD CONSTRAINT "extraction_reference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_reference" ADD CONSTRAINT "extraction_reference_file_id_wildcard_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."wildcard_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_run" ADD CONSTRAINT "extraction_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_run" ADD CONSTRAINT "extraction_run_file_id_wildcard_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."wildcard_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extraction_job_queue_idx" ON "extraction_job" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "extraction_reference_file_idx" ON "extraction_reference" USING btree ("user_id","file_id","created_at");--> statement-breakpoint
CREATE INDEX "extraction_run_file_idx" ON "extraction_run" USING btree ("user_id","file_id","created_at");
--> statement-breakpoint
ALTER TABLE extraction_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE extraction_run FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_only ON extraction_run FOR ALL
USING (user_id = nullif(current_setting('app.user_id', true), ''))
WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
ALTER TABLE extraction_reference ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE extraction_reference FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_only ON extraction_reference FOR ALL
USING (user_id = nullif(current_setting('app.user_id', true), ''))
WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
ALTER TABLE extraction_job ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE extraction_job FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_only ON extraction_job FOR ALL
USING (user_id = nullif(current_setting('app.user_id', true), ''))
WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
-- Trusted web code can discover/claim queue metadata; this does not grant content access.
CREATE POLICY web_dispatch ON extraction_job FOR ALL
USING (current_setting('app.extraction_dispatch', true) = '1')
WITH CHECK (current_setting('app.extraction_dispatch', true) = '1');
