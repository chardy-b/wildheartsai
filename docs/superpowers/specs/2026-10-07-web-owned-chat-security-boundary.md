# Web-owned health-chat security boundary

Date: October 7, 2026

Status: Implemented on `codex/web-owned-chat` with independent Sol review. Production rollout remains pending; follow the October 8 rollout guide. This supersedes the direct-Neon VPS topology in the October 4 plan and the existing chat deployment instructions.

Update, November 16, 2026: **"Cloudflare topology"** below restates items 6 and 7 and the deployment changes for the move to Cloudflare Workers and D1 (`docs/superpowers/plans/2026-10-30-cloudflare-migration.md`). It's a proposal awaiting owner review; the chat port starts only once it's accepted. Everything else here stands unchanged.

## Decision

Wild Hearts' web backend owns all database access, record decryption, identity resolution, and persistent chat state. It currently runs on Vercel; the APIs and domain code must remain portable to another Node host. The VPS runs Iggy, isolated Pi workers, and the restricted inference relay. It receives no Neon credentials, record encryption key, user data keys, Epic credentials, browser-ticket signing key, or authority to mint user/run grants.

Bitwarden may supply secrets to trusted deployment processes, but does not change this boundary. A VPS deployment machine account must not have access to the web backend's database or encryption secrets.

## Previous implementation and its limits

The isolated Pi worker currently receives one short-lived run capability. The private gateway derives user, conversation, run, attempt, and lease owner from the verified credential. Strict tool schemas reject model-supplied identity fields. Tool queries use transaction-local `asUser` context plus explicit owner predicates. Record IDs, note IDs, conversation IDs, and summary evidence are checked for ownership. Run/lease fencing and cancellation prevent ordinary access after a run ends or its lease changes. Disposable container networks restrict workers to their fixed gateway and exclude database, host-service, other-worker, shell, filesystem, and internet tools.

These controls do not make a compromised VPS broker safe across tenants. The broker currently holds both database accounts and `RECORDS_ENCRYPTION_KEY`. A database client can select its own `app.user_id` context: RLS is enforcement of trusted context, not proof that a privileged caller selected the correct identity. The VPS also holds shared HMAC keys for browser tickets and runner grants. Lease fencing adds checks but does not remove the broad authority of a compromised broker with queue access.

The current browser endpoints recheck the active session, but runner grants and stored runs do not carry the initiating session reference. Logging out therefore does not immediately revoke an already running worker's data access. The revised API must close this gap. Closing a browser tab leaves the session active and must continue to permit background completion.

## Required API boundary

1. Signed-in browser operations use web APIs for conversations, questions, summaries, cancellations, and persisted events. Identity comes from Better Auth; request bodies cannot choose a user. Persist the initiating session reference server-side with the job.
2. A narrowly authorized VPS coordinator can claim only jobs already created by authenticated users. The web backend chooses the queued job, run owner, attempt, and lease. This credential cannot create user jobs, choose a patient, read arbitrary records or conversations, or mint execution credentials.
3. The web backend issues an opaque execution grant for that claimed run. Store its verifier/hash server-side, keep it short-lived, and bind it to the existing job, user, conversation, attempt, lease owner, expiry, and a fixed operation allowlist. The VPS cannot mint or widen it. If signed grants are selected instead, the private signing key remains exclusively in the web backend; the VPS gets no shared signing secret.
4. Worker context, tool calls, summary writes, events, and completion use that execution grant. The web API resolves authoritative scope and checks the initiating session, grant expiry/revocation, job ownership, lease/attempt, cancellation, tool arguments, ownership, budgets, and idempotency. Deny before data access on any failed check. Handle exact terminal retries with a narrow idempotent acknowledgement; they must not reopen data access.
5. Coordinator heartbeats, status, cancellation acknowledgement, and failure/interruption updates use a separate lease-bound control authority. Do not let a general coordinator credential renew or mutate arbitrary runs, or turn it into a tenant data credential.
6. Web-side chat operations retain the two existing restricted Neon roles and startup/readiness validation, rather than replacing constrained access with an owner account. Keep network/model calls outside `asUser` transactions. No generic SQL, arbitrary HTTP proxy, or generic repository-method RPC is exposed.
7. Persisted job state survives browser disconnects. An expired begun lease becomes interrupted; no automatic rerun. Workers poll short API calls; do not keep a Vercel request open for the complete model run. Browser event delivery can use bounded polling with persisted sequence cursors.
8. Keep the fixed local gateway for isolated Pi containers. It relays only the allowlisted web API operations and configured inference endpoint, forwarding the one-run grant without adding broad data authority. The inference service receives only the selected health context; this remains sensitive plaintext during processing.

## Deployment changes

- Place `CHAT_DATABASE_URL`, `CHAT_QUEUE_DATABASE_URL`, and the existing `RECORDS_ENCRYPTION_KEY` only in the web backend's server environment. Never copy them into the VPS runtime file or worker images.
- Keep execution-grant minting and any browser signing authority web-only. Do not reuse the current VPS `CHAT_RUNNER_CAPABILITY_KEY` or `CHAT_SIGNING_KEY` to authorize the new web tool endpoints.
- VPS configuration contains the fixed web API origin, limited coordinator bootstrap credential, Iggy control token, and inference configuration/credentials only. Per-run execution grants are supplied at run time and never logged.
- Replace the current VPS public data API and direct-Postgres runtime before enabling production chat. Do not silently fall back to the old direct database mode when web API configuration is absent.
- The current root-only `/opt/wildhearts-chat-prod/runtime.env` was prepared for the superseded design. Do not deploy it as-is. Once the new topology is reviewed, remove obsolete credentials from VPS configuration with explicit handling of any user-entered secrets and rotate credentials if they have been exposed.

## Verification required before rollout

Test a valid run for user A against user B's record, note, conversation, summary, and evidence identifiers; tool identity injection; missing/expired/tampered/revoked grants; cancelled, completed, and expired-lease runs; stale attempts and wrong workers; revoked initiating sessions; unauthorized queue creation/selection/renewal; terminal replay; encrypted persistence; and background completion after closing the tab.

Inspect built worker/service images and Compose configuration to verify absence of database, encryption, and grant-minting secrets. Repeat Iggy's real Docker isolation acceptance. Review failure responses and logs for credential or health-data disclosure. Run the repository's required delivery checks and a synthetic end-to-end account test against the web API boundary before enabling production.

## Cloudflare topology (proposed, November 16, 2026)

The VPS contract doesn't change: same paths (`/api/chat/ticket`, `/api/chat/v1/*`, `/api/chat/worker/v1/*`), same grants, same coordinator credential, reached through the web Worker at the same origin. What changes is how the web side is split and what replaces Postgres's roles, RLS and session lock.

### Workers and bindings

- **`wildhearts-chat` Worker** serves the three chat path groups and the reaper (Cron Trigger every minute, replacing Inngest `reap-chat-runs`; status reads keep the opportunistic reap). The web Worker routes `/api/chat/*` to it over a second service binding (`CHAT`); like the API Worker it has no public URL.
- **`CHAT_DB`** (its own D1 database: `wildhearts-chat-prod`, `-preview`, local `local-chat`) holds only the chat tables: conversations, messages, runs, coordinators, tool calls, events, summaries and evidence. The chat Worker has no binding to the main D1 and no R2.
- **Records through a narrow RPC.** The API Worker exports a `ChatRecords` `WorkerEntrypoint`; the chat Worker binds it (`RECORDS`). Its methods are the reads chat makes today, by purpose, each taking a `userId` and running through `forUser` on the API side:
  - `sessionFence(sessionId, userId)`: the `chat_lock_session_v2` rules (verified owner, unexpired session; for a demo workspace, its parent login too; a workspace identity without a parent is refused), answering the effective expiry or null.
  - `dataKey(userId)`: the person's sealed data key row, created if missing (today's `INSERT` grant on `user_data_key`). Sealed, as stored.
  - Record reads for the tools: data coverage (category counts and sources), candidates for `find_records` (current rows by category, date range and limit), rows by id for `read_records` and `calculate_lab_trend`, one attachment for `read_stored_note`, and the existence checks behind summary evidence (records, notes, sources by id). Rows come back sealed; the chat Worker opens them with the person's data key, as today.

  Not exposed: anything else in the main database (`session.token`, accounts, verification, Epic connections and tokens, profiles, documents, extraction), any write except creating a data key, generic SQL or a generic table read. This is the D1 equivalent of today's column grants, enforced by what the methods do rather than by the database. `role-preflight.ts` is replaced by a test over the entrypoint's method list (a new method fails CI until it's listed and reviewed) and by the bindings themselves.

- **Secrets.** The chat Worker holds `RECORDS_ENCRYPTION_KEY` (as the chat roles' process does today, to open records and seal chat content), `CHAT_GRANT_DERIVATION_KEY`, `CHAT_RESEARCH_GATEWAY_TOKEN_HASH` and the coordinator credential hash. `CHAT_DATABASE_URL` and `CHAT_QUEUE_DATABASE_URL` go away. The VPS's configuration is unchanged.

### Item 6 on D1: separate stores instead of restricted roles

Today the two restricted Neon roles keep a chat bug from reading tokens, accounts or profiles. On Cloudflare the same guarantee comes from bindings: the chat Worker can't name the main database, and the only way into it is the RPC above. Within `CHAT_DB`, rows are scoped by an explicit owner condition on every query (the `forUser` pattern from the API, applied to the chat tables), with per-user encryption as the second layer. The queue role's narrower column set (claims and leases only) becomes a separate module of the chat Worker that touches only `chat_run` and `chat_coordinator`, checked by the same kind of method-list test.

### Item 7 and the session lock: fence, read, fence again

`chat_lock_session_v2` today takes `FOR SHARE` on the initiating session (and the demo parent) inside the request's transaction, so a sign-out waits until in-flight chat operations finish, and nothing reads records after a sign-out commits. D1 has no cross-request locks, and here the session lives in another database.

Proposal: every operation that reads records or chat content calls `sessionFence` **before** its reads and **again after its reads, before it answers**, and fails closed (`run_not_active` or 401) if either check fails. An answer is therefore only sent if the session was live after the data was read: the operation is ordered before any sign-out that the second check didn't see, which is the same ordering the shared lock gives. Writes into `CHAT_DB` go in one batch guarded on the run's grant and lease (compare-and-set, audit pattern C), with the session checked first. A write can land in the moments between a sign-out and the next check. It stays in the person's own chat history and gives the VPS nothing.

This replaces the `ChatSessionLock` Durable Object the migration plan sketched. A Durable Object can't stop Better Auth deleting the session row, because sign-out doesn't pass through it, so it would add a hop without adding the guarantee. If review prefers a lock anyway, sign-out would have to go through it too (a Better Auth hook calling the object), which is a larger change to auth.

Other Postgres locks in chat map to D1 as the transaction audit records: sequence allocation by `UPDATE … RETURNING` then insert in one batch (C); claims and reaping by guarded single statements (Q, C); the per-user advisory lock around starting a run by a `UserLock` queue keyed `chat:<user>` (L).

### Verification on Cloudflare

Everything under "Verification required before rollout" is repeated against the chat Worker on workerd (the Phase 1 test pool, with both D1 databases), plus:

- The fence: sign out during a long tool read (a test hook between the reads and the second check) and see the read refused; a demo workspace whose parent login ends, the same.
- The RPC: a test that lists `ChatRecords`' methods and fails on any unreviewed one; each method called with user A's id never returns user B's rows; no method returns `session.token` or any column of `account`, `verification`, `epic_connection` or `profile`.
- The chat Worker's bundle and bindings contain no main-database binding (checked from `wrangler.chat.jsonc` in CI).

## Remaining exposure

This reduces the VPS compromise impact; it does not make plaintext processing secret-free. A compromised worker can expose context legitimately granted to its run, and a compromised VPS coordinator/relay can observe jobs and selected context passing through it. A compromised coordinator may claim pending authorized jobs until its credential is revoked. A compromised web backend or inference host remains a serious threat. Do not describe the new deployment as providing absolute tenant isolation against every host compromise.
