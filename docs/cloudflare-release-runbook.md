# Cloudflare release runbook

This describes the intended deployment policy for the `cloudflare` branch and the current Workers configuration. The branch policy is a requested operating model, **not yet implemented**: do not infer that a push deploys staging or that `prod` is protected. Until an owner establishes those controls and validates credentials/resources, use this as a checklist, not as authorization to deploy.

## Environments and release gates

- **`main` remains production on Vercel.** Cloudflare is a parallel migration; do not switch DNS or treat a Cloudflare release as a production cutover.
- **`cloudflare` push → shared Cloudflare preview/staging** is the intended automatic path after the deployment workflow, credentials, database IDs and preview resources are configured. This is one shared environment, not an isolated environment per PR. Coordinate changes because preview D1/R2 and deployed Workers are shared.
- **Protected `prod` → Cloudflare production** is the intended path. Accept promotion PRs only from this repository's `cloudflare` branch, require a human review and an independently controlled `promotion-ready` check, and prohibit direct pushes, force-pushes, deletion and routine bypass. The human merge is the routine production approval, not a second click afterward. The gate must bind the resulting merge tree and artifact digests to a successful Cloudflare staging receipt; rerun staging if the tree or release inputs change, and reject missing, skipped or expired evidence. Revalidate on the actual `prod` tip before privileged jobs run. Use separate environment credentials restricted to their branches; do not enable an alternate production auto-deploy. No production deployment is authorized by this document.
- `.github/workflows/ci.yml` runs on `pull_request` and tests the app, chat service and API; it deploys nothing. `.github/workflows/cloudflare-preview.yml` is the push-to-staging path. It runs on pushes to `cloudflare` (or by hand), calls the CI checks first, then releases in one job under one lock, in the order below, stopping at the first failure. Credentials come only from the `cloudflare-preview` GitHub environment, and it's off until `CLOUDFLARE_PREVIEW_DEPLOY == 'true'`. **Before turning it on (owner):** create that environment with a preview-only token, limit its deployments to the `cloudflare` branch, and add the preview Worker secrets. Nothing promotes to production. Prior GitHub evidence for commit `3624251` showed only a Vercel preview; it did not establish a Cloudflare deployment.

## Current topology (source of truth: Wrangler configs)

There are three Workers; deploy each with its own configuration and explicit environment:

| Role | Config | Preview name | Production name | Purpose |
| --- | --- | --- | --- | --- |
| Web/OpenNext | `wrangler.jsonc` (repo root) | `wildhearts-web-preview` | `wildhearts-web-production` | Public entry point; serves Next/assets and routes API and chat via service bindings. Does not bind either D1 database. |
| Hono API | `api/wrangler.jsonc` | `wildhearts-api-preview` | `wildhearts-api-production` | Private (`workers_dev: false`, preview URLs disabled); owns main D1 `DB`, R2 `FILES`, API secrets, Durable Objects and Workflows. |
| Chat | `api/wrangler.chat.jsonc` | `wildhearts-chat-preview` | `wildhearts-chat-production` | Private; owns chat D1 `CHAT_DB` and conversation Durable Object; reaches records only through API's `ChatRecords` service entrypoint. |

Both API databases have separate migration directories: `api/migrations/` for `DB`, and `api/chat-migrations/` for `CHAT_DB`. The D1 IDs are set (2026-11-20) and the R2 buckets are Vercel's (`wildheartsai-wildcards-preview`, `-production`); verify each environment's bindings, secret names, R2 bucket, service target and account before any remote migration or deploy. Never substitute one environment's ID or use a default environment accidentally.

The API config declares three Cron schedules (`17 10 * * *`, `41 8 * * *`, `5 8 * * *` UTC) and three Workflows (sync, refresh, directory). Chat declares an hourly `29 * * * *` cleanup Cron. Preserve these bindings/triggers during deployments. Chat's checked-in preview and production `CHAT_ENABLED` values are `0`; the web config also sets `CHAT_ENABLED` to `0` for both. The local top-level configs enable chat and point at a local edge. The edge service is external and is not deployed by these Wrangler commands. Do not enable chat or change its URL/model/token wiring until the edge endpoint, authentication, quotas and end-to-end check are deliberately ready. Durable Object first deployment/lifecycle changes require special care: inspect Cloudflare's current migration/lifecycle guidance and the prior deployed class history before altering class migrations or bindings; do not assume ordinary Worker rollback undoes state changes.

## Before a release

1. Identify the exact source commit and target (`preview` or `production`). Ensure the candidate is the reviewed `cloudflare` commit; for production, follow the protected promotion process, never deploy an arbitrary PR head.
2. Confirm required CI is green for that exact commit: root checks, `api` typecheck/tests, `chat-service` typecheck/tests, and `web-cloudflare` OpenNext build. CI is evidence of code/build checks, not a live deployment or smoke test.
3. Review both schema diffs, Durable Object migration tags, Workflow definitions, bindings, and trigger diffs. For staging, keep real mail, live callbacks and patient data out; verify Cron targets/time zone and outbound effects before enabling schedules. Require separate explicit approval for major data/schema changes and restores, DO lifecycle changes, new live triggers or large replays, DNS/domains/cutover, security/secret changes, and significant spend/quotas. Real patient-data use requires its own privacy/security review and confirmed vendor coverage and agreements before launch.
4. Resolve and review **both** D1 migration lists (`DB` and `CHAT_DB`) before exposing code that depends on them. D1 schema migrations are additive/backward compatible where possible; the API and chat deployments are not a substitute for checking data compatibility. Inspect remote migration state read-only first, for example from `api/`:

   ```sh
   npx wrangler d1 migrations list DB --env preview --remote
   npx wrangler d1 migrations list CHAT_DB --env preview --remote --config wrangler.chat.jsonc
   ```

   For production, substitute `--env production` only when explicitly authorized. These examples inspect; they do not apply migrations. Do not copy or print secrets or patient data.

## Release order and failure handling

Run one release at a time, serialized across both migrations and all three Workers. Do not cancel an in-progress migration. Build first (`npm run cf:build` at repo root) before mutating the environment. Then deploy in dependency order:

1. In staging, apply and verify reviewed, non-destructive `DB` and `CHAT_DB` migrations. In production, start with a separate authorized migration operation and require both schemas to be ready before deploying dependent code. Automate only explicitly allowlisted, rehearsed, backward-compatible changes later. Unexpected or unclassified pending migrations block release. Preserve compatibility with the previous Worker versions and in-flight Workflow runs.
2. Deploy API: `npx wrangler deploy --env <preview|production>` from `api/`.
3. Deploy chat: `npx wrangler deploy --env <preview|production> --config wrangler.chat.jsonc` from `api/`.
4. Deploy the already-built web Worker last with the root config: `npx wrangler deploy --env <preview|production>`.

Use the pinned project dependencies (`npm ci` in the root and `api/` as needed; invoke Wrangler through `npx`, not a global install). The commands above show deployment mechanics, **not permission** to mutate a remote environment; use the verified target and approved release path. `cf:build` does not publish anything. `wrangler versions upload` does not update serving traffic; use an explicitly authorized activation and verify the route. A first Worker deploy or a Durable Object lifecycle migration may require the ordinary deploy path instead. Apply and verify trigger/config changes separately when the version upload path does not apply them. Never treat a staging Worker version ID as a production version.

If any migration, upload or deploy step fails, **fail closed**: stop the sequence, do not deploy dependent later Workers, do not expose web code, and do not start an overlapping release. Record the exact completed steps and deployed versions. Assess compatibility and recover or roll forward under owner direction; do not claim atomic rollback across three Workers, D1, Durable Objects and Workflows. Preserve logs/receipts without sensitive payloads.

## Verification and release receipt

After deployment, verify the target environment's active deployment/version for **all three** Worker names in the table, against the intended commit. Only after smoke and required journeys pass, create a receipt with the source commit and tree, trusted CI run/attempt, build artifact digests, non-secret configuration fingerprint, both migration states, timestamps, and the three deployed version IDs. A single web version is insufficient evidence. Missing required checks or a blocked human-only step do not count as a pass.

Exercise the public web origin and check:

- `/api/health` returns the expected healthy response without leaking secrets.
- Synthetic sign-in/session and a made-up account's onboarding; records/timeline, sync/refresh behavior, and document upload/list/download where those features are in scope; export; and the guided/demo flow. Use only synthetic data in staging. For production, use the approved, non-destructive production smoke procedure; never create patient artifacts merely to test.
- Chat only if deliberately enabled and required for this release: verify the chat API, conversation lifecycle, records boundary, external edge/model connection, and expected cleanup behavior. If chat is disabled, record it as intentionally not exercised—not as passing.
- Check Worker observability/errors and expected Workflow/Cron registration; use a short, redacted `wrangler tail` on the specific Worker and environment only as supporting evidence. Confirm the release version and terminal synthetic Workflow outcome separately. Never log or share health data, tokens, OAuth codes, reset/verification links, patient identifiers, or secrets.

The [`scripts/qa-cloudflare-walkthrough.mjs`](../scripts/qa-cloudflare-walkthrough.mjs) browser walkthrough is **local-stack only**. Its header describes building, migrating and starting the local stack. The walkthrough signs up a synthetic account and deliberately inserts/deletes made-up local data; it optionally tests chat if the local edge responds. Do not point it at a shared or production environment. Adapt the user journeys into a separate staging Playwright gate with isolated synthetic accounts and a changed-flow failure/retry check. The repo's Epic sandbox replay is not proof of live OAuth or Epic production approval; record any human-only sandbox step that remains untested.

Optional read-only MCP/Cloudflare inspection may supplement dashboard/CLI checks, but must not trigger deployment, migrations, DNS changes, or state mutation. Do not substitute MCP visibility for the three-version receipt and routed smoke checks.

## Rollback and incident boundary

For a material live regression, hold further rollout through the authorized release path and alert the owner on the configured private incident route promptly. Identify the failing surface and the last known-good versions. Before reverting any Worker, verify compatibility of that version with **both D1 schemas, service bindings, Durable Object class/state history, and Workflow/trigger state**. A code rollback cannot reverse an applied D1 migration or restore Durable Object state. Prefer a compatible fix-forward when data/state has changed. Production defaults to alert-only without approval for the specific remediation.

Production rollback or DNS failback requires explicit owner approval. If Cloudflare has accepted real writes, do not point traffic back to Vercel/Neon as if it were synchronized: reconcile/copy writes safely first and prevent split-brain writes. No patient artifacts in screenshots, tickets, chat, or release notes. After authorized recovery, verify the live versions and affected journey before sending a private recovery update. Record whether delivery was confirmed.

## References

- [Cloudflare migration plan](superpowers/plans/2026-10-30-cloudflare-migration.md) — architecture, migration/cutover constraints and phase status.
- [Current PR CI](../.github/workflows/ci.yml) and [local API/Cloudflare instructions](../api/README.md).
- [Cloudflare Wrangler D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
- [Cloudflare Workers versions and deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/).
- [Cloudflare Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
