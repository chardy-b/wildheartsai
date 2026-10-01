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
- Health system search: Inngest job `refresh-epic-directory` (daily, or on the `epic/directory.refresh-requested` event) merges Epic's Brands bundle (~95 MB, health systems and their ~96,000 clinics) with its R4 endpoint list into `epic_directory_entry` (`src/lib/epic/brands.ts`, `directory-store.ts`). Search and Connect read that table; until the first import they use the R4 list live (`directory.ts`). `npm run directory:import` imports into the local database. Plan: `plans/2026-09-30-epic-directory.md`.
- Row-level security (`src/lib/db/rls.ts`): code serving a signed-in person reads and writes through `asUser(db, userId, tx => ...)`, so the database only shows their rows. Keep network calls outside it. New tables holding a person's data get a policy in a migration and an entry in `RLS_TABLES`.
- Plans and specs live in `docs/superpowers/`. The records storage plan (`plans/2026-09-26-records-storage-plan.md`) tracks what's done and what's next.

# Deploying schema changes

- **Every Vercel build runs `drizzle-kit migrate` first** (the `vercel-build` script), against that deployment's database: production's on `main`, the preview's own Neon branch on a PR. A failed migration fails the build, so the previous deployment keeps serving. `drizzle.config.ts` prefers `DATABASE_URL_UNPOOLED`, Neon's direct connection.
- Migrations run before the new code goes live but while the old code is still serving, so keep them backward compatible: add columns and tables in one PR, drop or rename in a later one.
- To migrate production by hand (for example, to apply one before merging), run `pwsh scripts/migrate-production.ps1` and paste production's `DATABASE_URL_UNPOOLED` (Vercel → Settings → Environment Variables, **Production** scope; the Preview and Development values point at other Neon branches). It shows the host, asks to confirm, migrates, and checks the tables exist. Without a URL, drizzle reads `.env.local` and migrates the local database instead.
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

# Recorded Epic sandbox data (QA fixtures)

- `src/test/fixtures/epic-sandbox/*.json` are recordings of what Epic's sandbox returned for one sample patient: every sync search (or its error) and each note's Binary. `src/lib/sync/sandbox-replay.test.ts` replays each file through the real sync job, timeline and note storage (`src/test/epic-replay.ts` is the fake Epic). Agents can run these any time: no network, no sign-in.
- `handmade-example.json` is a small hand-written fixture that keeps the replay tests meaningful before a real capture exists.
- To record fresh data (a person must do the sign-in): run the app locally, connect "Epic sandbox (sample patients)" on Connections with one of Epic's sample patients, then `npm run qa:capture -- --name <patient-name>` and commit the file. The script refreshes an expired access token itself, refuses anything but Epic's sandbox (sample patients are made up, so the files are safe to commit), and writes nothing if every search failed.
- If the capture says the connection has expired, reconnect the sandbox locally and run it again.
- `.claude/launch.json` has `wildhearts-dev` (port 3000) and `wildhearts-prod` (`npm start` on 3100) for the browser preview.
