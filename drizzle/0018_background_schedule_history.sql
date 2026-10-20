CREATE TABLE "background_job_run" (
	"id" text PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"due" integer DEFAULT 0 NOT NULL,
	"queued" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "background_job_run_job_started_idx" ON "background_job_run" USING btree ("job","started_at" DESC NULLS LAST);
