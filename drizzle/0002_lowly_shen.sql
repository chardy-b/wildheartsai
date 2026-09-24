CREATE TABLE "epic_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"fhir_base_url" text NOT NULL,
	"organization_name" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"sealed_patient_id" text NOT NULL,
	"sealed_access_token" text NOT NULL,
	"sealed_refresh_token" text,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "epic_connection" ADD CONSTRAINT "epic_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "epic_connection_user_org_idx" ON "epic_connection" USING btree ("user_id","fhir_base_url");