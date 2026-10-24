ALTER TABLE "session" ADD COLUMN "parent_session_id" text;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_parent_session_id_session_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_parent_idx" ON "session" USING btree ("parent_session_id");
--> statement-breakpoint
-- Preserve the restricted roles' metadata-only session fence. Demo work must
-- lock and validate the person's real login before locking its child session.
CREATE FUNCTION public.chat_lock_session_v2(p_session_id text, p_user_id text)
RETURNS timestamp LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  parent_id text;
  parent_expires timestamp;
  child_expires timestamp;
BEGIN
  SELECT s.parent_session_id INTO parent_id FROM public.session s
    WHERE s.id = p_session_id AND s.user_id = p_user_id;
  IF parent_id IS NOT NULL THEN
    SELECT s.expires_at INTO parent_expires
      FROM public.session s JOIN public."user" u ON u.id = s.user_id
      WHERE s.id = parent_id AND s.parent_session_id IS NULL
        AND s.expires_at > (clock_timestamp() AT TIME ZONE 'UTC') AND u.email_verified = true
      FOR SHARE OF s, u;
    IF parent_expires IS NULL THEN RETURN NULL; END IF;
  ELSIF p_user_id ~ '^wildhearts_demo_workspace_[a-f0-9]{64}$' THEN
    RETURN NULL;
  END IF;
  SELECT s.expires_at INTO child_expires
    FROM public.session s JOIN public."user" u ON u.id = s.user_id
    WHERE s.id = p_session_id AND s.user_id = p_user_id
      AND s.parent_session_id IS NOT DISTINCT FROM parent_id
      AND s.expires_at > (clock_timestamp() AT TIME ZONE 'UTC') AND u.email_verified = true
    FOR SHARE OF s, u;
  IF parent_id IS NOT NULL THEN
    IF child_expires IS NULL THEN RETURN NULL; END IF;
    RETURN least(child_expires, parent_expires);
  END IF;
  RETURN child_expires;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.chat_lock_session_v2(text, text) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wildhearts_chat_data') THEN
    GRANT EXECUTE ON FUNCTION public.chat_lock_session_v2(text, text) TO wildhearts_chat_data;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wildhearts_chat_queue') THEN
    GRANT EXECUTE ON FUNCTION public.chat_lock_session_v2(text, text) TO wildhearts_chat_queue;
  END IF;
END $$;
