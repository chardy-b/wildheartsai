-- Reviewed, operator-run upgrade for already provisioned roles after migration 0009.
-- Uses the operator's authenticated psql connection; contains no credentials and
-- never recreates roles, changes passwords, or broadens authentication-table writes.
BEGIN;
GRANT EXECUTE ON FUNCTION public.chat_lock_session(text, text) TO wildhearts_chat_data, wildhearts_chat_queue;
GRANT SELECT ON chat_coordinator TO wildhearts_chat_data, wildhearts_chat_queue;
GRANT UPDATE (disabled_at) ON chat_coordinator TO wildhearts_chat_data;
GRANT UPDATE (disabled_at, claim_window_at, claim_count) ON chat_coordinator TO wildhearts_chat_queue;
GRANT SELECT (initiating_session_id, coordinator_id, claim_request_id, granted_worker_id, deadline_at,
              execution_grant_hash, control_grant_hash, grants_revoked_at)
  ON chat_run TO wildhearts_chat_queue;
GRANT UPDATE (cancellation_requested_at, coordinator_id, claim_request_id, granted_worker_id, deadline_at,
              execution_grant_hash, control_grant_hash, grants_revoked_at)
  ON chat_run TO wildhearts_chat_queue;
COMMIT;
