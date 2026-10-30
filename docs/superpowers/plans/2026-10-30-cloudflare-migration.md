# Cloudflare migration: Hono API, D1 and Next.js on Workers

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking. Each phase ends with a PR that can ship on its own. Later phases get task-level detail when they start.

**Goal:** move Wild Hearts AI off Vercel and Neon onto Cloudflare. The backend is rewritten as a Hono app on Workers with D1 as its database. The frontend stays Next.js and also runs on Workers, through the OpenNext Cloudflare adapter. Vercel, Neon and Inngest are retired once the cutover has been verified.

**Decisions (2026-10-30):**

- Database: **D1**. Not Neon behind Hyperdrive: the owner chose a single platform over keeping Postgres. The cost of that choice is losing Postgres row-level security (see "Replacing row-level security").
- Cutover: **build and verify the whole Cloudflare stack on a staging hostname while Vercel keeps serving production, then swap DNS.** Some downtime is acceptable, but both stacks should run side by side for as long as possible (see "Cutover").
- Previews: **one shared preview D1 database** (and preview R2 bucket, preview chat D1), not one per PR.
- Inngest run history is not kept.
- Backend: **Hono on Workers**, a new Worker that owns every API route, the database, R2, jobs and secrets.
- Frontend: **Next.js on Workers via `@opennextjs/cloudflare`**. It renders pages and calls the API. It has no database binding and holds no record, token or Epic secrets.

Everything in the roadmap's Security rules and in `AGENTS.md` still applies. This plan does not change what we may claim: no HIPAA, Epic-approval or clinical-accuracy claims.

## Global constraints

- Health data is written only through the per-user sealing helpers (`src/lib/crypto/user-keys.ts`, ported as they are). Sealed values move between databases as opaque bytes; no key is unwrapped during migration.
- Every query on a person's data goes through the user-scoped data layer. Route handlers never import table objects.
- Job payloads, logs and step results hold IDs, counts and error codes only, as they do now under Inngest.
- `/api/health` stays unauthenticated, with no bindings touched and no secrets.
- Production keeps serving from Vercel and Neon until the Cloudflare stack passes the cutover checks. Rollback means switching DNS back.
- Before each PR: lint, typecheck, test and build for every workspace that changed.

## Target architecture

```
            staging hostname now, www.wildheartsai.com after the DNS swap
                                    │
                         ┌──────────▼───────────┐
                         │   wildhearts-web     │  /api/*  → forwarded to API
                         │   Next.js (OpenNext) │  else    → Next renders
                         │   pages, CSP nonce   │
                         └──────────┬───────────┘
                                    │ service binding (API): no public hop,
                                    │ cookie forwarded
                         ┌──────────▼───────────┐
                         │   wildhearts-api     │
                         │   Hono on Workers    │
                         └─┬──────┬──────┬──────┘
     │      │      │
    D1     R2   Workflows / Queues / Cron / Durable Objects
 (records, (Wildcards (sync-source, nightly refresh,
  auth,    ciphertext, directory import, chat reaper,
  jobs)    large notes) chat session locks, rate limits)
     ▲
     │ HTTPS, scoped grants only (unchanged contract)
  VPS: services/chat (coordinator, gateway, Iggy), services/extraction
```

- **One origin, routed by the web Worker.** The web Worker is the only public entry point. Its entry (a small wrapper around OpenNext's worker) sends `/api/*` to the API Worker over the service binding, request streamed as is, and everything else to Next. This works the same on a staging hostname and on `www.wildheartsai.com`, and doesn't depend on zone routes. Session cookies stay first-party with no CORS, and after the DNS swap `EPIC_REDIRECT_URI`, both JWKS URLs and the VPS `CHAT_WEB_API_URL` keep their current values. The API Worker has no public URL (`workers_dev: false`): it is reachable only through the binding, so the VPS also comes in through the web Worker at the same paths.
- **Next → API over a service binding.** Server components and server actions call `env.API.fetch(...)` (`getCloudflareContext()` from OpenNext), forwarding the incoming `Cookie` header. The browser keeps calling `/api/*` directly (uploads, chat streams, PDF viewing).
- **The VPS contract doesn't change.** `services/chat` and `services/extraction` already talk to the web backend only over HTTPS, with scoped grants (no database or R2 credentials), so they just reach Hono at the same paths. GPU inference and OCR stay on the VPS: Workers can't run them. Cloudflare Containers or Workers AI could be evaluated later, separately.

## Repository layout

Keep the Next app at the root until the cutover, so the existing pipeline keeps deploying production throughout. `api/` is a standalone package with its own lockfile, like `services/chat`, so the root install and the Vercel build don't change.

| Path | Contents |
| --- | --- |
| `api/` | New Hono Worker (`wrangler.jsonc`) and the chat Worker (`wrangler.chat.jsonc`, `src/chat/`): `src/app.ts` (app and route mounting), `src/routes/*`, `src/data/*` (the user-scoped data layer), `src/jobs/*` (Workflows, cron), `src/durable/*` |
| `api/migrations/`, `api/chat-migrations/` | D1 SQL migrations for the main and chat databases (generated by `drizzle-kit` for SQLite, applied by `wrangler d1 migrations apply`) |
| `packages/core/` | Runtime-neutral code shared by both Workers: FHIR normalization, timeline grouping, source display, Zod request/response schemas, the API client types |
| `src/` (Next) | Pages and components. Its `src/lib` shrinks as modules move to `api/` or `packages/core/`. Data access is replaced by `src/lib/api-client.ts` |
| `wrangler.jsonc` (root) + `open-next.config.ts` | Web Worker config: assets, the `API` service binding, no other bindings |

After cutover, a cleanup PR moves Next into `web/` and deletes `drizzle/`, `vercel-build`, `.vercel` handling and the Postgres code.

## Service mapping

| Today (Vercel / Neon / Inngest) | Cloudflare |
| --- | --- |
| Vercel Functions (Next route handlers, server actions) | `wildhearts-api` Hono Worker; Next server actions become thin calls to it |
| Next pages on Vercel | `wildhearts-web` Worker via OpenNext; static assets in Workers Static Assets |
| Neon Postgres (`pg` Pool, Drizzle node-postgres) | D1 (Drizzle `d1` driver) |
| Postgres RLS (`asUser`, migration 0006) | User-scoped data layer, plus cross-user isolation tests (below) |
| Restricted chat roles (`CHAT_DATABASE_URL`, `CHAT_QUEUE_DATABASE_URL`) | A separate `wildhearts-chat` Worker with its own narrow D1 bindings (below) |
| `chat_lock_session_v2` (Postgres function) | Durable Object per browser session (`ChatSessionLock`) |
| Inngest `sync-source` (per-source concurrency 1, global 5) | Workflow `SyncSource`. Per-source exclusivity comes from a deterministic instance ID (`sync-<sourceId>-<runId>`) plus the existing `sync_run` "one active run per source" check. The global limit of 5 comes from a Queue consumer with `max_concurrency` that creates the Workflow instances |
| Inngest `refresh-sources` (cron 10:17 UTC) | Cron Trigger `17 10 * * *` → Workflow `RefreshSources` (same chunked steps, schedule history unchanged) |
| Inngest `refresh-epic-directory` (cron 08:41 UTC, or on event) | Cron Trigger `41 8 * * *`, plus an admin-only endpoint → Workflow `RefreshEpicDirectory` (streamed import, see D1 notes) |
| Inngest `reap-chat-runs` (every minute) | Cron Trigger `* * * * *` on the chat Worker |
| `@aws-sdk/client-s3` → R2 | R2 binding (`env.FILES`), the same opaque keys and ciphertext format, so no object rewrite |
| nodemailer → Gmail SMTP | An HTTP email API called from the API Worker (provider to be chosen by the owner; open question 1). Until then the API keeps the current development behaviour on preview (print the link) and production cutover is blocked on it |
| `@vercel/analytics` (with `beforeSend` scrubbing) | Cloudflare Web Analytics (cookieless). Check the beacon against the CSP; keep URL scrubbing |
| `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL` | `BETTER_AUTH_URL` / `APP_URL` set per environment in `wrangler.jsonc` vars |
| Vercel env vars | Worker secrets (`wrangler secret put`), per environment; non-secret flags as `vars` |
| Vercel preview per branch, Neon branch per PR | Workers preview versions per PR (preview URLs), all against one shared `wildhearts-preview` D1 and R2 bucket. Migrations stay additive, so PRs on different schemas can share it |
| `vercel-build` runs `drizzle-kit migrate` | CI runs `wrangler d1 migrations apply --remote` before `wrangler deploy` |
| `npx vercel logs` | `wrangler tail`, Workers Logs (log fields stay IDs and codes only) |

## Route mapping

Every handler moves to Hono under the same path, so the browser, Epic and the VPS see no change.

| Path | Notes |
| --- | --- |
| `/api/health` | Plain `c.json({ ok: true })`, no bindings |
| `/api/auth/*` | Better Auth `auth.handler(c.req.raw)`; Drizzle adapter with `provider: "sqlite"`; schema regenerated for SQLite |
| `/api/epic/authorize`, `/api/epic/callback` | PKCE and state unchanged; `node:crypto` under `nodejs_compat`. Callback enqueues the sync through the Queue |
| `/api/epic/jwks`, `/api/epic/jwks/production` | Unchanged logic |
| `/api/wildcards`, `/api/wildcards/[id]`, `/[id]/fhir`, `/uploads`, `/uploads/[id]/[part]`, `/uploads/[id]/complete` | R2 binding. Uploads already use 3 MB parts, well under the Workers request-body limit. Streaming download of chunked files uses `ReadableStream` |
| `/api/wildcards/pdfjs/[...asset]` | Drop the route: serve the pdf.js worker, cmaps and fonts as static assets of the web Worker (copied at build). Removes `outputFileTracingIncludes` |
| `/api/extraction`, `/api/extraction/worker/v1/*` | Unchanged contract with the VPS |
| `/api/chat/ticket`, `/api/chat/v1/*`, `/api/chat/worker/v1/*` | Served by `wildhearts-chat` (see chat isolation) via a route or service binding |
| `/api/demo/*` | Unchanged logic |
| `/api/inngest` | Deleted after cutover |
| `/app/export` (Next route handler) | Becomes `/api/export`; the page links to it |

Server actions (`connections/actions.ts`, `onboarding/actions.ts`, `(auth)/demo/actions.ts`) and the pages that read data directly (connections, onboarding, demo, wildcards pages, records via `records-server.ts`) switch to the API client in Phase 5.

## Database: Postgres → D1

### Schema conversion

The 30 tables are rewritten in `api/src/db/*-schema.ts` with `drizzle-orm/sqlite-core`:

| Postgres | D1 / SQLite |
| --- | --- |
| `uuid` | `text` (UUIDs generated in code, as most already are) |
| `timestamp` (66 columns) | `integer({ mode: "timestamp_ms" })`. Lossless for our millisecond `Date`s; one convention everywhere |
| `jsonb` | `text({ mode: "json" })`. No query filters on JSON content today; check during the port |
| `bigint` | `integer` (64-bit in SQLite) |
| `serial` | `integer` primary key, autoincrement |
| `boolean` | `integer({ mode: "boolean" })` |
| Sealed columns | Unchanged representation (text). Their associated data is `table:field:userId:rowId` (`user-keys.ts`), and data keys use `user_data_key:userId:vN`. So **table names, sealed field names, user IDs and row IDs must stay exactly the same**, or existing values won't open |
| RLS policies, roles, `chat_lock_session*` | Removed (replacements below) |

D1 migrations start fresh at `api/migrations/0000_init.sql`; the 20 Postgres migrations stay in `drizzle/` until cleanup.

### Limits that shape the port

Verify current numbers against Cloudflare's docs at the start of Phase 1.

- **No interactive transactions.** `db.transaction(async tx => …)` doesn't exist on D1. Atomic writes use `db.batch([...])`, which runs as one transaction but can't read in between. Every current transaction gets reviewed: most read first and then write, and become "read, compute, batch write" with a guard in the write (`where updated_at = ?` or a unique constraint) to catch races.
- **Bound parameters per statement** are limited (100 at last check). Bulk inserts (sync store writes, directory import) are chunked.
- **Row and value size** are capped (about 2 MB at last check). Large note Binaries in `fhir_attachment` move to R2 (sealed object, pointer in D1) above a threshold; smaller ones stay inline.
- **Database size** is capped (10 GB at last check). Measure Neon's current size per table in Phase 0. If records growth makes this tight, shard user data across D1 databases by user, a design change deferred until the numbers say so.
- **Worker memory** is 128 MB. The Epic Brands bundle (~95 MB) can't be held in memory. `RefreshEpicDirectory` streams it (`response.body` through a streaming JSON parser), writing entries in chunks to a new import generation, then flips the active generation in `epic_directory_import` with one statement and deletes the old generation in a later step. This replaces "replace everything in one transaction".
- **Directory search** keeps the "every word starts a word" semantics. Evaluate FTS5 (prefix queries) against the current `like` scan on ~93,000 rows.

### Replacing row-level security

This is the main security cost of D1, and it gets its own review before Phase 3 merges.

1. **One door to user data.** `api/src/data/` exports `forUser(db, userId)`, which returns repository functions (`sources.list()`, `records.page(...)`, `files.get(id)`, …). Each one adds `user_id = ?` itself. Route handlers receive only this object.
2. **Lint-enforced.** An ESLint `no-restricted-imports` rule forbids importing `api/src/db/*-schema.ts` outside `api/src/data/` and `api/src/jobs/`. System jobs use a separate, explicitly named `system(db)` entry point.
3. **Isolation tests.** Port `rls.test.ts` to a table-driven test: for every table in `USER_TABLES` (today's `RLS_TABLES`), seed two users and assert that each repository function for user A never returns, updates or deletes user B's rows. `api/test/user-tables.test.ts` (successor of `db:check-rls`) fails CI if a table with a `user_id` column isn't classified.
4. **Encryption stays as the second layer.** Record fields remain sealed with per-user data keys whose associated data includes the user ID, so a scoping bug exposes ciphertext that won't open under the wrong user's key.

### Chat isolation (replaces the restricted Postgres roles)

Today the chat backend connects with two restricted roles (`docs/superpowers/specs/2026-10-04-chat-database-role-gate.md`) so a chat bug can't read tokens, accounts or profiles. On Cloudflare, bindings are the capability boundary:

- A separate **`wildhearts-chat` Worker** serves `/api/chat/*` and the reaper cron. It is bound to a **`wildhearts-chat` D1 database** holding the chat tables (conversations, messages, runs, tool calls, events, summaries).
- It doesn't bind the main D1. It reaches the records it may read (session validity, data keys, health sources, FHIR resources) through a narrow, read-only RPC on the API Worker (`WorkerEntrypoint` service binding). That RPC exposes exactly what today's column grants allow, and nothing about `session.token`, `account`, `verification`, Epic connections or profiles.
- The chat database is in its own D1, so a chat bug can't join across to the main database.
- `chat_lock_session_v2` becomes a `ChatSessionLock` Durable Object keyed by session ID.
- **Needs security review:** update `docs/superpowers/specs/2026-10-07-web-owned-chat-security-boundary.md` before Phase 6.

## Testing

- **API:** Vitest with `@cloudflare/vitest-plugin`. Tests run inside `workerd` with real D1, R2, Durable Object and Workflow bindings from Miniflare, replacing PGlite. Port the existing suites module by module alongside the code.
- **Epic sandbox replay** (`src/lib/sync/sandbox-replay.test.ts`, the fixtures, `src/test/epic-replay.ts`) must pass against the Workflow-based sync before Phase 4 merges. It's the main proof the port didn't change sync behaviour.
- **Web:** existing component and proxy tests, plus a test API stub behind the service binding.
- **Local dev:** `wrangler dev` for the API with local D1 (`wrangler d1 migrations apply --local`), and `next dev` with OpenNext's `initOpenNextCloudflareForDev()` so the `API` binding works. The seed scripts are rewritten against D1 and still refuse non-local databases.

## Data migration (Neon → D1, R2 stays)

Wildcards objects are already in R2, so only rows move.

1. A script `scripts/export-neon.ts` reads each table in primary-key order and writes SQLite insert statements: timestamps to epoch ms, booleans to 0/1, JSON to text, sealed columns copied byte for byte. It never unseals anything and logs table names and counts only.
2. Import with `wrangler d1 execute --remote --file`, chunked.
3. Verify: row counts per table, a checksum of the sealed columns per table, and an in-Worker check that, for a sample of users, each data key unwraps and one record per user opens. Log pass/fail counts only.
4. Rehearse at least twice against the preview environment with a production-shaped copy (or the seeded local data) before the real run.
5. The final copy happens during the cutover window below.

The export writes health data in sealed form to a temporary file on an operator machine. Delete it right after import, and never commit it.

## Cutover

The owner swaps DNS from Vercel to the new site once everything works there. Until then both stacks run, but **only Vercel and Neon take production writes**: D1 and Neon are not kept in sync in both directions. Two writable copies of health data would drift and could lose amendments or deletions.

**Before the swap (both running, weeks):**

- The Cloudflare stack runs at a staging hostname (`wildhearts-web.<account>.workers.dev`, or a custom domain such as `next.wildheartsai.com` once the zone is on Cloudflare), against production-shaped data from rehearsal imports.
- Register the staging callback (`https://<staging>/api/epic/callback`) as an extra redirect URI on the **sandbox** Epic client only, so Epic sign-in can be tested end to end with sample patients. The production Epic client keeps only the `www` URI.
- The VPS services keep pointing at Vercel. A second coordinator/gateway pair, or a config switch, can point at staging for acceptance tests.
- Rehearse the data copy and the full checklist below at least twice. Time it, since the read-only window is about as long as the copy.

**DNS preparation (any time before the swap, no downtime):** if the zone isn't on Cloudflare yet, move its nameservers there first, with the existing records pointing at Vercel unchanged and DNS-only (not proxied). Vercel keeps serving as before. The swap is then one record change in the Cloudflare dashboard, and so is a rollback. Lower the TTL a day ahead.

**The swap (minutes of read-only, no full outage):**

1. Turn on read-only mode on Vercel: a `MAINTENANCE_READ_ONLY` flag that pauses sign-up, Connect, Refresh, uploads and chat with a notice, and pauses the Inngest crons. Viewing still works.
2. Run the final Neon → D1 copy and its verification (counts, checksums, sample decrypts).
3. Point `www` (and the apex redirect) at the web Worker as a Workers custom domain. Requests still on Vercel during propagation see read-only mode, not stale writes.
4. Run the production checks: `/api/health`, sign-in, a records page, a Wildcards download, the sandbox Connect, the nightly crons registered, the VPS reaching `CHAT_WEB_API_URL`, and no errors in Workers Logs.
5. Switch the VPS to the new stack (same URL; it just resolves to Cloudflare now).

**Rollback:** within the first hours, if nothing has been written on Cloudflare, point DNS back at Vercel and turn read-only off. After real writes land in D1, rolling back needs a reverse copy, so fix forward unless something is unsafe. Keep Neon read-only and the Vercel project deployable for 30 days, then delete the Neon database and the Vercel project as part of Phase 8.

## Secrets and configuration

Every variable in `src/lib/env.ts` and `.env.example` maps to a Worker secret or var on the Worker that needs it. Only the API and chat Workers hold secrets.

- `wildhearts-api` secrets: `BETTER_AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `RECORDS_ENCRYPTION_KEY`, the `EPIC_*` keys, `METRIPORT_API_KEY`, the extraction verifier and grant key, the email API key.
- `wildhearts-chat` secrets: `CHAT_GRANT_DERIVATION_KEY`, `CHAT_RESEARCH_GATEWAY_TOKEN_HASH`, plus what the chat role preflight checks today.
- `wildhearts-web`: no secrets, only the `API` service binding and public vars.
- Removed: `DATABASE_URL*`, `CHAT_DATABASE_URL`, `CHAT_QUEUE_DATABASE_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (replaced by bindings), `INNGEST_*`, `SMTP_*`, `VERCEL_URL`.
- `env.ts` keeps its Zod validation, now applied to the Worker `env` object (bindings plus secrets) per request, so a missing secret still fails closed.

## Phases

| # | Phase | Ships |
| --- | --- | --- |
| 0 | Preparation | This plan, Neon size/row measurements, Cloudflare account setup, open questions answered |
| 1 | API skeleton | `api/` Worker with Hono, `/api/health`, the D1 schema and migration, the data layer and isolation tests, CI deploy to a preview |
| 2 | Auth | Better Auth on D1, email sending, session reads for Next |
| 3 | Epic and records | Epic authorize/callback/JWKS, directory search and import, records and timeline reads, export |
| 4 | Jobs | Sync Workflow and Queue, nightly refresh, directory import Workflow, sandbox replay green |
| 5 | Next on Workers | OpenNext build, service binding, pages and server actions on the API client, pdf.js as assets, Web Analytics |
| 6 | Wildcards, extraction, chat, demo | R2 binding routes, extraction worker API, `wildhearts-chat` Worker with its D1 and Durable Object, demo |
| 7 | Data migration and cutover | Read-only flag on Vercel, rehearsals on staging, the production copy, the owner's DNS swap, verification |
| 8 | Cleanup | Remove Vercel, Neon, Inngest, `pg`, `@aws-sdk`, nodemailer; move Next to `web/`; rewrite `AGENTS.md` and the delivery skill for Cloudflare |

Until Phase 7, production keeps running on Vercel. Phases 1–6 deploy only to Cloudflare preview.

### Phase 0: preparation

- [x] Decide platform, database and backend framework (above)
- [ ] Measure Neon: size per table, largest `fhir_attachment` and `fhir_resource` rows, row counts. Decide the R2 threshold for large attachments
- [x] List every transaction (`db.transaction`, `asUser`) and classify it: `docs/superpowers/specs/2026-10-30-d1-transaction-audit.md`
- [x] Check the sealing associated data: `table:field:userId:rowId`, so names and IDs are preserved verbatim (see schema conversion)
- [ ] Cloudflare: create the D1 databases (`wildhearts-prod`, `wildhearts-preview`, `wildhearts-chat-prod`, `wildhearts-chat-preview`), and confirm the R2 buckets
- [ ] Workers paid plan (owner); confirm the current D1, Workflows and Workers limits used in this plan against Cloudflare's docs
- [ ] CI (owner): GitHub secrets `CLOUDFLARE_API_TOKEN` (scoped to Workers and D1 edit on this account) and `CLOUDFLARE_ACCOUNT_ID`, then the repository variable `CLOUDFLARE_PREVIEW_DEPLOY=true` to turn on the `api-preview` job
- [ ] Put the real D1 database IDs and R2 bucket names into `api/wrangler.jsonc` and `api/wrangler.chat.jsonc` (placeholders today)
- [x] Answer the open questions (2026-10-30), except email
- [ ] Before Phase 7: move the zone's nameservers to Cloudflare with records still pointing at Vercel (owner)

### Phase 1: API skeleton

- [x] `api/` package with Hono; `wrangler.jsonc` and `wrangler.chat.jsonc` (`nodejs_compat`, D1 and R2 bindings, `preview` and `production` environments, no public URL)
- [x] D1 schema for all 30 tables (`api/src/db/schema/`, chat tables in `api/src/db/chat/schema.ts`); `drizzle-kit generate` with the `sqlite` dialect into `api/migrations/` and `api/chat-migrations/`. `schema-parity.test.ts` checks table and column names against Postgres
- [x] `api/src/env.ts`: the Zod schema over Worker bindings and secrets
- [x] `forUser` / `system` data layer (`api/src/data/scope.ts`), the lint rule in the root `eslint.config.mjs`, `user-tables.test.ts`, and table-driven isolation tests (`user-scope.test.ts`, checked by breaking the owner condition and watching them fail)
- [x] `/api/health`
- [x] Vitest inside workerd with `@cloudflare/vitest-plugin` (the renamed `vitest-pool-workers`), one project per Worker
- [x] Crypto ported (`api/src/crypto/`) and proven against values sealed by the Node code (`crypto.test.ts`)
- [x] GitHub Actions: `api` job (typecheck and tests) on every PR; `api-preview` job (migrate, then deploy to the shared preview) once Phase 0's Cloudflare setup is done. Production deploys come with the cutover

### Phase 2: auth

- [x] Better Auth 1.7.5 (the app's version) on D1 through the Drizzle adapter, configured as in `src/lib/auth.ts`: email and password, verified email, 12-character minimum, invite gate, 90-day sessions renewed daily, the same rate-limit rules (`api/src/auth/`)
- [x] Served at `/api/auth/*`; `/api/session` returns the signed-in person to the web Worker without the session token (demo workspace selection joins it in Phase 6)
- [x] Rate limiting keys on `cf-connecting-ip` (Cloudflare sets it; `X-Forwarded-For` can be forged) and is on outside development explicitly, since Better Auth's default follows `NODE_ENV`. The web Worker must forward `cf-connecting-ip` unchanged (Phase 5)
- [x] Proven on workerd: password hashes made by the Node app verify, the remembered-browser renewal over 100 days, invite codes, closed sign-up, the IP rate limit (checked by switching it back to `X-Forwarded-For` and watching the test fail), and a `wrangler dev` run of sign-up → verify → sign-in → `/api/session`
- [x] Email: development prints links; preview prints them only with `EMAIL_LOG_LINKS=true` (set in `api/wrangler.jsonc`'s preview vars); production never sends or prints until a provider is chosen. Better Auth logs a failed email and still answers 200 (as on Vercel today), so the account stays unverified
- [ ] Email provider (owner decision; blocks the cutover, not preview)
- [ ] At cutover, give the Workers the same `BETTER_AUTH_SECRET` as Vercel production, so copied sessions and cookies stay valid

### Phases 3–8

Outlined in the table; each gets task-level steps when it starts, as in the records storage plan.

## Risks

| Risk | Mitigation |
| --- | --- |
| A scoping bug leaks one person's data to another (no RLS) | One data layer, the lint rule, table-driven isolation tests, per-user encryption as a second layer, security review before Phase 3 |
| Lost atomicity where transactions read then write | Classify every transaction in Phase 0; batch with guards; Durable Objects where serialization is needed |
| D1 size or row limits | Measure first; large attachments to R2; per-user sharding held in reserve |
| OpenNext lags Next 16.3 features (the `proxy.ts` CSP nonce, image optimization) | Prove the nonce CSP and headers in the Phase 5 preview before switching pages over. The web Worker serves pages only, so falling back to fewer Next features is acceptable |
| `node:crypto` differences in `workerd` (`hkdfSync`, `createCipheriv` with GCM) | Run the existing crypto tests inside the Workers pool first thing in Phase 1. Decrypt Neon-sealed fixtures in Workers before any data moves |
| Email delivery changes provider | Done in Phase 2 with deliverability checks (SPF, DKIM, DMARC) before cutover |
| Preview environments share one D1 (no branching) | Preview data is seeded and made up; migrations are additive and backward compatible as today |
| Cutover data loss or downtime | Read-only window, verified import, DNS rollback, Neon kept read-only for 30 days |

## Open questions

1. **Email provider** (owner will decide later). Gmail SMTP can't be used from a Worker. Needed before cutover, not before Phase 2 work on preview.

Answered 2026-10-30:

- DNS: the owner swaps it from Vercel to the new site once it works there (see "Cutover").
- Downtime: some is fine; both stacks run side by side until the swap, with a short read-only window for the final copy.
- Inngest history: not needed.
- Previews: one shared preview database.
