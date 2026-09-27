# To do

Follow-ups that aren't part of a plan yet. Remove an item when it's done.

## Security (from the 2026-09-27 scan)

Done in PR #30: database-backed auth rate limits, Content-Security-Policy with a per-request nonce, HSTS.

### Vercel

- [ ] **Give previews their own database.** `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and the `PG*`/`POSTGRES_*` variables apply to both preview and production, so code from any branch push runs against the production database (accounts, sessions, stored records), and preview sign-ups create real users. Accepted for now for convenience. Fix: turn on a Neon database branch per preview deployment in the Neon integration, or set a preview-only `DATABASE_URL` pointing at a Neon dev branch, then drop the preview target from the production entries.
  - Until then, only people with write access to the repo can trigger preview deployments: the repo is public, but outsiders can only open pull requests from forks, and Vercel's Git Fork Protection holds those for approval. Keep write access limited, and don't approve fork deployments without reading the code.
- [ ] **Confirm preview keys differ from production.** `TOKEN_ENCRYPTION_KEY`, `RECORDS_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` have separate preview and production entries, but they're Sensitive, so nobody can compare them. If the preview values were copied from production, previews can read production's stored records. Rotate the preview ones to fresh values to be sure.
- [ ] **Delete unused secrets:** `EPIC_CLIENT_SECRET` (the app uses `private_key_jwt`, not a client secret), `NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL`. Nothing in the code reads them.
- [ ] **Check the production flag values:** `EPIC_PRODUCTION_ACCESS_ENABLED` is `false` until Epic's production review is done; `SIGNUPS_ENABLED` and `EPIC_ENVIRONMENT` are as intended.
- [ ] **Preview Epic redirect.** `EPIC_REDIRECT_URI` is shared with previews, so connecting Epic from a preview returns to the production domain and fails. Epic only accepts exact, registered redirect URIs, so previews need one fixed address (for example a `preview.wildheartsai.com` domain assigned to a `staging` branch), registered on the non-production Epic app, with a preview-only `EPIC_REDIRECT_URI`.

### Code

- [ ] **Bind Epic tokens to their row.** `src/lib/epic/connections.ts` seals tokens and patient IDs without associated data (`seal` v1), unlike record fields. Someone who can write to the database could move one person's tokens onto another's connection. Seal with `epic_connection:<userId>:<id>` as `aad`, with a migration path for existing v1 values.
- [ ] **Bind the Epic connect cookie to the user.** The `wh_epic_flow` cookie doesn't record who started the connection. Add `userId` to the flow in `/api/epic/authorize` and check it in `/api/epic/callback`.
- [ ] **Account deletion.** Nothing calls `shredUserKeys` or deletes a user. The foreign keys cascade from `user`, so a delete-account action (and deleting the data key first) is most of it.
- [ ] **`npm audit`:** 4 moderate advisories via `drizzle-kit`'s old esbuild. Dev-only, affects a local dev server. Clear when drizzle-kit updates.
