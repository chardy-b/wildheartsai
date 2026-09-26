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
