CREATE TABLE "epic_directory_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"fhir_base_url" text NOT NULL,
	"part_of" text,
	"location" text,
	"search_text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epic_directory_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"changed" boolean NOT NULL,
	"organizations" integer NOT NULL,
	"facilities" integer NOT NULL,
	"addresses" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "epic_directory_entry_url_idx" ON "epic_directory_entry" USING btree ("fhir_base_url");