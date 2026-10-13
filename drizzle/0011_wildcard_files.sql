CREATE TABLE "wildcard_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"sealed_metadata" text NOT NULL,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wildcard_file_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
ALTER TABLE "wildcard_file" ADD CONSTRAINT "wildcard_file_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wildcard_file_user_uploaded_idx" ON "wildcard_file" USING btree ("user_id","uploaded_at");
--> statement-breakpoint
ALTER TABLE "wildcard_file" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "wildcard_file" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "owner_only" ON "wildcard_file" FOR ALL
USING ("user_id" = nullif(current_setting('app.user_id', true), ''))
WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), ''));
