-- Provision the two narrowly scoped chat service roles in one transaction.
--
-- Usage (operator shell history must be handled according to local secret policy):
--   psql "$DATABASE_URL_UNPOOLED" \
--     -v chat_data_password='...' -v chat_queue_password='...' \
--     -f scripts/provision-chat-roles.sql
--
-- This script is deliberately separate from Drizzle migrations: it grants a metadata broker
-- privileged access to chat_run, so it must be reviewed and applied only after migration 0008.
\if :{?chat_data_password}
\else
  \quit 'chat_data_password is required'
\endif
\if :{?chat_queue_password}
\else
  \quit 'chat_queue_password is required'
\endif

BEGIN;

CREATE ROLE wildhearts_chat_data LOGIN PASSWORD :'chat_data_password'
  NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE wildhearts_chat_queue LOGIN PASSWORD :'chat_queue_password'
  NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT USAGE ON SCHEMA public TO wildhearts_chat_data, wildhearts_chat_queue;

GRANT SELECT ON user_data_key, health_source, fhir_resource, fhir_attachment TO wildhearts_chat_data;
GRANT SELECT (id, user_id, expires_at) ON session TO wildhearts_chat_data;
GRANT SELECT (id, email_verified) ON "user" TO wildhearts_chat_data;
GRANT INSERT (user_id, sealed_dek, kek_version, created_at) ON user_data_key TO wildhearts_chat_data;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON chat_conversation, chat_message, chat_run, chat_tool_call, chat_event, user_summary, summary_evidence
  TO wildhearts_chat_data;

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

-- Only queue discovery/lease metadata is visible to this role. It has no grant on the
-- sealed transcript, event, summary, record, key, or authentication tables.
GRANT SELECT (id, user_id, conversation_id, status, next_attempt_at, lease_owner, lease_expires_at,
              cancellation_requested_at, attempt, created_at)
  ON chat_run TO wildhearts_chat_queue;
GRANT UPDATE (status, lease_owner, lease_expires_at, attempt, next_worker_sequence, started_at, completed_at, updated_at)
  ON chat_run TO wildhearts_chat_queue;
CREATE POLICY queue_metadata_select ON chat_run FOR SELECT TO wildhearts_chat_queue USING (true);
CREATE POLICY queue_metadata_update ON chat_run FOR UPDATE TO wildhearts_chat_queue USING (true) WITH CHECK (true);

COMMIT;
