# Cutover runbook: Vercel and Neon → Cloudflare

Phase 7 of `2026-10-30-cloudflare-migration.md`. This is the step-by-step version of its "Data migration" and "Cutover" sections. Steps marked **(owner)** need the owner's accounts (Cloudflare, Vercel, Neon, Epic, the DNS zone, the VPS). Everything else is commands from the repository root on an operator machine.

The rule throughout: **only Vercel and Neon take production writes until the DNS swap.** The copy runs while Vercel is read-only, so nothing written on Vercel is left behind.

## What's ready (November 20, 2026)

- **The copy tool.** `api/scripts/copy-to-d1.ts` has three commands (targets `local`, `rehearsal`, `preview`, `production`): `export` (Postgres → chunked SQL plus a manifest of row counts and checksums), `import` (into D1 through `wrangler d1 execute`, refusing a database that already has users) and `verify` (row counts, checksums per table, and a sample of people's data keys, records and Epic tokens opened with the Workers' keys, logging counts only).
- **Read-only mode on Vercel.** `MAINTENANCE_READ_ONLY=1` pauses every change, with a notice on every page; viewing and sign-in still work (`src/lib/read-only.ts`, enforced in `src/proxy.ts` and inside the server actions).
- **A local rehearsal passed.** The seeded local Postgres was exported, imported into a fresh local D1 and verified (19 tables, the decrypt sample, one deliberately altered row caught). Signing in on the local Cloudflare stack showed the copied account's connections and records, including an amended lab.

Not ready, and blocking the cutover:

- **Email provider (owner).** Production on Cloudflare sends no email until one is chosen (verification and password reset links). See "Open questions" in the migration plan.
- **Read-only mode has to be in production first.** It's on this branch; it must reach `main` and deploy to Vercel before the cutover day. A small pull request with just that change is the safe way (`src/lib/read-only.ts`, the proxy, the server actions, the root layout).

## 1. One-time setup (owner, any time before)

1. **Cloudflare account:** Workers Paid plan. Create the D1 databases `wildhearts-prod`, `wildhearts-preview`, `wildhearts-chat-prod` and `wildhearts-chat-preview`, and put their ids in `api/wrangler.jsonc` and `api/wrangler.chat.jsonc` (placeholders now).
2. **R2:** confirm the bucket names in `api/wrangler.jsonc` (`wildhearts-files-production`, `wildhearts-files-preview`) are the buckets Vercel uses today (`R2_BUCKET_NAME` per scope). Documents already live there, so nothing is copied.
3. **Secrets, production** (`npx wrangler secret put <NAME> --env production -c api/wrangler.jsonc`, from `api/`):
   - **Copy these from Vercel production exactly** (otherwise data won't open or sessions end): `BETTER_AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `RECORDS_ENCRYPTION_KEY`, `EPIC_PRIVATE_JWK` and `EPIC_PRODUCTION_PRIVATE_JWK` (plus the retiring public JWKs, if set), `EPIC_CLIENT_ID`, `EPIC_PRODUCTION_CLIENT_ID`, `METRIPORT_API_KEY`, `EXTRACTION_GRANT_KEY`, `EXTRACTION_COORDINATOR_TOKEN_HASH`.
   - **Set on Cloudflare** (as vars or secrets): `BETTER_AUTH_URL=https://www.wildheartsai.com`, `EPIC_REDIRECT_URI=https://www.wildheartsai.com/api/epic/callback`, `EPIC_ENVIRONMENT`, `EPIC_PRODUCTION_ACCESS_ENABLED`, `EPIC_EXPANDED_SCOPES`, `SIGNUPS_ENABLED`, `SIGNUP_INVITE_CODE`, `EMAIL_FROM`, `EXTRACTION_ENABLED`, `EXTRACTION_METHODS`, and the email provider's key.
   - **Chat Worker:** `CHAT_EDGE_TOKEN` (new; its SHA-256 goes on the VPS as `CHAT_EDGE_TOKEN_HASH`), and `CHAT_EDGE_URL` in `api/wrangler.chat.jsonc`'s production vars.
4. **Repeat step 3 for preview**, with preview values. Use preview's own keys: never production's.
5. **CI:** GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then the repository variable `CLOUDFLARE_PREVIEW_DEPLOY=true`.
6. **DNS:** move the `wildheartsai.com` zone's nameservers to Cloudflare, keeping every record pointing at Vercel and set to DNS-only (not proxied). Nothing changes for visitors.
7. **Epic:** add the staging callback (`https://<staging host>/api/epic/callback`) to the **sandbox** client only.
8. **VPS:** run the edge service (`CHAT_SERVICE_MODE=edge`, see `services/chat/README.md`), reachable by the chat Worker through a Cloudflare Tunnel or an HTTPS address. The extraction workers keep their URL (`/api/extraction/worker/v1/*` on the same origin).

## 2. Staging (weeks before; both stacks running)

1. Deploy production's Workers without a custom domain: `npx wrangler deploy --env production` in `api/` (then with `-c wrangler.chat.jsonc`), and `npm run cf:build && npx wrangler deploy --env production` at the root. Before any data is copied, their D1 databases are empty.
2. Run the walkthrough against the staging host. Point `BASE` in `scripts/qa-cloudflare-walkthrough.mjs` at it; the sign-up step needs the email provider, or `EMAIL_LOG_LINKS` on preview.
3. **Rehearse the copy twice, timing each run.** Read from a **Neon branch** of production (Neon console → Branches → create from `main`), so production isn't touched. Write into a **rehearsal D1 database** that no Worker serves (the `rehearsal` environment in `api/wrangler.jsonc`), never into preview, which every branch deploys to:

   ```bash
   (cd api && npx wrangler d1 create wildhearts-rehearsal)   # put its id in api/wrangler.jsonc, env "rehearsal"
   (cd api && npx wrangler d1 migrations apply DB --env rehearsal --remote)
   DATABASE_URL_UNPOOLED=<the Neon branch's direct URL> npx tsx api/scripts/copy-to-d1.ts export --out ~/wildhearts-copy
   npx tsx api/scripts/copy-to-d1.ts import --dir ~/wildhearts-copy --target rehearsal
   RECORDS_ENCRYPTION_KEY=… TOKEN_ENCRYPTION_KEY=… npx tsx api/scripts/copy-to-d1.ts verify --dir ~/wildhearts-copy --target rehearsal
   rm -rf ~/wildhearts-copy
   (cd api && npx wrangler d1 delete wildhearts-rehearsal)
   ```

   The keys for `verify` are production's (from your password manager), so the decrypt sample proves the copied data opens with them.
4. Record the export, import and verify times here. The read-only window is about as long as all three.
5. Delete the Neon branch and the rehearsal database (the last command above).

## 3. The day before

- Lower the TTL of `www` and the apex record to 60 seconds.
- Announce a short maintenance window (viewing keeps working).
- Confirm read-only mode is deployed on Vercel (it's off; the code just has to be there).

## 4. The cutover

Times assume the rehearsal's sizes; adjust to what step 2.4 recorded.

1. **Read-only on.** Vercel → Project → Settings → Environment Variables → Production: `MAINTENANCE_READ_ONLY=1`, then redeploy production (`npx vercel@latest redeploy <production deployment url>`, or **Redeploy** in the dashboard). Check that the notice shows on the site and that an upload or Refresh is refused.
2. **Pause Inngest (owner).** Pause the app's functions in the Inngest dashboard (read-only mode also refuses `/api/inngest`, so scheduled runs fail rather than write).
3. **Export production:**

   ```bash
   DATABASE_URL_UNPOOLED=<production's direct URL> npx tsx api/scripts/copy-to-d1.ts export --out ~/wildhearts-copy
   ```

4. **Migrate and import:**

   ```bash
   (cd api && npx wrangler d1 migrations apply DB --env production --remote && npx wrangler d1 migrations apply CHAT_DB --env production --remote --config wrangler.chat.jsonc)
   npx tsx api/scripts/copy-to-d1.ts import --dir ~/wildhearts-copy --target production
   ```

5. **Verify,** with production's keys (from your password manager, not from shell history):

   ```bash
   RECORDS_ENCRYPTION_KEY=… TOKEN_ENCRYPTION_KEY=… npx tsx api/scripts/copy-to-d1.ts verify --dir ~/wildhearts-copy --target production
   ```

   Every table must read `ok`, and the decrypt sample must open every key, record and token it tries. If anything fails, **stop**: leave DNS on Vercel, turn read-only off, and investigate.
6. **Delete the export:** `rm -rf ~/wildhearts-copy`.
7. **Rebuild the Epic directory:** `(cd api && npx wrangler workflows trigger wildhearts-directory-production)`. Search uses Epic's live endpoint list until it finishes.
8. **Smoke-test the staging host** against the copied data: sign in, open a records page, download a document, open Connections, start the sandbox Connect.
9. **Swap DNS (owner).** In Cloudflare, add `www.wildheartsai.com` (and the apex) as custom domains of `wildhearts-web-production`; this replaces the records pointing at Vercel. Requests still reaching Vercel during propagation see read-only mode, not stale writes.
10. **Production checks** on `https://www.wildheartsai.com`:
    - `/api/health`, sign-in, a records page, a document download, the sandbox Connect;
    - the crons registered (`npx wrangler triggers` / the dashboard);
    - the extraction workers and the chat edge service reaching the new stack;
    - no errors in Workers Logs (`npx wrangler tail wildhearts-api-production`).
11. **Chat:** set `CHAT_ENABLED=1` in the chat Worker's and web Worker's production vars and deploy both, once the edge service on the VPS answers.
12. **Neon read-only (owner):** stop writes to the production branch (revoke the app role's write privileges, or protect the branch). Keep it, and the Vercel project, for 30 days.

## 5. Rollback

- **Before step 9:** nothing has changed for users. Turn read-only off on Vercel (unset `MAINTENANCE_READ_ONLY`, redeploy) and unpause Inngest.
- **After step 9, before real writes on Cloudflare:** remove the custom domains, which restores the records pointing at Vercel. Then turn read-only off.
- **After people have written on Cloudflare:** going back needs a reverse copy, which doesn't exist. Fix forward, unless something is unsafe.

## 6. After (Phase 8)

Delete the Neon database and the Vercel project after 30 days. Remove Inngest, `pg`, the AWS SDK and nodemailer; retire the VPS coordinator, gateway and Iggy workers; move the Next app to `web/`; rewrite `AGENTS.md` and the delivery skill for Cloudflare.
