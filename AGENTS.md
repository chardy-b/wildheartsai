<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Wild Hearts AI delivery rules

- Treat health data, OAuth credentials, authorization codes, access tokens, refresh tokens, and patient identifiers as sensitive. Never commit, log, or expose them to client-side code.
- Keep Epic/FHIR secrets server-only. Use encrypted, short-lived storage and least-privilege SMART scopes when authentication is implemented.
- Do not claim HIPAA compliance, Epic production approval, or clinical accuracy without documented evidence.
- Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` before delivery.
- Keep the unauthenticated `/api/health` endpoint free of secrets and dependencies.

# Branches

- `main` is the Vercel build (Neon Postgres, Inngest, Gmail SMTP), deployed by Vercel.
- `cloudflare` is the same app running natively on Cloudflare (Workers via OpenNext, D1, Workflows, Email Service). Both are maintained for now.
- Product changes land on `main` first; bring them to `cloudflare` by merging `main` into it. Anything that touches the database, background jobs, email or deployment needs porting, not just merging: D1 is SQLite (no `DISTINCT ON`, `::jsonb`, `FOR UPDATE` or interactive transactions), and date parameters in raw `sql` must be epoch milliseconds.
- The notes below describe the `cloudflare` branch.

# Project map

- Next.js app on Cloudflare Workers through the OpenNext adapter. `worker.ts` is the Worker entry: it serves the OpenNext build (`.open-next/`) and exports `SyncWorkflow`. `wrangler.jsonc` defines the production Worker `wildheartsai` and the preview Worker (`--env preview`), each with its own D1 database and workflow.
- Database is Cloudflare D1 (binding `DB`). Drizzle ORM with `sqlite-core`; schema in `src/lib/db/*-schema.ts`, migrations in `drizzle/`. Writes that must land together use `db.batch`; long ID lists and bulk inserts go through `src/lib/db/bulk.ts` (D1 allows 100 bound parameters per statement). Auth is Better Auth (email and password, verified email, optional invite code).
- Records flow: Epic SMART on FHIR connection (`src/lib/epic/`) → Cloudflare Workflow `SyncWorkflow` (`src/worker/sync-workflow.ts`, `src/lib/sync/`) → encrypted rows in `fhir_resource` → dashboard timeline (`src/lib/timeline.ts`). Record fields are sealed with per-user data keys (`src/lib/crypto/user-keys.ts`) under `RECORDS_ENCRYPTION_KEY`; tokens are sealed under `TOKEN_ENCRYPTION_KEY`. Token refresh is serialized with a lease on `epic_connection` (`src/lib/epic/server.ts`).
- Email goes through Cloudflare Email Service (binding `EMAIL`, `src/lib/email.ts`).
- Plans and specs live in `docs/superpowers/`. The records storage plan (`plans/2026-09-26-records-storage-plan.md`) tracks what's done and what's next; it predates the Cloudflare port.

# Deploying schema changes

- **Deploys do not run migrations.** A PR that adds a file to `drizzle/` needs `npm run db:migrate:remote` (production) and `npm run db:migrate:preview` before or right as it deploys, or pages that touch the new tables fail with "no such table".
- New required env vars (see `src/lib/env.ts`) must be set on both Workers before deploying: plain values in `wrangler.jsonc` or the dashboard, secrets with `npx wrangler secret put NAME [--env preview]`.
- After changing `wrangler.jsonc`, run `npm run cf-typegen` and commit `cloudflare-env.d.ts`.

# Wrangler CLI

- `npx wrangler tail` streams production logs (`--env preview` for preview); Workers observability is on, so logs are also in the dashboard.
- `npx wrangler d1 execute DB --local --command "…"` queries the local database; `--remote` queries production. Never print or copy stored sealed values or secrets.
- `npx wrangler secret list` shows secret names; values are never readable.

# Local development and testing

- `.env.local` holds local values (git-ignored) for both `npm run dev` and `npm run preview`.
- `npm run db:migrate:local` creates the local D1 in `.wrangler/state`.
- `npm run db:seed` (`scripts/seed-local.ts`) creates a verified, onboarded test account with stored records from two made-up organizations: one connected, with an amended lab, and one disconnected with its records kept. It only opens the local D1 and recreates the account each run.
  - Sign in at http://localhost:3000/sign-in as `test@wildhearts.localhost` / `local-test-password`. These are local test values, not secrets.
  - The seeded organizations have placeholder tokens, so Refresh and loading a note's text fail for them by design.
- `npm run dev` runs background imports in-process (Workflows only exist in the Workers runtime) and prints emails to the console. `npm run preview` runs the real Worker in workerd, with Workflows, on port 3000.
- Connecting the real Epic sandbox needs a person to sign in on Epic's hosted MyChart page with one of Epic's published sample patients (fhir.epic.com). Agents can't complete that sign-in.
- `npm test` runs Vitest against Miniflare's local D1 (`src/test/db.ts`); no database server needed.
- `.claude/launch.json` has `wildhearts-dev` (port 3000) and `wildhearts-prod` (`npm start` on 3100) for the browser preview.
