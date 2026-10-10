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
