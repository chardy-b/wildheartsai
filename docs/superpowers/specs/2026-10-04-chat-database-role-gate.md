# Chat database role deployment gate

Update: the two restricted roles now run exclusively in the web backend. After additive migration 0009, existing roles use `scripts/upgrade-chat-roles.sql`; new environments use the provisioning script. Follow the [current rollout guide](../plans/2026-10-08-web-owned-chat-rollout.md); do not put either database connection on the VPS.

The automatic Drizzle migration creates chat tables with fail-closed owner policies. It does
not create a privileged queue policy or database role. An operator must review and apply the
following setup atomically in each environment before starting the chat service.

`wildhearts_chat_data` is the normal data-gateway role used by `CHAT_DATABASE_URL`. It is not a
superuser and does not have `BYPASSRLS`. It only receives the table grants required by the
gateway. The restrictive policies below make the existing compatibility policies on record
tables fail closed for this role when `app.user_id` is missing:

```sql
CREATE ROLE wildhearts_chat_data LOGIN PASSWORD '<provided-out-of-band>' NOSUPERUSER NOBYPASSRLS NOINHERIT;
GRANT USAGE ON SCHEMA public TO wildhearts_chat_data;
GRANT SELECT ON user_data_key, health_source, fhir_resource, fhir_attachment TO wildhearts_chat_data;
-- The service validates an already-authenticated browser session with these metadata only.
-- Do not grant session.token, account, verification, Epic connections, or profile data.
GRANT SELECT (id, user_id, expires_at) ON session TO wildhearts_chat_data;
GRANT SELECT (id, email_verified) ON "user" TO wildhearts_chat_data;
-- Chat can be the first feature to use the person's records key. This narrowly permits the
-- one idempotent first-key insert performed by userKeysFor; the RLS policy binds its user_id.
GRANT INSERT (user_id, sealed_dek, kek_version, created_at) ON user_data_key TO wildhearts_chat_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_conversation, chat_message, chat_run, chat_tool_call, chat_event, user_summary, summary_evidence TO wildhearts_chat_data;

CREATE POLICY chat_data_context_key ON user_data_key AS RESTRICTIVE FOR ALL TO wildhearts_chat_data
  USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY chat_data_context_source ON health_source AS RESTRICTIVE FOR ALL TO wildhearts_chat_data
  USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY chat_data_context_resource ON fhir_resource AS RESTRICTIVE FOR ALL TO wildhearts_chat_data
  USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY chat_data_context_attachment ON fhir_attachment AS RESTRICTIVE FOR ALL TO wildhearts_chat_data
  USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
```

`wildhearts_chat_queue` is the separate metadata-only role used by
`CHAT_QUEUE_DATABASE_URL`. It has no grants on records, encrypted message/event/summary tables,
user keys, or auth tables. It can discover queued work, claim it, and mark an expired running
lease interrupted. The service uses the returned user, conversation, and run ids to construct a
new user-scoped request through the normal data role; it never uses this connection for health
data or encrypted chat contents.

```sql
CREATE ROLE wildhearts_chat_queue LOGIN PASSWORD '<provided-out-of-band>' NOSUPERUSER NOBYPASSRLS NOINHERIT;
GRANT USAGE ON SCHEMA public TO wildhearts_chat_queue;
GRANT SELECT (id, user_id, conversation_id, status, next_attempt_at, lease_owner, lease_expires_at,
              cancellation_requested_at, attempt, created_at)
  ON chat_run TO wildhearts_chat_queue;
GRANT UPDATE (status, lease_owner, lease_expires_at, attempt, next_worker_sequence, started_at, completed_at, updated_at)
  ON chat_run TO wildhearts_chat_queue;
CREATE POLICY queue_metadata_select ON chat_run FOR SELECT TO wildhearts_chat_queue USING (true);
CREATE POLICY queue_metadata_update ON chat_run FOR UPDATE TO wildhearts_chat_queue USING (true) WITH CHECK (true);
```

The complete, transaction-wrapped operator script is
[`scripts/provision-chat-roles.sql`](../../../../scripts/provision-chat-roles.sql). Run it with
`psql -v chat_data_password='...' -v chat_queue_password='...' -f scripts/provision-chat-roles.sql`.
It refuses to run without both values and never writes either password to the repository.

The service preflight must fail when either role is superuser or bypasses RLS, the queue role can
read a sealed-content table, the required policies or column grants are missing, or an unscoped
`wildhearts_chat_data` query can read a record. Test this setup using synthetic rows for two
users before assigning either connection string to a deployment. Passwords and both connection
strings are deployment secrets and never belong in source, logs, or browser code.
