# Wild Hearts AI

A web application, running natively on Cloudflare, intended to help patients connect to Epic health records through SMART on FHIR OAuth.

> **Status:** foundation only. No Epic connection, patient authentication, or health-data storage is implemented yet. This software is not medical advice and makes no compliance claim.

## Landing page

The public page at `/` follows the Nightlight creative direction in [`docs/creative-direction.md`](docs/creative-direction.md): palette, typography, motifs, motion and the claims the page may and may not make. Components live in `src/components/landing/`.

## Stack

Everything runs on Cloudflare:

| Piece | Cloudflare product | Where |
| --- | --- | --- |
| Next.js App Router (TypeScript, Tailwind CSS) | Workers, through the [OpenNext Cloudflare adapter](https://opennext.js.org/cloudflare) | `open-next.config.ts`, `worker.ts` |
| Database (Drizzle ORM) | D1, binding `DB` | `src/lib/db/`, migrations in `drizzle/` |
| Record imports (background job) | Workflows, binding `SYNC_WORKFLOW` | `src/worker/sync-workflow.ts` |
| Verification and reset emails | Email Service, binding `EMAIL` | `src/lib/email.ts` |
| Static files and prerendered pages | Workers static assets | `.open-next/assets` (built) |
| Configuration and secrets | Worker vars and secrets | `wrangler.jsonc`, `cloudflare-secrets.d.ts` |

`worker.ts` is the Worker's entry point: it serves the Next.js app that OpenNext builds into `.open-next/`, and exports the `SyncWorkflow` class that imports records.

Notes on the D1 port (it was Postgres):

- D1 has no interactive transactions. Writes that must land together use `db.batch([...])`, which D1 runs atomically.
- D1 has no row locks. Refreshing a connection's Epic tokens is serialized with a short lease column on `epic_connection` (`src/lib/epic/server.ts`).
- D1 allows 100 bound parameters per statement, so long ID lists and bulk inserts go through one JSON parameter and `json_each` (`src/lib/db/bulk.ts`).
- Timestamps are stored as epoch milliseconds, IDs as text UUIDs, JSON as text.

## Local development

Requires a Node.js version supported by the pinned Next.js release.

```bash
npm ci
cp .env.example .env.local      # then fill in the blanks
npm run db:migrate:local        # creates the local D1 database in .wrangler/state
npm run dev                     # Next.js dev server, with the Worker's bindings
```

Open <http://localhost:3000>. The unauthenticated health check is at <http://localhost:3000/api/health>.

`npm run dev` reads the local D1 through `initOpenNextCloudflareForDev()` (in `next.config.ts`). It prints emails to the console and runs record imports in-process, since Workflows only exist in the Workers runtime.

To run the real Worker locally (workerd, with Workflows and the email binding) use `npm run preview`. It builds with OpenNext and serves on the same port with the same `.env.local`. Emails are written to `.wrangler/tmp/email/` instead of being sent.

After changing `wrangler.jsonc`, run `npm run cf-typegen` to refresh `cloudflare-env.d.ts`. After changing `src/lib/db/*-schema.ts`, run `npm run db:generate` for a new migration, then `npm run db:migrate:local`.

## Validation

```bash
npm run lint
npm run typecheck
npm test          # database tests run against Miniflare's local D1
npm run build     # Next.js build
npm run preview   # OpenNext build, then the Worker locally
```

## Epic / SMART on FHIR direction

The intended authorization-code flow is:

1. Discover the selected Epic FHIR server's SMART configuration.
2. Create a server-generated `state` value and PKCE verifier/challenge.
3. Redirect the patient to the health system's Epic authorization endpoint.
4. Validate `state` on the server and exchange the returned code server-side.
5. Store tokens only in encrypted, server-controlled storage with explicit expiry and revocation handling.
6. Request the minimum FHIR scopes needed for a documented patient experience.

Before real patient data is used, the project needs a reviewed threat model, privacy policy, data-retention design, Epic app registration, production redirect URIs, audit and incident-response plans, and an evidence-backed HIPAA/legal assessment.

## Environment variables

Copy `.env.example` to `.env.local` for local values. Never commit real credentials or tokens. Keep all Epic credentials server-only; do not prefix them with `NEXT_PUBLIC_`.

Deployed Workers take the same names:

- **Plain vars** in `wrangler.jsonc`: `SIGNUPS_ENABLED`, `EPIC_ENVIRONMENT`, `EPIC_PRODUCTION_ACCESS_ENABLED`, `EMAIL_FROM`. Production and preview each have their own values.
- **Per-deployment vars**, set in the dashboard (Workers → wildheartsai → Settings → Variables): `BETTER_AUTH_URL`, `EPIC_REDIRECT_URI`, `EPIC_CLIENT_ID`. `keep_vars` stops deploys from removing them.
- **Secrets**, set with `npx wrangler secret put NAME` (add `--env preview` for preview): `BETTER_AUTH_SECRET`, `EPIC_PRIVATE_JWK`, `TOKEN_ENCRYPTION_KEY`, `RECORDS_ENCRYPTION_KEY`, and when used `SIGNUP_INVITE_CODE`, `EPIC_RETIRING_PUBLIC_JWK`, `EPIC_PRODUCTION_CLIENT_ID`, `EPIC_PRODUCTION_PRIVATE_JWK`, `EPIC_PRODUCTION_RETIRING_PUBLIC_JWK`.
- **Build-time**: `NEXT_PUBLIC_SITE_URL` must be set in the environment that runs the build.

## Deployment

Two Workers, each with its own D1 database and workflow: `wildheartsai` (production) and `wildheartsai-preview` (`--env preview`, sign-ups open). The Workers Paid plan is required: the Worker is about 3.3 MB compressed, over the free plan's 3 MB.

One-time setup:

1. `npx wrangler login`.
2. `npx wrangler d1 create wildheartsai` and `npx wrangler d1 create wildheartsai-preview`; put each printed `database_id` into `wrangler.jsonc`.
3. Onboard the sending domain (`wildheartsai.com`) to Cloudflare Email Service so `EMAIL_FROM` can send to any address.
4. Set the vars and secrets above for each Worker.
5. Update Epic's app registration with the new redirect URIs and JWK Set URLs (`https://<domain>/api/epic/callback`, `https://<domain>/api/epic/jwks`).

Each release:

```bash
npm run db:migrate:remote && npm run deploy                  # production
npm run db:migrate:preview && npm run deploy:preview         # preview
```

To deploy from GitHub instead, connect the repository in Workers Builds with build command `npx opennextjs-cloudflare build` and deploy command `npx opennextjs-cloudflare deploy` (add `--env preview` for the preview Worker).
