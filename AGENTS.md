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

# Project map

- Next.js app on Vercel (project `wildheartsai`, team `lichards-projects`), production at https://www.wildheartsai.com, deployed from `main` by the GitHub integration. Every branch push gets a preview deployment.
- Postgres is Neon in Vercel. Drizzle ORM; schema in `src/lib/db/*-schema.ts`, migrations in `drizzle/`. Auth is Better Auth (email and password, verified email, optional invite code).
- Records flow: Epic SMART on FHIR connection (`src/lib/epic/`) → Inngest job `sync-source` (`src/lib/inngest/`, `src/lib/sync/`) → encrypted rows in `fhir_resource` → dashboard timeline (`src/lib/timeline.ts`). Record fields are sealed with per-user data keys (`src/lib/crypto/user-keys.ts`) under `RECORDS_ENCRYPTION_KEY`; tokens are sealed under `TOKEN_ENCRYPTION_KEY`.
- Plans and specs live in `docs/superpowers/`. The records storage plan (`plans/2026-09-26-records-storage-plan.md`) tracks what's done and what's next.

# Deploying schema changes

- **Deploys do not run migrations.** A PR that adds a file to `drizzle/` needs `npm run db:migrate` against production before or right as it merges, or pages that touch the new tables fail with "relation … does not exist".
- Run it with production's `DATABASE_URL_UNPOOLED` (Vercel → Settings → Environment Variables) set in the same shell: `$env:DATABASE_URL="…"; npm run db:migrate`. Without it, drizzle reads `.env.local` and migrates the local database instead.
- New required env vars (see `src/lib/env.ts`) must be set in Vercel for preview and production before merging.

# Vercel CLI

The Vercel CLI works through `npx vercel@latest` (not installed globally) and is logged in on the dev machine; the repo is linked in `.vercel/`.

- Production errors: `npx vercel@latest logs --environment production --since 1h --level error -x`
- Filter: `--query "status:500"`, `--status-code 5xx`, `--branch <name>`, `--follow` to stream.
- Deployments: `npx vercel@latest ls`. Env var names: `npx vercel@latest env ls`. Sensitive values are redacted by `env pull`; never print or commit them.

# Local development and testing

- `.env.local` holds local values (git-ignored). `DATABASE_URL` points at the local PGlite server on `127.0.0.1:5433`.
- `npm run db:local` starts the local database (keep it running), then `npm run db:migrate`.
- `npm run db:seed` (`scripts/seed-local.ts`) creates a verified, onboarded test account with stored records from two made-up organizations: one connected, with an amended lab, and one disconnected with its records kept. It refuses non-local databases and recreates the account each run.
  - Sign in at http://localhost:3000/sign-in as `test@wildhearts.localhost` / `local-test-password`. These are local test values, not secrets.
  - The seeded organizations have placeholder tokens, so Refresh and loading a note's text fail for them by design.
- Background imports locally need `INNGEST_DEV=1` and the Inngest dev server: `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest`.
- Connecting the real Epic sandbox needs a person to sign in on Epic's hosted MyChart page with one of Epic's published sample patients (fhir.epic.com). Agents can't complete that sign-in.
- `npm test` runs Vitest with in-memory PGlite (`src/test/db.ts`); no database server needed.
- `.claude/launch.json` has `wildhearts-dev` (port 3000) and `wildhearts-prod` (`npm start` on 3100) for the browser preview.
