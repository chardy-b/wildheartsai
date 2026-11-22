ALTER TABLE "epic_connection" ADD COLUMN "sealed_patient_id_next" text;--> statement-breakpoint
ALTER TABLE "epic_connection" ADD COLUMN "sealed_access_token_next" text;--> statement-breakpoint
ALTER TABLE "epic_connection" ADD COLUMN "sealed_refresh_token_next" text;--> statement-breakpoint
ALTER TABLE "metriport_connection" ADD COLUMN "sealed_patient_id_next" text;