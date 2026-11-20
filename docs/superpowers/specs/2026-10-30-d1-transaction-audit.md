# D1 transaction audit

Phase 0 of `docs/superpowers/plans/2026-10-30-cloudflare-migration.md`. Every place the app relies on Postgres transaction semantics, sorted by the D1 replacement it needs. Ported code follows the pattern named here; a change of pattern needs an update to this file.

## What D1 gives us instead

- **Each statement is atomic, and statements run one at a time per database.** A single `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING` can't be interleaved with another writer, so queue claims and compare-and-set updates need no lock.
- **`db.batch([...])` is atomic** (all or nothing), but it can't read in between statements. Later statements can't use earlier statements' results, except through SQL subqueries.
- **No interactive transactions, row locks (`FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED`) or advisory locks.** Between two separate statements, other requests can write.
- **Durable Objects** serialize work for one key, such as a user or a connection, including across network calls. Use them only where a statement or batch can't express the rule.

## Patterns

| ID | Postgres today | D1 replacement |
| --- | --- | --- |
| **R** | `asUser` around reads only | Plain reads through `forUser(db, userId)`. No transaction needed |
| **B** | Several writes, none depending on an earlier read's result | One `db.batch([...])` through `forUser` |
| **G** | Write A, and do B and C only if A changed something (`delete … returning`, then update and audit) | **Guarded batch**: B and C first, each guarded on A's row (an update `WHERE id = (subquery for A's row)`; an audit row as `INSERT … SELECT` from A's row, so nothing is inserted when it's gone), then A last, all in one batch. Implemented by `auditFrom` (`api/src/data/audit.ts`). Raw `db.run(sql)` can't be used: drizzle's D1 batch fails on raw statements with parameters |
| **U** | Upsert, read the ID back, use it in the next insert | Batch with the parent's ID either precomputed (read first; new UUID if absent) or looked up by its unique key in a subquery |
| **C** | `SELECT … FOR UPDATE`, decide in code, `UPDATE` | **Compare-and-set**: read, decide, then `UPDATE … WHERE id = ? AND <the fields the decision read are unchanged>`, and retry or fail if 0 rows changed. Rows changed this way in hot paths get a `revision` integer column (added with their phase, not in the 1:1 schema) |
| **S** | `FOR SHARE` on a session or file so it can't vanish while a row referencing it is inserted | **Conditional insert**: `INSERT … SELECT … WHERE EXISTS (valid session) AND EXISTS (ready file)`, checking the row count |
| **Q** | Queue claim with `FOR UPDATE SKIP LOCKED` | One `UPDATE … SET status = 'running', claim_id = ? WHERE id = (SELECT id … ORDER BY … LIMIT 1) RETURNING *`. Atomic, and no two claimers get the same row |
| **L** | `pg_advisory_xact_lock(user)`, then check-then-insert (quotas, one active job per user) | Prefer one conditional statement (`INSERT … SELECT … WHERE (SELECT count(*) …) < ?`). Where the rule needs code, use a **per-key Durable Object** (`UserLock`, `api/src/locks.ts`) that runs the check and write one request at a time. The work itself runs in the calling Worker; the object only queues callers by key |
| **N** | Row lock held across a network call | **Durable Object per resource**. The lock covers an outbound request, so no statement or batch can stand in |
| **X** | One big transaction replacing a whole dataset | Generation swap: write a new generation in chunks, flip a pointer in one statement, delete the old generation afterwards |

One more D1 detail: an `INSERT … SELECT` followed by `ON CONFLICT` needs a `WHERE` in the `SELECT` (`WHERE true` will do), or SQLite can't parse it.

## Call sites

### Records, sources and connections (Phases 3–4)

| Site | What it does | Pattern |
| --- | --- | --- |
| `epic/connections.ts` `saveConnection` | Read existing source (for connect or reconnect), upsert `health_source` returning ID, upsert `epic_connection`, audit | **U**. Read first, then a batch: upsert source, upsert connection with `source_id = (select id from health_source where user_id = ? and fhir_base_url = ?)`, audit. Two concurrent connects of one organization may both log "connect". Acceptable |
| `metriport/connections.ts` `saveMetriportConnection` | Same shape | **U** |
| `epic/connections.ts` `deleteConnection`, `metriport/connections.ts` `deleteMetriportConnection` | Delete connection returning `source_id`, mark source disconnected, audit | **G** |
| `sources.ts` `deleteSource` | Delete source (cascades), audit | **G**: insert the audit row only if the source exists, then delete |
| `epic/server.ts` `accessTokenFor` + `getConnectionSecretForUpdate` | Locks the connection row **while refreshing the token at Epic**, so two requests don't both spend a rotating refresh token | **N**: a `TokenRefresher` Durable Object keyed by connection ID does read, refresh at Epic, then persist, one at a time. Highest-risk item: a lost race here forces the person to reconnect |
| `sync/store.ts` `applyDiff` | One query's inserts, supersedes, touches, restores and removes in one transaction | **B**, chunked (`api/src/jobs/sync/store.ts`): rows inserted by `json_each` bulk statements, each chunk an atomic batch; a replaced version is retired, its successor inserted and the two linked in one batch (the successor's id is precomputed). Not atomic across chunks, but repeatable: a retried step re-reads and re-diffs, so it only writes what's missing |
| `sync/run.ts` `finishRun` | Read stats, set status, audit, update source | Read, then a **G** batch guarded on `status = 'running'` |
| `sync/run.ts` `failRun` | Update run returning (only if queued or running), audit, update source | **G** |
| `records-server.ts` (4 sites), `connections/actions.ts` list | Scoped reads | **R** (the `userKeysFor` first-key insert is `INSERT … ON CONFLICT DO NOTHING` then select: two idempotent statements) |
| `connections/actions.ts` refresh, delete; `export/route.ts`; `extraction/fhir-http.ts` audit; `epic/callback` save | Single writes, or the helpers above | **R**/**B** or the helper's pattern |
| `epic/directory-store.ts` `replaceDirectory` | Replaces ~93,000 directory rows in one transaction | **X**, as a `generation` column: slices written with deterministic ids, activated by one insert, old generations deleted after (`api/src/jobs/directory/import.ts`) |

### Wildcards (Phase 6)

| Site | Pattern |
| --- | --- |
| `reserveQuota` (advisory lock, count and sum, then insert) at lines 110, 220, 248 | **L** as one conditional insert: `INSERT INTO wildcard_file … SELECT … WHERE (SELECT count(*) …) < ? AND (SELECT coalesce(sum(size_bytes), 0) …) + ? <= ?`. On 0 rows, re-read usage to build the same error message |
| `for("update")` on the file during part upload and completion (lines 159, 174) | **C** on `status` and `upload_parts` |
| Duplicate lookup, listing, reads (64, 100, 143, 307–349) | **R** |
| Delete flow (392–400): mark deleting, cancel extraction jobs, delete row | Already separate statements; each is one statement. Keep the order |

### Extraction (Phase 6)

| Site | Pattern |
| --- | --- |
| `extraction/store.ts` enqueue (lines 22–60, 69–90): per-user advisory lock, session `FOR SHARE`, files `FOR SHARE`, existing jobs `FOR UPDATE`, insert runs and jobs | **L** with a `UserLock` Durable Object (multi-file, multi-row rules), and **S** for the session and file checks inside it |
| `claim` (210–240): global advisory lock, backfill waiting → queued, claim next with `SKIP LOCKED` | **Q**: backfill is one `UPDATE … WHERE id IN (SELECT … LIMIT ?)`, claim is one `UPDATE … RETURNING`. The global lock isn't needed |
| Attempt completion (262–282): session and file `FOR SHARE`, job `FOR UPDATE`, then update | **C** on `claim_id` and `status`, with **S**-style `EXISTS` checks in the same `UPDATE` |
| `fhir-store.ts` (file `FOR SHARE`) | **S** |
| Remaining `asUser` reads and single updates (91–205, 244–253) | **R** / single statement |

Done (`api/src/data/extraction.ts`): enqueue, backfill and rerun run under `UserLock` key `extraction:<user>`. Claims run under one shared key, `extraction-claim`, as well: the backfill admission and the claim read the same queue, and claims are rare enough that one queue costs nothing. Completion is one batch guarded on an unset result and a still-valid grant, file and session.

### Chat (Phase 6; superseded by one Durable Object per conversation)

On Cloudflare each conversation's content lives in its own `ChatConversation` Durable Object, whose SQLite storage has real transactions (`transactionSync`). So the Postgres patterns below don't carry over call by call:

- Sequence allocation, run state, tool-call records and events: one transaction in the object.
- Claims, leases, reaping and the coordinator's rate window: gone (no VPS coordinator on Cloudflare).
- `chat_lock_session_v2`: the `sessionFence` RPC before every step and read (see the chat security spec, "Cloudflare topology").
- The per-user advisory lock around starting a run: the object serializes its own conversation, and question limits are counted before the run is recorded.
- What stays in `CHAT_DB` (the conversation index, saved summaries and evidence) is written by single guarded statements (**C**) or batches (**B**).

### Demo (Phase 6)

| Site | Pattern |
| --- | --- |
| `demo/provision.ts` (nested `asUser` in a transaction) | **B** (seeding fixed rows) |
| `demo/workspace.ts` (parent session `FOR SHARE`, per-user advisory lock, profile upsert) | **S** + **L** (conditional insert keyed on the demo user; idempotent) |
| `demo/store.ts` per-demo-user advisory lock | **L** via `UserLock` |

Done (`api/src/data/demo.ts`), and later simplified (November 20): the demo is one central chart written once under `UserLock` key `demo-chart`, idempotently (the sync diff), and read by everyone; nothing is written per visitor, so there are no per-person workspaces or locks. `provision.ts` (the single shared demo login, `npm run demo:seed`) isn't ported: the central chart has no login.

## Consequences for the schema

- The Phase 1 D1 schema is a 1:1 port, so the Neon → D1 copy can be checked table by table. `revision` columns for **C** sites are added by later, additive migrations.
- Chat tables move to a separate D1 database (`wildhearts-chat`). Their foreign keys to `user`, `fhir_resource` and `fhir_attachment` can't cross databases, so they become plain columns:
  - Deleting a user deletes their chat rows through the chat Worker's RPC, in the same flow as the account deletion.
  - `summary_evidence.record_id` and `attachment_id` are already re-authorized on every use. Records deleted later just fail that check, which replaces `ON DELETE SET NULL`.
  - Foreign keys between chat tables stay.
- `summary_evidence_target_kind` (a CHECK that lives only in `drizzle/0008_chat_storage.sql`) is declared in the D1 schema.
