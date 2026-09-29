CREATE TABLE "chat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"sealed_title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"sealed_content" text NOT NULL,
	"model" text,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_user_idx" ON "chat" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_seq_idx" ON "chat_message" USING btree ("chat_id","seq");--> statement-breakpoint
-- Row-level security, as in 0006_row_level_security.sql (see src/lib/db/rls.ts).
ALTER TABLE "chat" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "chat" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "chat_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "chat_message" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));
