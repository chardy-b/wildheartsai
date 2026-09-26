CREATE TABLE "fhir_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"sealed_url" text NOT NULL,
	"url_hmac" text NOT NULL,
	"content_type" text,
	"size" integer,
	"sealed_text" text,
	"sealed_bytes" text,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fhir_resource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"fhir_id" text NOT NULL,
	"category" text,
	"effective_at" timestamp with time zone,
	"date_precision" text,
	"source_version_id" text,
	"source_updated_at" timestamp with time zone,
	"content_hmac" text NOT NULL,
	"sealed_resource" text NOT NULL,
	"sealed_summary" text NOT NULL,
	"normalizer_version" integer NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "health_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"vendor" text NOT NULL,
	"fhir_base_url" text NOT NULL,
	"organization_name" text NOT NULL,
	"status" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_cursor" (
	"source_id" uuid NOT NULL,
	"query_key" text NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_full_at" timestamp with time zone,
	"supports_last_updated" boolean,
	CONSTRAINT "sync_cursor_source_id_query_key_pk" PRIMARY KEY("source_id","query_key")
);
--> statement-breakpoint
CREATE TABLE "sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_data_key" (
	"user_id" text PRIMARY KEY NOT NULL,
	"sealed_dek" text NOT NULL,
	"kek_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-edited: every existing connection gets a health_source, then source_id becomes required.
ALTER TABLE "epic_connection" ADD COLUMN "source_id" uuid;--> statement-breakpoint
INSERT INTO "health_source" ("user_id", "vendor", "fhir_base_url", "organization_name", "status", "created_at", "updated_at")
SELECT "user_id", 'epic', "fhir_base_url", "organization_name", 'connected', "created_at", "updated_at" FROM "epic_connection";--> statement-breakpoint
UPDATE "epic_connection" AS c SET "source_id" = s."id" FROM "health_source" AS s
WHERE s."user_id" = c."user_id" AND s."fhir_base_url" = c."fhir_base_url";--> statement-breakpoint
ALTER TABLE "epic_connection" ALTER COLUMN "source_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fhir_attachment" ADD CONSTRAINT "fhir_attachment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fhir_attachment" ADD CONSTRAINT "fhir_attachment_source_id_health_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."health_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fhir_attachment" ADD CONSTRAINT "fhir_attachment_resource_id_fhir_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."fhir_resource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fhir_resource" ADD CONSTRAINT "fhir_resource_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fhir_resource" ADD CONSTRAINT "fhir_resource_source_id_health_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."health_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fhir_resource" ADD CONSTRAINT "fhir_resource_superseded_by_fhir_resource_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."fhir_resource"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_source" ADD CONSTRAINT "health_source_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursor" ADD CONSTRAINT "sync_cursor_source_id_health_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."health_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_source_id_health_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."health_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_data_key" ADD CONSTRAINT "user_data_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fhir_attachment_source_url_idx" ON "fhir_attachment" USING btree ("source_id","url_hmac");--> statement-breakpoint
CREATE UNIQUE INDEX "fhir_resource_current_idx" ON "fhir_resource" USING btree ("source_id","resource_type","fhir_id") WHERE "fhir_resource"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "fhir_resource_timeline_idx" ON "fhir_resource" USING btree ("user_id","effective_at" DESC NULLS LAST,"id") WHERE "fhir_resource"."superseded_at" is null and "fhir_resource"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "fhir_resource_category_idx" ON "fhir_resource" USING btree ("user_id","category","effective_at" DESC NULLS LAST,"id") WHERE "fhir_resource"."superseded_at" is null and "fhir_resource"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "health_source_user_url_idx" ON "health_source" USING btree ("user_id","fhir_base_url");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_run_active_idx" ON "sync_run" USING btree ("source_id") WHERE "sync_run"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "sync_run_source_idx" ON "sync_run" USING btree ("source_id","queued_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "epic_connection" ADD CONSTRAINT "epic_connection_source_id_health_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."health_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epic_connection" ADD CONSTRAINT "epic_connection_source_id_unique" UNIQUE("source_id");