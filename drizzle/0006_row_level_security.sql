-- Row-level security: see src/lib/db/rls.ts. While app.user_id is set (asUser), these tables
-- only show and accept that user's rows. Unset, everything is visible, as before; a later
-- migration takes that away once every query sets a user or system context.
-- FORCE applies the policies to the tables' owner too, which is the role the app connects as.
-- Roles with SUPERUSER or BYPASSRLS are never subject to RLS: check with `npm run db:check-rls`.
ALTER TABLE "user_data_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_data_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "user_data_key" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "health_source" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "health_source" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "health_source" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "epic_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "epic_connection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "epic_connection" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "fhir_resource" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fhir_resource" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "fhir_resource" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "fhir_attachment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fhir_attachment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "fhir_attachment" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "sync_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "sync_run" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "audit_event" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_only" ON "profile" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true)) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "user_id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "sync_cursor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_cursor" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- No user_id here: a cursor belongs to whoever can see its source (health_source is itself filtered).
CREATE POLICY "owner_only" ON "sync_cursor" FOR ALL USING (coalesce(current_setting('app.user_id', true), '') = '' OR "source_id" IN (SELECT "id" FROM "health_source")) WITH CHECK (coalesce(current_setting('app.user_id', true), '') = '' OR "source_id" IN (SELECT "id" FROM "health_source"));
