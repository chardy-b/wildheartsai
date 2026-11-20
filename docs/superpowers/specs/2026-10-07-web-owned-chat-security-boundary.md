# Web-owned health-chat security boundary

Date: October 7, 2026

Status: Implemented on `codex/web-owned-chat` with independent Sol review. Production rollout remains pending; follow the October 8 rollout guide. This supersedes the direct-Neon VPS topology in the October 4 plan and the existing chat deployment instructions.

Update, November 20, 2026: **"Cloudflare topology"** below is the design for the move to Cloudflare Workers and D1 (`docs/superpowers/plans/2026-10-30-cloudflare-migration.md`), decided by the owner: one Durable Object per conversation, running the Pi agent itself. On Cloudflare it replaces the VPS coordinator and grants. Until the cutover, Vercel production keeps the design above.

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

## Cloudflare topology (decided November 20, 2026)

Owner decisions: **each conversation gets its own Durable Object, and that object runs the Pi agent durably.** The agent loop moves off the VPS. The VPS keeps only what needs a GPU or the research corpus. On Cloudflare this replaces requirement items 2–5 and 8 (coordinator, claims, execution and control grants, the private gateway); items 1, 6 and 7 are restated below. Vercel production keeps the current design until the cutover.

**The runtime is Pi durable** (`@earendil-works/pi-durable` 1.5.2, with `pi-ai`, `chord` and `pi-schema` 1.5.2, pinned exactly), not the plain Pi agent loop `services/chat` uses. Pi durable's `Harness` keeps the conversation as a transcript of committed entries and runs each answer as durable tasks (a generation task, one task per tool call) that checkpoint at every step. It ships SQLite storage for a Durable Object (`openDurableObjectSqliteStorage`) and tells the host when to wake it (`onWake`), so the object's alarm resumes unfinished work.

Checked November 20 on workerd: a Durable Object running a Pi durable `Harness` with one tool, against an OpenAI-compatible stand-in, was killed (`ctx.abort()`) during its second model call. The alarm reopened the storage and resumed. The model call was made again, the tool's result came from the checkpoint (the tool ran once), and the answer was committed once. Import `createModels` from `@earendil-works/pi-ai/models`: through the package root, the Workers bundle failed with `ModelsImpl is not a constructor`.

### As built (November 20, 2026)

Built and tested as below (`api/src/chat/`, `api/src/chat-records.ts`, `services/chat/src/edge.ts`), with these changes from the first draft of this section:

- **Tool-shaped RPC.** The API Worker runs each record tool itself and answers only that tool's output and its read receipts. The chat Worker never receives raw records or any decryption key: it holds no `RECORDS_ENCRYPTION_KEY`, and there's no `dataKey` method.
- **No per-person sealing of chat content** (owner decision: encryption isn't required for now). Pi durable's transcript is stored as is in each object's storage, and so are our own tables and `CHAT_DB`.
- **One VPS token.** The edge service (`CHAT_SERVICE_MODE=edge`) serves both inference and research behind `CHAT_EDGE_TOKEN`; only its SHA-256 is configured on the VPS.
- **The fence runs before each step.** It is checked before every model request (a `beforeRequest` hook) and every tool read; a failed check stops the run at that step. It isn't re-checked after a read: a tool's answer goes to the model inside the same step, not to the browser.

### Pieces

- **`wildhearts-chat` Worker** serves `/api/chat/v1/*` (the browser's chat API, same protocol) behind the web Worker's `CHAT` service binding, with no public URL. `/api/chat/ticket` and `/api/chat/worker/v1/*` are retired on Cloudflare: nothing outside Cloudflare runs the agent any more.
- **`ChatConversation` Durable Object**, one per conversation (`idFromName(conversationId)`), hosting one Pi durable `Harness` over the object's SQLite storage. The transcript, run state, tool calls and progress live in Pi durable's tables. What the browser reads lives in our own `wh_*` tables in the same storage: messages, runs (with the initiating session's fence), events, and each tool call with its read receipts. The object serializes everything that happens to its conversation. One run at a time: a question while one runs is refused (`conversation_busy`), as before.
- **`CHAT_DB`** (D1) holds what spans conversations: each owner's conversation list, a run index (the browser's run routes name only the run), saved summaries and their evidence. Every query goes through `api/src/chat/data/`, which puts the owner in it.
- **`ChatRecords` RPC** on the API Worker (a `WorkerEntrypoint` the chat Worker binds as `RECORDS`), by purpose, each taking a `userId` and running through `forUser`:
  - `identify(cookie)`: who a browser request is (a login, or a guest or signed-in person viewing the demo chart), as `{ userId, demo, fence }`. Never the session token.
  - `sessionFence(fence)`: the `chat_lock_session_v2` rules (the session exists for that person, hasn't expired, and their email is verified; a signed-in demo viewer is fenced by their own login; a guest by their viewer cookie's expiry), answering the expiry or null.
  - The record tools, answered in the API: `dataCoverage`, `findRecords`, `readRecords`, `readStoredNote`, `labTrend`, each re-validating its input with the tool schemas, and each answering the output plus read receipts (record or note, and the version read).
  - `evidence(targets)` (current versions and source coverage, for saving summaries and their freshness) and `recordSources(receipts)` (the "record sources" panel: each record as it was read, left out if it has changed).
  - Nothing else in the main database is reachable: not `session.token`, accounts, verification, Epic connections or tokens, profiles, documents or extraction, and no writes at all. `api/test/chat-records.test.ts` lists the entrypoint's methods and fails on an unreviewed one, checks every method against a second person's ids, and checks no answer carries a session token, sealed field or credential. `role-preflight.ts` has no successor beyond these.

### The run, durably

1. The browser posts a question (`POST /api/chat/v1/conversations/:id/runs`, with an idempotency key). The chat Worker identifies the person, checks they own the conversation (index row) and the rate limits, and hands the question to the conversation's object. The object records the message and the run (with the initiating session's fence) in one transaction, arms its alarm, and submits the question to the `Harness` with the run's id as Pi durable's `requestId`; a run recorded but not yet submitted (the object stopped in between) is submitted when the object starts. A repeated post with the same idempotency key finds the same run. The object answers at once.
2. Pi durable runs the answer as tasks; the object's alarm keeps it going (`onWake`, a heartbeat while work is active), so closing the tab changes nothing. The agent gets the system prompt, the conversation's transcript, the allowlisted tools and the configured model.
3. **Checkpoints** are Pi durable's: every step is committed before the next starts. If the object is evicted, restarted or deployed over, the alarm reopens the `Harness` and `resume()` continues from the last checkpoint. A model call in flight is retried under the retry policy. The record tools are declared `replay: "safe"` (they only read), so a cut-off call runs again; `save_summary` isn't, so a cut-off save comes back to the model as interrupted rather than saving twice.
4. **Bounds.** `maxTurns` per run, at most `CHAT_MAX_TOOL_CALLS` tool calls (a hook blocks the rest), the retry policy, and `restartLimit` for work that keeps crashing its object. Past them the run ends `unanswered` or `interrupted` with what it had.
5. **Model calls** are routed through the VPS: its edge service relays to the configured models only (OpenAI-compatible, token-capped, falling back to the next model before any output) with the chat Worker's token, `CHAT_EDGE_TOKEN`. The relay sees the selected health context, as inference does today. A busy relay (429/503) makes the object back off with its alarm, inside the deadline.
6. **Tools** are fixed functions in the object: records through `RECORDS`, summaries in `CHAT_DB`, research through the VPS edge service. The person is the conversation's owner, never an argument; the strict tool schemas (`src/lib/chat/tools.ts`) stay as they are, with no identity fields.
7. **Events** are persisted in the object with sequence numbers; the browser polls `GET …/events?after=` as today. A watch on the conversation turns Pi's committed partial answer and reasoning into `answer.delta` and `reasoning.delta` (reasoning capped at 16 KB); tools write `tool.started` and `tool.completed` themselves; runs are settled from Pi's submission state on every watched commit and every poll, and settling sends any answer text a quick answer didn't stream. A WebSocket from the object (hibernation API) can come later without changing storage.
8. **Cancel** (`DELETE …/runs/:id`) sets a flag the run checks before every step; the next step ends it as `cancelled`.

### Sign-out and expiry (item 7)

Before each model call, before each tool's reads, and before answering any browser read, the object calls `sessionFence` for the run's initiating session (or the requester's session, for reads). If it fails, a run stops as `interrupted` and the read is refused. The object serializes the conversation, but sign-out doesn't pass through it, so the fence is what orders the two. An answer is sent only if the session was still live after its data was read. A run started before a sign-out makes at most the step in progress; the fence refuses the next one.

### Isolation (item 6)

- The chat Worker can't name the main database; the RPC above is its only way in. A chat bug can't read tokens, accounts or profiles.
- Each conversation's content lives in its own object's storage, and the cross-conversation tables in `CHAT_DB` are reached only with an owner condition (the API's `forUser` pattern). Per-user encryption stays as the second layer.
- Tool code is fixed and the model can't run code. That replaces the disposable containers, which guarded against a compromised worker on the VPS. On Cloudflare the agent runs in the chat Worker itself, so Pi and its dependencies are part of the trusted code there. Pin them exactly, review updates, and keep the chat Worker free of other packages.

### Limits

Every question can cost GPU time, so asking is strictly limited (`api/src/limits.ts`, with the chat port; owner's numbers, November 20): 30 questions an hour per signed-in person, 10 an hour per guest demo, and 5 a minute for anyone. Also 60 an hour per network across guests, and 20 new conversations an hour per person. Each run is bounded as in step 4. Demo viewers (guests and signed-in people viewing the demo) can ask about the central demo chart within those limits, but nothing they do is kept: their conversation objects aren't listed in `CHAT_DB`, `save_summary` isn't offered, and each object deletes its storage (`deleteAll()` from its alarm) a day after its last question. The tools read the demo chart, which no viewer can change.

### Secrets

The chat Worker holds one secret, `CHAT_EDGE_TOKEN`, and the vars `CHAT_EDGE_URL`, `CHAT_MODEL_ID` and `CHAT_ENABLED`. It holds no record key. The VPS edge service holds `CHAT_EDGE_TOKEN_HASH` (the token's SHA-256), its inference settings and the research corpus root. Gone on Cloudflare: `CHAT_DATABASE_URL`, `CHAT_QUEUE_DATABASE_URL`, `CHAT_GRANT_DERIVATION_KEY`, the coordinator credential and its hash, `CHAT_RESEARCH_GATEWAY_TOKEN` and its hash, and the browser ticket key.

### Verification on Cloudflare

Repeat the cross-tenant and revocation cases from "Verification required before rollout" against the chat Worker on workerd, with both D1 databases, the RPC and the conversation objects. Add:

- **Durability:** abort the object mid-run (between a tool result and the next model call, and during a model call), then see the alarm resume from the checkpoint. A completed tool call isn't repeated, and the answer arrives once.
- **The fence:** sign out during a run and see the next step refused; the same for a signed-in demo viewer's login, and when a guest's viewer cookie expires.
- **The RPC:** the method-list test; user A's id never returns user B's rows; no answer carries `session.token` or any column of `account`, `verification`, `epic_connection` or `profile`.
- **Limits:** questions past each limit are refused with 429 before anything is recorded or any model is called.
- **Configuration:** the chat Worker's configuration binds no main database and no R2 (checked from `wrangler.chat.jsonc` in CI).

Covered so far (November 20): durability, the fence, the RPC checks, limits, cross-person isolation and cancel in `api/test/chat/chat.test.ts` and `api/test/chat-records.test.ts` (the fence test fails with the check removed); the edge service in `services/chat/test/edge.test.ts`; a browser run of the demo chat through every piece locally. Not yet: the configuration check in CI, and a run against the real model and corpus on the VPS.

## Remaining exposure

On Cloudflare: a compromised chat Worker (including a compromised Pi dependency) can ask the RPC for any person's record-tool answers, as a compromised chat-role process on Vercel can read their records today; it holds no key, so it can't read raw records or anything outside the tools. The inference relay sees the context sent to the model. The VPS no longer holds any grant that reaches records.


This reduces the VPS compromise impact; it does not make plaintext processing secret-free. A compromised worker can expose context legitimately granted to its run, and a compromised VPS coordinator/relay can observe jobs and selected context passing through it. A compromised coordinator may claim pending authorized jobs until its credential is revoked. A compromised web backend or inference host remains a serious threat. Do not describe the new deployment as providing absolute tenant isolation against every host compromise.
