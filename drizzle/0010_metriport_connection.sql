CREATE TABLE "metriport_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"persona" text,
	"sealed_patient_id" text NOT NULL,
	"facility_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metriport_connection_source_id_unique" UNIQUE("source_id")
);
--> statement-breakpoint
ALTER TABLE "metriport_connection" ADD CONSTRAINT "metriport_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metriport_connection" ADD CONSTRAINT "metriport_connection_source_id_health_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."health_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metriport_connection_user_persona_idx" ON "metriport_connection" USING btree ("user_id","persona");--> statement-breakpoint
ALTER TABLE "metriport_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "metriport_connection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "metriport_connection" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));
