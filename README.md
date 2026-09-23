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

## Deployment

Import the GitHub repository into Vercel using the native GitHub integration, select Next.js, and use `main` as the production branch. No Vercel deployment workflow or durable Vercel token is required in GitHub.
