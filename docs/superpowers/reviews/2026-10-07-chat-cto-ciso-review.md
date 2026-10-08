# CTO and CISO review of web-owned health chat

Date: October 7, 2026

Reviewed design: `docs/superpowers/specs/2026-10-07-web-owned-chat-security-boundary.md`.

Two independent role-based reviewers assessed the proposed architecture and selectively inspected the existing implementation. This is an engineering/security design review, not an external audit, compliance certification, or approval of the pending implementation. No production configuration was changed during this review.

## Recommendation

Both reviewers support keeping all database credentials, record decryption, identity resolution, and execution-grant issuance in the web backend. Production rollout should wait until the execution protocol, atomic authorization checks, recovery, summary provenance, and plaintext handling below are implemented and tested.

The accurate security claim is: **The VPS has no standing database or record-decryption authority; its coordinator has bounded access to execution grants for authorized queued jobs.** The coordinator and inference host remain sensitive infrastructure because they process granted plaintext. A compromised coordinator can obtain grants by claiming eligible jobs; removing its database keys does not remove this indirect authority.

## CTO findings

### Keep the portable API split, simplify ingress

The browser can use same-origin authenticated web APIs. The VPS coordinator can make outbound HTTPS requests to claim work and report status; isolated workers use the fixed local relay. Production no longer requires a public VPS patient-data API, browser-ticket signing key on the VPS, or a separate public chat hostname. Iggy control remains private. Model connectivity is a separate private-network requirement.

Implement domain operations and authorization in ordinary server-side Node modules, with thin Next.js route adapters and a versioned worker protocol. Keep PostgreSQL as the durable queue initially. Avoid another queue platform or a second full authorization implementation in Iggy. Moving the API host later should leave worker contracts unchanged.

### Define the job/grant/lease protocol before coding

Specify allowed transitions for queued, claimed/running, completed, failed, cancelled, and interrupted states, including whether claiming and beginning execution are distinct. The web backend supplies authoritative time, immutable owner/session bindings, and one absolute run deadline. Define API-request, inference-call, lease, worker, and final-flush timeouts consistently under that deadline. Heartbeats cannot extend a run indefinitely.

Prefer a fixed short-lived execution grant for v1 with no routine refresh. If recovery requires replacing a lost grant, define that separately: authorize recovery of the same claim, invalidate the old credential, and preserve the attempt, deadline, fencing, and idempotency guarantees. Worker-ID binding alone does not prove that a bearer-token holder is the original process.

A claim response can be lost after its database transaction commits. A stable claim-request idempotency key must recover the existing claim instead of consuming another job. Hash-only grant storage means credential redelivery/replacement requires an explicit protocol; do not introduce plaintext token storage to hide this problem. Test lost claim, tool, event, and finalization responses.

### Batch events and bound polling

The current Pi adapter persists every provider text delta separately. Preserve streaming through bounded batches, initially around 500 ms with a byte cap and a final flush, instead of one web request and encrypted database operation per provider chunk. Finalization must atomically incorporate the final answer and mark the run terminal; duplicates must not duplicate text or writes. Browser polling uses persisted sequence cursors, pauses while hidden, and backs off when idle. Coordinator polling must also back off when no work is eligible.

The suggested batching interval is an initial implementation choice, not a measured optimum. Measure requests, bytes, database writes, encryption CPU, model latency, and user-visible latency per completed response. There is no evidence yet that this workload will fit free hosting allowances. Vercel accounts for invocations, CPU, and provisioned memory; its documented function payload limit is 4.5 MB, so application limits should be comfortably lower. [Function pricing](https://vercel.com/docs/functions/usage-and-pricing), [function limits](https://vercel.com/docs/functions/limitations).

### Recovery belongs to the authoritative backend

An independent web-owned reaper must mark expired begun runs interrupted, even when the VPS is down. Authorization must deny expired leases before the reaper runs. Keep the user-selected behavior: no automatic rerun after execution begins; the user explicitly retries. Do not cascade-delete chat history when an initiating session is removed.

The prior synthetic real-model response took 114 seconds against a 120-second cap. New HTTP round trips and event flushing add work; benchmark the revised topology before setting production deadlines. Claim only when execution capacity is available, and avoid spending the same lease waiting in separate web, Iggy, and model queues. Start with one active worker and server-enforced concurrency limits.

In serverless deployment, role preflight should be a fail-closed initialization check per runtime instance plus deployment verification, not an assumption that one permanent process starts before all requests.

## CISO findings

### Bound and revoke coordinator authority

Enforce web-side claim rate, concurrency, queue depth, maximum run lifetime, and aggregate context/tool-output budgets. A coordinator credential alone cannot request tenant context, submit a patient ID, create a user question, or renew arbitrary runs. Return only opaque job identifiers and narrowly scoped execution/control grants.

Provide an operator switch to disable a coordinator and revoke its outstanding grants, independently of cooperation by that VPS. Limits reduce exposure but cannot make a compromised coordinator incapable of collecting context from pending authorized jobs.

### Centralize checks and fence mutations atomically

Use one authoritative authorization function for context, tools, summaries, events, completion, replay, and lease operations, with operation-specific permissions. Resolve scope from stored grant/run bindings. Check session validity, grant expiry/revocation, user ownership, attempt, lease owner/expiry, cancellation, budgets, and state before data access.

Sensitive writes must check the relevant authorization and run state in the transaction that commits the write. An earlier independent check is insufficient. Replayed tool results remain protected health data and require current authorization. Terminal retries may return a minimal acknowledgement, not cached plaintext after authority has ended.

Store the initiating internal session reference, never its cookie/token. Define logout as stopping subsequent authorized work and preventing later unauthorized writes; bound in-flight operations and recheck before returning sensitive output where practical. Already delivered plaintext cannot be recalled, and inference cancellation is best effort. Closing the browser must remain distinct from logout.

### Strengthen automatic summary provenance

The existing store checks evidence ownership, but permits empty evidence and does not establish that the cited evidence was read in the current run. For record-grounded health summaries, require nonempty evidence from successful current-run reads, server-generated provenance, and valid record/note versions. Evidence must still be present and permitted when saving.

Treat summaries as derived, untrusted content. Stale or unsupported summaries must not silently become current facts; primary records should remain the basis for factual recall. Ownership and citation checks do not prove that the interpretation matches the evidence. Preserve automatic saving, user-visible deletion, and make an opt-out a sensible product hardening item. User preferences or other memory types, if later added, need separate provenance rules rather than pretending they are record-grounded health facts.

### Specify plaintext and web-route handling

The no-logging rule covers authorization headers, HTTP bodies, tracing/APM, provider error text, Docker output, inference request logs, crash dumps, and persisted model/KV caches. Workers have no persistent transcript mounts; inference must not persist prompts/responses as ordinary logs or caches. Encrypted tool traces remain in the web backend. Operational events use generic error codes and minimal opaque correlation metadata.

Personalized web responses use `private, no-store`; no shared decrypted-context caching. Cookie-authenticated writes require origin/CSRF protection. Bearer-only worker routes must not accept cookies as an alternative authority. Strict schemas and aggregate byte/event limits remain mandatory. If richer answer rendering is later added, prohibit raw HTML and automatically fetched external images.

### Reduce shared-host and deployment exposure

A dedicated production worker host is preferable to the shared Matrix/Element test VPS. Iggy's Docker control is a powerful trusted host boundary: Docker documents daemon-control exposure as capable of granting host-level authority. [Docker security](https://docs.docker.com/engine/security/), [daemon access](https://docs.docker.com/engine/security/protect-access/). This is a recommendation, not authorization to migrate or alter the current host.

Keep Iggy private; only its trusted manager has Docker access. Pin reviewed images and enforce host-wide CPU, RAM, process, and container limits. Separate Bitwarden deployment projects/accounts: VPS deployment cannot retrieve web database, record, or signing secrets. An unrestricted root deployment agent can still inspect local credentials.

Inventory whether real secrets were entered into the obsolete VPS runtime file before cleaning it up. Revoke/rotate exposed database and control credentials as appropriate. Do not blindly rotate `RECORDS_ENCRYPTION_KEY`: changing it without a key migration can make existing records unreadable. Remove direct-database fallback from the new runtime and verify built images, runtime configuration, and machine-account permissions contain no web secrets.

Define an incident procedure: disable claims, revoke outstanding grants, stop workers/inference, preserve sanitized evidence, inspect and rotate affected credentials, then restore service. Define chat/tool-trace retention and soft-deletion versus eventual purge/backups without implying immediate erasure.

## Reconciled implementation order

1. Complete the state transition table, versioned API contracts, grant/claim recovery, hard deadlines, and revocation semantics. Keep opaque grants and one low-concurrency coordinator for v1.
2. Add initiating-session references, grant verifiers/revocation, and idempotency metadata through additive migrations. Preserve existing restricted roles and encrypted storage.
3. Implement same-origin browser APIs and scoped worker/control APIs, centralized authorization, transactional write fencing, summary provenance, and recovery.
4. Replace VPS database access and minting authority with the remote API adapter; retain fixed tool/model relay and isolated Pi containers.
5. Add bounded event batching, adaptive polling, quotas, safe operational metrics, and coordinator/grant kill switches.
6. Test two-user access attempts, claim/reply loss, replay, stale attempts, cancellation/logout races, expired sessions, worker/coordinator restart, and model timeouts. Repeat Docker isolation acceptance and required repository checks.
7. Deploy with chat disabled, verify absence of web secrets on the VPS, then enable a small synthetic/internal canary and measure behavior before broader use.

## Explicit remaining risks and product choices

- VPS compromise can expose selected plaintext and credentials for active or newly claimed authorized jobs until web-side revocation. The inference host can see submitted context and answers.
- A worker may use its allowed tools to retrieve more of its assigned user's records than the question needs, within server-enforced limits.
- Web-backend compromise remains broad. RLS limits accidental or malformed queries under the correct role/context; it does not independently prove caller-selected identity.
- Prompt injection and hallucinations can influence answers and derived summaries even when authorization prevents cross-user lookup. Future research/wiki material must remain untrusted evidence and separate from personal memory and access control.
- Logout or initiating-session expiry stops background access; tab closure alone does not. This security behavior should be visible in the product.
- Decide whether a supported summary saved during a subsequently interrupted run remains usable or is staged until completion. A simple conservative starting point is to exclude incomplete-run summaries from automatic factual recall while retaining their audit/provenance.

These recommendations do not require another orchestration service, a broad vault token, an HMAC minting key on the VPS, or a public VPS health-data API.
