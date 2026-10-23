# Wild Hearts AI

A Vercel-ready web application intended to help patients connect to Epic health records through SMART on FHIR OAuth.

> **Status:** foundation only. No Epic connection, patient authentication, or health-data storage is implemented yet. This software is not medical advice and makes no compliance claim.

## Landing page

The public page at `/` follows the Nightlight creative direction in [`docs/creative-direction.md`](docs/creative-direction.md): palette, typography, motifs, motion and the claims the page may and may not make. Components live in `src/components/landing/`.

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- Vercel deployment target

## Local development

Requires a Node.js version supported by the pinned Next.js release.

```bash
npm ci
npm run dev
```

Open <http://localhost:3000>. The unauthenticated health check is at <http://localhost:3000/api/health>.

## Validation

```bash
npm run lint
npm run typecheck
npm run build
npm start
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

Copy `.env.example` to `.env.local` for local placeholders. Never commit real credentials or tokens. Keep all Epic credentials server-only; do not prefix them with `NEXT_PUBLIC_`.

Vercel should hold preview and production values separately after the GitHub project is imported.

## Documents file storage

Documents at `/app/wildcards` accepts multiple PDFs, UTF-8 text files, PNGs, JPEGs, GIFs, and WebP images, through file selection, folder selection, or drag-and-drop. Folder uploads preserve relative paths, including the selected root and nested folders, in the existing encrypted metadata; no schema migration is needed. Paths are validated (up to 1,024 characters and 32 levels), never used as object keys, and retained through upload completion, listing, and reading for future parsing/indexing. Existing uploads remain at the top level. The folder view expands/collapses folders; the list view shows full paths and newest uploads first. Same-name files and repeated paths remain separate uploads identified by file ID, and uploads sharing a folder path appear together. Folders are inferred from files: empty folders are not retained, and deleting a folder's final file removes it from the tree. Unsupported files receive individual errors while supported files continue uploading. Each file is limited to 2 GB (2,147,483,648 bytes); each person can store up to 50 GB or 50,000 files. Uploads use 3 MB pieces. Files above 25 MB retain individually encrypted pieces with a sealed manifest and stream on download; smaller files and existing uploads keep their single-object format. The UI lists original names, detected types, server upload timestamps (UTC), and sizes, with authenticated viewing, original download, and deletion. PDFs render page by page in the app; embedded PDF scripts, forms, and links are not executed. Parsing and indexing are not implemented yet.

Create a **private Cloudflare R2 Standard** bucket for production, and a separate bucket for preview/development. Keep public access (`r2.dev` and custom domains) disabled. Browser uploads and downloads go through the authenticated app, so the bucket needs no browser CORS policy. Create an R2 S3 API credential with **Object Read & Write** permission scoped only to the appropriate bucket. Store its values in Vercel's server environment (and `.env.local` for local development): `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Never use `NEXT_PUBLIC_` variables or paste credentials into chat. All four settings must be provided together; leaving all four unset disables new uploads without affecting the rest of the app.

Apply migration `0011_wildcard_files` locally with `npm run db:migrate`; Vercel runs it during deployment. Neon stores ownership, size, status, timestamp, opaque object key, and encrypted filename/type metadata. R2 stores only AES-256-GCM ciphertext, bound to the owner's data key and file ID. No public or signed file URLs are generated, and R2 credentials remain server-only. The compact envelope adds 29 bytes per original file. Preserve the existing `RECORDS_ENCRYPTION_KEY` and database user keys: losing either makes stored files unreadable.

Pending uploads reserve quota before the network request; only ready files can be viewed or downloaded. Migration `0012_document_upload_parts` adds nullable upload tracking fields without changing existing files. The browser sends pieces of up to 3 MB; the server encrypts each piece in R2, validates and assembles the original on completion, then removes temporary pieces. Piece retries do not create duplicate files. Upload sessions expire after one hour; incomplete uploads remain deletable. Downloads stream through the authenticated API to avoid buffered hosting limits, and decryption authenticates the whole file before any plaintext is released. The UI reports progress and separate errors for empty files, actual size versus the limit, unsupported formats, session expiry, account quota, and connection failures.

Failed upload cleanup and failed deletion remain visible for the owner to retry. R2 operations run outside database transactions. If account deletion is added in the future, include R2 object cleanup alongside database cascades; deleting database rows alone does not delete objects in R2. No real-user uploads should be used for QA; storage isolation, encryption, failure recovery, and API tests use in-memory objects and made-up data.

## Metriport sandbox

Set the optional, server-only `METRIPORT_API_KEY` to a Metriport sandbox key to show five sample patients on Connections. Leave it unset to hide the option. Apply migration `0010_metriport_connection` with `npm run db:migrate` locally; Vercel applies it during the build. Record imports also need the existing Inngest configuration (locally, `INNGEST_DEV=1` and the Inngest dev server).

Import a sample patient to add structured records and note summaries to the dashboard. Refresh starts another retrieval; disconnect keeps stored records unless you choose to delete them. Reconnecting reuses the upstream sample patient and the local source. Full note text and document files are not imported. The API address is fixed to Metriport's sandbox and redirects are rejected; this does not enable real-patient HIE access.

The replay tests use Metriport's published Jane sample bundle and require no API key: `npm test -- src/lib/metriport`. Client API responses and credentials must never be logged or committed.

## Optional offline research snapshot

The chat gateway can search a curated Markdown snapshot of the private health-research wiki. The gateway reads only a fixed, read-only published directory; the worker receives neither the mounted corpus nor the research credential. The publisher runs as a separate Docker target with networking disabled, a read-only raw-repository mount, and one dedicated writable publication parent. It copies only the approved Markdown directories and `index.md`, builds a SHA-256 manifest, then asks the same corpus engine used by the gateway to validate every selected file and reject invalid frontmatter or duplicate record IDs. PDF, binary, raw, prompt, operational, and Git metadata are excluded.

On the VPS, keep the private source checkout and publication parent in separate directories. Prepare the publication parent for the publisher container's unprivileged UID. Keep the existing protected chat-service environment in `services/chat/.env`, then create a second protected, untracked file such as `services/chat/.env.research` with these research-only values:

```dotenv
CHAT_RESEARCH_SOURCE_PATH=/srv/private/health-research-wiki
CHAT_RESEARCH_CORPUS_HOST_PATH=/srv/wildhearts/health-research-published
CHAT_RESEARCH_GATEWAY_TOKEN=<43-character-base64url-secret>
```

Set `CHAT_RESEARCH_GATEWAY_TOKEN_HASH` in the web app's server environment to the lowercase SHA-256 hex digest of the exact raw token. The raw token is passed only to the chat gateway and only on the two research authority routes. Never put it in the coordinator, worker, publisher, browser, or a committed environment file.

Build and publish from the repository root:

```bash
install -d -m 0700 -o 1000 -g 1000 /srv/wildhearts/health-research-published
docker compose --env-file services/chat/.env --env-file services/chat/.env.research -f services/chat/docker-compose.yml -f services/chat/docker-compose.research.yml build chat-gateway research-publisher
docker compose --env-file services/chat/.env --env-file services/chat/.env.research -f services/chat/docker-compose.yml -f services/chat/docker-compose.research.yml run --rm --no-deps research-publisher
docker compose --env-file services/chat/.env --env-file services/chat/.env.research -f services/chat/docker-compose.yml -f services/chat/docker-compose.research.yml up -d chat-gateway
```

To refresh the snapshot, update the private checkout on the VPS with the operator's configured Git access, then run the publisher command again. The publisher validates a staged copy before replacing `current`; it briefly renames the old directory aside before placing the new one, and rolls back if the replacement fails. During that short gap, new capture attempts fail closed. A running gateway retains already loaded immutable snapshots in memory; after a gateway restart, a run pinned to a snapshot that is no longer available receives `snapshot_unavailable` instead of silently switching versions. The publisher retains only two prior snapshots it created. The base `docker-compose.yml` does not mount a corpus, so research remains disabled unless the research override and both credentials are configured.

## Deployment

Import the GitHub repository into Vercel using the native GitHub integration, select Next.js, and use `main` as the production branch. No Vercel deployment workflow or durable Vercel token is required in GitHub.

### Background sync diagnostics

In Inngest's **Production** environment, the `wild-hearts-health` app must be synced to the production `/api/inngest` URL. Check that `refresh-sources` is active with cron `17 10 * * *` (10:17 UTC daily). A deployed function definition alone does not establish that its cloud schedule is registered or enabled.

The **Register production Inngest functions** GitHub workflow resyncs `https://www.wildheartsai.com/api/inngest` after Vercel reports a successful **Production** deployment. It avoids the native integration's protected deployment alias without changing deployment protection. The SDK signs the outgoing registration using the existing server-side Inngest key; GitHub receives no Inngest credentials. The workflow retries three times, validates the registration response, and fails visibly if it cannot register. Preview and failed deployments are ignored. To retry registration without deploying, run this workflow manually on `main` in GitHub Actions. Registration updates function definitions; it does not itself trigger a records refresh.

`background_job_run` retains a heartbeat for each nightly refresh: start/end times, running/ok/partial/failed status, and counts of due, queued, skipped and failed sources. It contains no user/source identifiers or medical data. After a deployment, invoke `refresh-sources` once in Inngest and verify its completed heartbeat. A latest start older than 26 hours means the daily schedule needs investigation; a running row older than 3 hours or a failed/partial result needs investigation too. Keep `/api/health` independent of this check.

Connection audit events and sync query stats retain `failureStage`, `failureCode` and, where available, `httpStatus`. `refresh_rejected` and `missing_refresh_token` require renewed user authorization. `missing_credentials`, `invalid_client_configuration`, `invalid_client`, network errors and individual FHIR resource failures are app/service failures: they keep the connection eligible for later background refresh. Never copy token responses, exception messages, URLs or patient identifiers into these diagnostics.
