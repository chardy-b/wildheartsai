# Offline health research wiki

Status: implementation reviewed on `codex/offline-health-research`; full local checks and isolated VPS publishing passed. Production rollout remains pending merge, configuration and account acceptance.

The private research repository stays on the VPS and is manually updated there. All signed-in Wild Hearts users are the approved audience. No GitHub token, public repository, database importer or public VPS endpoint is required. The gateway reads only a fixed read-only curated Markdown corpus. Repository content is reference material, never agent instructions or patient-record evidence.

## Tool and authority contract

`search_research` accepts a query of at most 200 characters and up to five results. `read_research` accepts the returned SHA256 snapshot/source IDs, a nonnegative character offset and a limit of at most 12,000 characters. Pagination counts Unicode code points; the wire also limits each excerpt to 12,000 UTF-16 code units and the entire serialized output to 32 KiB. Structured passages include title, relative Markdown path, line bounds, excerpt, offset, nextOffset, totalChars and truncation state. Search includes a bounded hits array and aggregate truncation flag.

The gateway calls only these two new web endpoints:

- POST `/api/chat/worker/v1/execution/research/begin`: toolCallId, tool, strictly parsed input and proposedSnapshotId. The web reserves a shared tool call and returns execute/operationId/authoritative snapshotId/deadlineAt, or the prior completed output/fixed failure.
- POST `/api/chat/worker/v1/execution/research/result`: operationId and either completed/output or failed/allowlisted errorCode. The web stores the result before the gateway returns it to the worker.

Both endpoints require the existing execution Bearer grant plus `X-Chat-Research-Gateway-Token`. Web configuration stores only `CHAT_RESEARCH_GATEWAY_TOKEN_HASH`; the raw random 32-byte base64url credential belongs only in the gateway's `CHAT_RESEARCH_GATEWAY_TOKEN`. It is absent from coordinator and worker environments. Missing configuration disables research while existing patient chat remains available. This narrow credential cannot mint grants or authorize patient tools by itself.

The existing web transaction locks coordinator, initiating session and run, checks attempt/lease/cancellation/revocation/deadline, and rechecks the clock/session before commit. No VPS filesystem work occurs inside this transaction. An identical retry uses the same provider call ID and exact normalized arguments/proposal; conflicts never overwrite results. One reservation counts against the existing six-call limit. Only first successful result persistence charges the shared 192 KiB output budget. Failed calls also consume their reservation.

## Snapshots and failure recovery

The first available research reservation pins the content-derived snapshot SHA in run metadata. New searches use that authoritative pin even if a restarted gateway proposes a newer corpus. Read inputs must match it. The gateway must execute against the returned snapshot; an unavailable old snapshot produces a durable `snapshot_unavailable` failure. No silent snapshot replacement occurs.

An initial missing/invalid corpus can be recorded using the search-only begin variant `proposedSnapshotId: null, failureCode: research_unavailable`. It creates an encrypted failed call and consumes one reservation without inventing or changing a pin. Exact retries still resolve to that failure after a later call successfully pins a corpus. If a run already has a pin, this variant instead reserves that pinned snapshot and returns the normal execution reply; a retained snapshot remains usable, while a missing pinned snapshot is durably recorded as `snapshot_unavailable`.

Tool arguments, actual/proposed snapshots, completion digests, source paths and excerpts use the existing encrypted `chat_tool_call` fields. Failed results are bounded codes. Pending calls close on cancellation, run termination, coordinator disablement or independent web reaping; completed results remain unchanged. Reaping discovers bounded metadata through the queue role and atomically changes each run and pending research calls through the scoped data role. No new database schema or broader queue-role grants are needed.

## Citations and patient provenance

Research calls always carry an empty readEvidence array. Generic patient completion helpers reject research calls. Research cannot satisfy the record/note receipts required by save_summary.

The authenticated source viewer reads the user's own completed research results through `listResearchToolPage`. It exposes no query arguments, provider IDs, patient receipts or credentials. Public callOrder and after cursors are one-based; default one/max two calls are queried with one lookahead row. Each result is strictly validated, at most 32 KiB, with an aggregate page cap of 64 KiB. The viewer shows the exact stored excerpt and snapshot rather than requesting a live filesystem path or relying on private GitHub access. Further source text is available through the bounded read tool.

## Validation and rollout

Use synthetic corpus files and constrained database roles to verify credential separation, ownership, exact retries/conflicts, snapshot pinning, Unicode pagination, byte budgets, source trace encryption, missing-corpus recovery, cancellation/logout/deadline fencing, terminal cleanup and exclusion from patient provenance. Run service and web tests, lint, types and builds. Review the merged Docker environment/mount graph before rollout; do not distribute the raw research gateway credential to workers or coordinator.

Validation completed on October 8, 2026:

- Application lint (zero errors, three existing warnings), typecheck, 436 tests across 66 files, and production build passed.
- Chat-service typecheck, 48 tests across nine files, and build passed. Independent Sol 6.1 review approved the service and source viewer; the independent boundary review approved the web authority and deployment graph.
- The actual wiki snapshot published locally and in a network-disabled, unprivileged Docker container on the shared VPS: 744 curated Markdown files, 4,979,136 bytes, identical content-derived snapshot IDs. A synthetic symlink was rejected without changing the valid publication.
- Matrix/Element and existing production chat containers were untouched. The wiki is staged for testing; no production research mount or credential was enabled.

The new in-flight expiry regression also found and repaired UTC timestamp handling in browser and worker session locks. No database migration or permission expansion is required.