# Records storage and sync: implementation plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking. Each stage ends with a shippable PR. The later stages are outlined here and get task-level detail when they start.

**Goal:** store every health record we pull from FHIR in Postgres, encrypted per user. Sync it through a job queue on connect, on Refresh and nightly. Serve the connections page and the unified dashboard timeline from the database instead of fetching live from Epic.

**Spec:** `docs/superpowers/specs/2026-09-26-record-storage-and-sync-design.md` (decisions in §7). Everything in the roadmap's Security rules still applies (`docs/superpowers/plans/2026-09-23-dashboard-roadmap.md`).

## Global constraints

- Health data is written to the database **only** through the per-user sealing helpers (`src/lib/crypto/user-keys.ts`). The only plaintext columns are type, category, date, source and bookkeeping.
- Job payloads, logs and `sync_run.stats` hold IDs, counts and error codes only. They never hold tokens, patient IDs or resource content.
- Every read and write of user data filters on the `user_id` from the session.
- Copy that says "we don't store your records" must change in the **same PR** that starts storing them (stage 3).
- No HIPAA, Epic-approval or clinical-accuracy claims.
- Before each PR: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`.

## Stages

| # | Stage | Ships |
| --- | --- | --- |
| 1 | **Schema and crypto** | Record tables and migration, `health_source` split from `epic_connection`, `seal` v2 with associated data, per-user data keys. No behaviour change for users |
| 2 | Sync engine | `sync/plan.ts`, `sync/diff.ts`, store writes, step functions; tested on PGlite with a fake FHIR server; `_lastUpdated` probing checked against the sandbox |
| 3 | Queue and read switch | Inngest client and sync function, hooked to the callback and a Refresh action; `records-store.ts`; `loadRecordsFor` reads the database; copy and consent update (`CONSENT_VERSION` bump, privacy page, landing page, services list) |
| 4 | Connections page | Status chips, last-synced, counts, progress polling, Refresh / Refresh all with cooldown, disconnect-and-keep, delete records |
| 5 | Dashboard timeline | Source chips, filters (source, category, dates), keyset pagination, undated group, amended-record history |
| 6 | Background refresh | Nightly Inngest cron; `reconnect_required` handling |
| 7 | Store more, part 1 | Patient, note Binaries into `fhir_attachment`, extra Condition and Observation categories |
| 8 | Store more, part 2 | New scopes (Medication, Practitioner, PractitionerRole, Organization, Location, Appointment, FamilyMemberHistory), Epic app update, "Reconnect to add more" prompt, scope-aware sync plan, Upcoming group |
| 9 | Hardening | `audit_event`, Postgres RLS, KMS-wrapped keys, FHIR Bundle export |

---

## Stage 1: schema and crypto

### File structure

| File | Responsibility |
| --- | --- |
| `src/lib/crypto/seal.ts` | Adds the `v2` format: AES-256-GCM with associated data. `v1` is unchanged |
| `src/lib/crypto/user-keys.ts` | Per-user data keys: create or load, unwrap with the KEK, derive encryption and MAC subkeys, seal and unseal record fields, content HMAC, shred |
| `src/lib/db/records-schema.ts` | `health_source`, `user_data_key`, `fhir_resource`, `fhir_attachment`, `sync_run`, `sync_cursor` |
| `src/lib/db/epic-schema.ts` | `epic_connection.source_id` |
| `drizzle/0003_records_storage.sql` | Generated migration, hand-edited to backfill `health_source` for existing connections |
| `src/lib/epic/connections.ts` | `saveConnection` upserts the source; `deleteConnection` keeps the source, marked `disconnected` |
| `src/lib/env.ts`, `.env.example`, `src/test/setup.ts` | `RECORDS_ENCRYPTION_KEY` (optional until stage 3 uses it; must differ from `TOKEN_ENCRYPTION_KEY`) |
| `src/lib/records-keys.ts` | Server-only `recordsKey()` that fails clearly when the key is unset |

### Task 1: `seal` v2 with associated data

- [x] `seal(plaintext, key, aad?)`: without `aad` it writes `v1` as today; with `aad` it writes `v2.<iv>.<ciphertext>.<tag>` and authenticates `aad`.
- [x] `unseal(sealed, key, aad?)`: `v2` requires the same `aad`; `v1` refuses a caller that passes `aad`, so an unbound value can't stand in for a bound one.
- [x] Tests: round trip, wrong or missing `aad` fails, `v1` values still open, `v1` with `aad` is refused.

### Task 2: record tables

- [x] `records-schema.ts` as specified in the design §2, using `uuid` ids with `defaultRandom()`.
- [x] `fhir_resource`: partial unique index on `(source_id, resource_type, fhir_id) WHERE superseded_at IS NULL`, a self-referencing `superseded_by` foreign key, and partial timeline indexes.
- [x] `sync_run`: partial unique index on `(source_id) WHERE status IN ('queued','running')`.
- [x] Every table cascades from `user` (and from `health_source` where it applies), so deleting an account deletes everything.
- [x] `epic_connection.source_id uuid NOT NULL UNIQUE`, referencing `health_source` with cascade.
- [x] `npm run db:generate`, then edit the migration: create `health_source` rows for existing connections, add `source_id` as nullable, backfill it, then set it `NOT NULL`.
- [x] Schema tests on PGlite: the tables exist; the migration backfills an existing connection; there is only one current version per resource while superseded versions are allowed; only one active sync run per source; deleting the user cascades.

### Task 3: per-user data keys

- [x] `user_data_key { user_id pk → user cascade, sealed_dek, kek_version, created_at }`.
- [x] `userKeysFor(db, kek, userId, now)` inserts a random 32-byte data key sealed under the KEK. The sealed value is bound to `user_data_key:<userId>:v<kekVersion>`. `ON CONFLICT DO NOTHING` then a read keeps it race-safe. HKDF-SHA256 derives separate encryption and MAC subkeys.
- [x] `sealField(keys, value, { table, field, rowId })` and `unsealField(...)`, with associated data `<table>:<field>:<userId>:<rowId>`, so a blob can't be moved to another row, field or user.
- [x] `contentHmac(keys, resource)`: HMAC-SHA256 over canonical JSON (keys sorted recursively), so key order doesn't matter.
- [x] `shredUserKeys(db, userId)` deletes the key row. Anything sealed under it can no longer be read.
- [x] Tests: one key per user, including when two calls run concurrently; different users get different keys; the wrong KEK fails; a field doesn't open on another row, field or user; the HMAC is stable across key order and differs across users; nothing is readable after shredding.

### Task 4: connections keep a source

- [x] `saveConnection` runs in one transaction. It upserts `health_source` on `(user_id, fhir_base_url)`, setting the name and `status='connected'`, then upserts `epic_connection` with that `source_id`. Reconnecting reuses the same source.
- [x] `deleteConnection` deletes the tokens row and marks the source `disconnected`, keeping it (decision 1). It still returns false for another user's connection.
- [x] Tests: saving creates one source; reconnecting reuses it; disconnecting keeps the source as `disconnected`; reconnecting after that flips it back to `connected` under the same id.

### Task 5: environment

- [x] `RECORDS_ENCRYPTION_KEY`: optional, 32 bytes base64, and rejected if it equals `TOKEN_ENCRYPTION_KEY`. Add it to `.env.example` and test setup.
- [x] `recordsKey()` in server-only `src/lib/records-keys.ts` throws "RECORDS_ENCRYPTION_KEY is not set" when it's missing. Stage 3 makes it required, before anything stores records.
- [ ] Set `RECORDS_ENCRYPTION_KEY` in Vercel (preview and production) before stage 3 merges.

### Task 6: verify

- [x] `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`.
- [x] Test speed: `createTestDb` migrates once per file and clones per test; `testTimeout` raised to 15s because PGlite start-up plus migrations already took ~4.7s on `main` against the 5s default.
- [x] Migration backfill covered by `records-schema.test.ts`, which applies `0000`–`0002`, inserts a connection, then applies `0003`.

---

## Stage 2: sync engine

The engine is plain functions with the database, keys, clock, token and FHIR search passed in, so tests drive it with PGlite and a fake FHIR server, and stage 3 wraps each step in an Inngest `step.run`. Nothing is wired to the app yet.

### File structure

| File | Responsibility |
| --- | --- |
| `src/lib/sync/dates.ts` | `effectiveDate()`: partial FHIR dates become the start of their period, with the precision kept |
| `src/lib/sync/plan.ts` | `SYNC_QUERIES` (from `RECORD_QUERIES`, keyed `Type:category`), paging caps, `planQuery()` (full vs incremental), `searchPath()`, the `_lastUpdated` probe and `interpretProbe()` |
| `src/lib/sync/diff.ts` | `diffResources()`: insert / supersede / unchanged / restore / remove. `isEnteredInError()`, `withoutMeta()` |
| `src/lib/sync/store.ts` | `prepareFetched()` (content HMAC excludes `meta`), `currentRows()`, `applyDiff()` in one transaction per query, cursor read/write, `openStoredRow()` |
| `src/lib/sync/run.ts` | `startRun()` (returns the active run if one exists), `beginRun()`, `syncQuery()`, `finishRun()`, `failRun()`, `runStatusOf()`, and `syncSource()` running every step in order |

### Tasks

- [x] **Plan:** a full pull the first time, whenever the server doesn't honour `_lastUpdated` (or it hasn't been probed), and at least weekly. Otherwise incremental from `lastSuccessAt` minus 1 day.
- [x] **Probe:** after the first complete full pull that finds anything, search again with `_lastUpdated=gt<tomorrow>`. No results means it's honoured; the same results means it's ignored; an error means unsupported.
- [x] **Diff:** identity is `(source, type, FHIR id)`. The content HMAC excludes `meta`, so a bumped `lastUpdated` alone isn't a new version. A changed resource gets a new row and the old one is marked `superseded_at` / `superseded_by`. Entered-in-error is stored with `removed_at` set. A removed resource that comes back is restored. Only a complete full pull marks missing resources removed, and only within its own category.
- [x] **Categories:** an Observation matching two category searches is stored once. A new version takes the category of the query that stored it, and it can't flip back because unchanged resources are never re-stored.
- [x] **Cursors:** they advance to the time the query started, and only when the pull was complete. A truncated pull stores what it got, sets `errorCode: "truncated"`, and marks nothing removed.
- [x] **Failures:** a FHIR error on one query goes in its stats as a status code and the run continues, ending `partial`. `ReconnectRequiredError` fails the run and marks the source `reconnect_required`. Database errors are thrown, so the queue retries them.
- [x] **Stats and logs:** counts and codes only. Log lines are `[sync] <key> failed <code>` or `[sync] <key> truncated`.
- [x] **Tests:** pure tests for plan, diff and dates, plus end-to-end tests on PGlite with a fake FHIR server covering: first sync; no-op resync; supersede; meta-only change; removal and restore; entered-in-error; incremental after a probe; servers that ignore or reject `_lastUpdated`; partial failure; truncation; reconnect; no PHI in stats; one active run.
- [ ] **Sandbox check (manual, at the start of stage 3):** run a sync against the Epic sandbox patients and record which queries honour `_lastUpdated` (from `sync_cursor.supports_last_updated`).

---

## Stage 3: queue and read switch

### File structure

| File | Responsibility |
| --- | --- |
| `src/lib/inngest/client.ts` | Inngest client and the `records/sync.requested` event (`{ runId, userId, sourceId }`, IDs only) |
| `src/lib/inngest/functions.ts` | `sync-source` function: concurrency 1 per source, 3 retries per step, `onFailure` ends the run |
| `src/app/api/inngest/route.ts` | Inngest serve endpoint (GET/POST/PUT), verified with `INNGEST_SIGNING_KEY` |
| `src/lib/sync/job.ts` | `runSyncJob()`: `begin`, one step per query, `finish`. Each step reloads its connection and keys, and returns only booleans or strings. Replaces stage 2's `syncSource()` |
| `src/lib/sync/request.ts` | `requestSync()`: owner and connected checks, a 5-minute manual cooldown, one active run, and failing the run if the event can't be sent |
| `src/lib/sync/server.ts` | Server wiring: `loadSyncJob`, `requestSyncFor`, and `startFirstSyncs` for connected sources that never synced |
| `src/lib/sources.ts` | `listSources()` (status, connection, syncing, last run stats, record count), `deleteSource()`, `needingFirstSync()` |
| `src/lib/records-store.ts` | `loadStoredRecords()` (decrypts current rows, tags each with the organization's current name, newest first), `sourceProblems()` |
| `src/lib/records.ts` | Live-fetch aggregator removed; keeps `RECORD_QUERIES`, `RecordProblem` (adds `importing`), `newestFirst`, `countByCategory` |

### Tasks

- [x] `startRun` fails queued or running runs older than 3 hours, so a lost event can't block a source forever. `failRun` only touches active runs.
- [x] The callback queues a `connect` sync after saving. Queueing failures are logged and not fatal: the dashboard queues first syncs for connected sources that never had one, which also covers connections made before stage 3.
- [x] Dashboard and category pages read stored records only. Disconnected sources' records still show, without a connection for note text.
- [x] Connections page lists organizations: status, record count and last update, Refresh, Reconnect, Disconnect, and "Delete records" behind a `<details>` confirmation.
- [x] Copy and consent: privacy notice (health records, what we store, Inngest, security, choices, account deletion), landing principles, acknowledgement text, `CONSENT_VERSION` → `2026-09-stored-records`, connections footnote, notices.
- [x] `RECORDS_ENCRYPTION_KEY` is now required. `.env.example` documents `INNGEST_DEV`, `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.
- [x] Verified locally with a production build and the Inngest dev server: the endpoint registers the function, and an event runs `begin`, 18 query steps and `finish`, with stats and the source updated. Epic is unreachable from the build sandbox, so every search returned 403 there.
- [ ] Before merging: install the Inngest Vercel integration (it sets `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`) and set `RECORDS_ENCRYPTION_KEY` in preview and production.
- [ ] On preview: connect the Epic sandbox, watch the import finish, refresh, disconnect, delete records. Record which queries honour `_lastUpdated` (`sync_cursor.supports_last_updated`).

---

## Stage 4: connections page

- [x] `listSources` returns per-category counts (`categoryCounts`) alongside the total.
- [x] `src/lib/source-display.ts` (pure and tested): `ago`, `categoryCounts`, `lastRunIssues` (failed vs truncated categories, shared with the dashboard notices), `listOf`.
- [x] Each organization shows its status line, category chips, and what the last sync couldn't load.
- [x] Live progress: `SyncWatcher` (a client component) calls `router.refresh()` every 4s while anything is importing, on the connections, dashboard and category pages. It stops when the server reports nothing importing. Only server-rendered HTML is involved; there's no polling API.
- [x] "Refresh all" appears with two or more connected organizations. One message reports the outcome.
- [x] Disconnect asks what to do with imported records: keep them (primary) or delete them. Disconnected organizations offer Reconnect (primary) and Delete records.
- [x] The dashboard's "unavailable" notice now says some records didn't load last time, with a link to refresh.
- [x] Checked in a local production build with seeded data (connected with issues, disconnected with kept records, importing) at desktop and phone widths.

---

## Stage 5: dashboard timeline

- [x] `src/lib/timeline.ts`: `timelinePage()` reads one page with keyset pagination on `(effective_at desc nulls last, id desc)`, filtered by source, category and date range (a date range leaves out undated records). It attaches each record's earlier versions as `history`. Also `parseFilters` (only the person's own sources, known types, valid dates), `parseCursor`/`encodeCursor`, `filterQuery`, `countsFor`, `sourceTones`, and `allNotes` (so a visit's notes show whatever page they're on).
- [x] The dashboard home shows filters (health systems, type, from/to) as a plain GET form, 100 records a page with "Older records" and "Back to newest" links, undated records last, and category chips counted from stored totals. Category pages get the same filters (minus type) and paging.
- [x] Each organization gets its own color (6 tones, by connection order) on row tags and filter options, always alongside its name.
- [x] Amended records carry an "Amended" tag. Their detail explains the change and lists each earlier version's fields.
- [x] Removed the load-everything path (`loadRecordsFor`, `loadStoredRecords`, `newestFirst`, `countByCategory`, `RecordsResult`).
- [x] Visit notes match on organization as well as connection, so two disconnected organizations' notes can't mix.
- [x] Fixed a phone-width overflow in the app header (it predates this work): the brand and links now wrap onto two lines under 700px. Checked no horizontal scroll at 320, 390, 768 and 1100px on the dashboard, a category page and connections.
- [x] Checked in a local production build: 114 records across two organizations page as 100 + 14, the organization filter narrows to 3, and an amended lab shows its new value with the earlier one kept.
