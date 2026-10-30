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
| **G** | Write A, and do B and C only if A changed something (`delete … returning`, then update and audit) | **Guarded batch**: B and C first, each with `WHERE EXISTS (<A's condition>)` or a subquery for A's row, then A last, all in one batch. The ID that A returned comes from the subquery |
| **U** | Upsert, read the ID back, use it in the next insert | Batch with the parent's ID either precomputed (read first; new UUID if absent) or looked up by its unique key in a subquery |
| **C** | `SELECT … FOR UPDATE`, decide in code, `UPDATE` | **Compare-and-set**: read, decide, then `UPDATE … WHERE id = ? AND <the fields the decision read are unchanged>`, and retry or fail if 0 rows changed. Rows changed this way in hot paths get a `revision` integer column (added with their phase, not in the 1:1 schema) |
| **S** | `FOR SHARE` on a session or file so it can't vanish while a row referencing it is inserted | **Conditional insert**: `INSERT … SELECT … WHERE EXISTS (valid session) AND EXISTS (ready file)`, checking the row count |
| **Q** | Queue claim with `FOR UPDATE SKIP LOCKED` | One `UPDATE … SET status = 'running', claim_id = ? WHERE id = (SELECT id … ORDER BY … LIMIT 1) RETURNING *`. Atomic, and no two claimers get the same row |
| **L** | `pg_advisory_xact_lock(user)`, then check-then-insert (quotas, one active job per user) | Prefer one conditional statement (`INSERT … SELECT … WHERE (SELECT count(*) …) < ?`). Where the rule needs code, use a **per-user Durable Object** (`UserSerializer`) that runs the check and write one request at a time |
| **N** | Row lock held across a network call | **Durable Object per resource**. The lock covers an outbound request, so no statement or batch can stand in |
| **X** | One big transaction replacing a whole dataset | Generation swap: write a new generation in chunks, flip a pointer in one statement, delete the old generation afterwards |

## Call sites

### Records, sources and connections (Phases 3–4)

| Site | What it does | Pattern |
| --- | --- | --- |
| `epic/connections.ts` `saveConnection` | Read existing source (for connect or reconnect), upsert `health_source` returning ID, upsert `epic_connection`, audit | **U**. Read first, then a batch: upsert source, upsert connection with `source_id = (select id from health_source where user_id = ? and fhir_base_url = ?)`, audit. Two concurrent connects of one organization may both log "connect". Acceptable |
| `metriport/connections.ts` `saveMetriportConnection` | Same shape | **U** |
| `epic/connections.ts` `deleteConnection`, `metriport/connections.ts` `deleteMetriportConnection` | Delete connection returning `source_id`, mark source disconnected, audit | **G** |
| `sources.ts` `deleteSource` | Delete source (cascades), audit | **G**: insert the audit row only if the source exists, then delete |
| `epic/server.ts` `accessTokenFor` + `getConnectionSecretForUpdate` | Locks the connection row **while refreshing the token at Epic**, so two requests don't both spend a rotating refresh token | **N**: a `TokenRefresher` Durable Object keyed by connection ID does read, refresh at Epic, then persist, one at a time. Highest-risk item: a lost race here forces the person to reconnect |
| `sync/store.ts` `applyDiff` | One query's inserts, supersedes, touches, restores and removes in one transaction | **B**, chunked. D1's limits on bound parameters per statement and statements per invocation mean a large diff can't be one batch. Each chunk must be idempotent so a retried Workflow step can re-run it. Supersede uses precomputed IDs: insert new (ID known), mark old `superseded_at` and `superseded_by` in one statement. Detailed design in Phase 4 |
| `sync/run.ts` `finishRun` | Read stats, set status, audit, update source | Read, then a **G** batch guarded on `status = 'running'` |
| `sync/run.ts` `failRun` | Update run returning (only if queued or running), audit, update source | **G** |
| `records-server.ts` (4 sites), `connections/actions.ts` list | Scoped reads | **R** (the `userKeysFor` first-key insert is `INSERT … ON CONFLICT DO NOTHING` then select: two idempotent statements) |
| `connections/actions.ts` refresh, delete; `export/route.ts`; `extraction/fhir-http.ts` audit; `epic/callback` save | Single writes, or the helpers above | **R**/**B** or the helper's pattern |
| `epic/directory-store.ts` `replaceDirectory` | Replaces ~93,000 directory rows in one transaction | **X** (also needed for the 128 MB memory limit; see the plan) |

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
| `extraction/store.ts` enqueue (lines 22–60, 69–90): per-user advisory lock, session `FOR SHARE`, files `FOR SHARE`, existing jobs `FOR UPDATE`, insert runs and jobs | **L** with a `UserSerializer` Durable Object (multi-file, multi-row rules), and **S** for the session and file checks inside it |
| `claim` (210–240): global advisory lock, backfill waiting → queued, claim next with `SKIP LOCKED` | **Q**: backfill is one `UPDATE … WHERE id IN (SELECT … LIMIT ?)`, claim is one `UPDATE … RETURNING`. The global lock isn't needed |
| Attempt completion (262–282): session and file `FOR SHARE`, job `FOR UPDATE`, then update | **C** on `claim_id` and `status`, with **S**-style `EXISTS` checks in the same `UPDATE` |
| `fhir-store.ts` (file `FOR SHARE`) | **S** |
| Remaining `asUser` reads and single updates (91–205, 244–253) | **R** / single statement |

### Chat (Phase 6; moves to the `wildhearts-chat` Worker and D1)

| Site | Pattern |
| --- | --- |
| `chat/queue.ts` and `chat-web/authority.ts` claim (lines 76–110): coordinator row `FOR UPDATE` (rate window), run `FOR UPDATE SKIP LOCKED` | **Q** for the run. The coordinator's claim window becomes a **C** update (`claim_count < ?` in the `WHERE`) |
| `authority.ts` reap and disable (291–340): coordinator and run row locks | **C** per run, guarded on `status` and `lease_expires_at` |
| `authority.ts`, `browser-http.ts` `chat_lock_session_v2` (session lock function) | **N**: the `ChatSessionLock` Durable Object from the plan |
| `chat/store.ts` per-user advisory lock (line 322) and `browser-http.ts` (line 80) | **L**: `UserSerializer` in the chat Worker, since starting a run checks several rows |
| `chat/store.ts` `FOR UPDATE` on conversation or run (sequence allocation at 85, 328, 546, 673, 798, 1052, 1174) | **C**. Sequence allocation becomes `UPDATE chat_conversation SET next_message_sequence = next_message_sequence + 1 WHERE … RETURNING next_message_sequence - 1`, then the insert in the same batch using a subquery. The ~45 other `asUser` sites in `chat/store.ts` and `chat/gateway.ts` are **R** or single statements, reviewed function by function in Phase 6 |

### Demo (Phase 6)

| Site | Pattern |
| --- | --- |
| `demo/provision.ts` (nested `asUser` in a transaction) | **B** (seeding fixed rows) |
| `demo/workspace.ts` (parent session `FOR SHARE`, per-user advisory lock, profile upsert) | **S** + **L** (conditional insert keyed on the demo user; idempotent) |
| `demo/store.ts` per-demo-user advisory lock | **L** via `UserSerializer` |

## Consequences for the schema

- The Phase 1 D1 schema is a 1:1 port, so the Neon → D1 copy can be checked table by table. `revision` columns for **C** sites are added by later, additive migrations.
- Chat tables move to a separate D1 database (`wildhearts-chat`). Their foreign keys to `user`, `fhir_resource` and `fhir_attachment` can't cross databases, so they become plain columns:
  - Deleting a user deletes their chat rows through the chat Worker's RPC, in the same flow as the account deletion.
  - `summary_evidence.record_id` and `attachment_id` are already re-authorized on every use. Records deleted later just fail that check, which replaces `ON DELETE SET NULL`.
  - Foreign keys between chat tables stay.
- `summary_evidence_target_kind` (a CHECK that lives only in `drizzle/0008_chat_storage.sql`) is declared in the D1 schema.
