<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Wild Hearts AI delivery rules

- Treat health data, OAuth credentials, authorization codes, access tokens, refresh tokens, and patient identifiers as sensitive. Never commit, log, or expose them to client-side code.
- Keep Epic/FHIR secrets server-only. Use encrypted, short-lived storage and least-privilege SMART scopes when authentication is implemented.
- Do not claim HIPAA compliance, Epic production approval, or clinical accuracy without documented evidence.
- Run `npm run lint`, `npm run typecheck`, and `npm run build` before delivery.
- Keep the unauthenticated `/api/health` endpoint free of secrets and dependencies.
