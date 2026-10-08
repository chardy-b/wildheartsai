# Deploying web-owned health chat

This replaces the October 4 direct-database VPS deployment. Chat stays disabled until the acceptance steps below pass. No production credentials or health data belong in this document, logs, command arguments, images, or Git.

## Boundary and configuration

| Host | Configuration | Purpose |
| --- | --- | --- |
| Web backend | `CHAT_ENABLED=0` initially | Gates browser and worker APIs; set `1` for acceptance after setup |
| Web backend | `CHAT_DATABASE_URL`, `CHAT_QUEUE_DATABASE_URL` | Existing restricted Neon data and metadata roles |
| Web backend | Existing `RECORDS_ENCRYPTION_KEY` | Unwraps per-user data keys and seals chat content |
| Web backend | `CHAT_GRANT_DERIVATION_KEY` | At least 32 random bytes, canonical base64url; derives opaque, run-bound grants |
| Web backend | `CHAT_INFERENCE_MODEL` | Allowed model alias; match the VPS configuration |
| VPS coordinator | `CHAT_WEB_API_URL` and `CHAT_COORDINATOR_TOKEN` | Claims authenticated users' queued jobs through named APIs |
| VPS | Iggy endpoint/control token and inference endpoint/key/model | Starts isolated workers and relays inference |

The VPS has no Postgres accounts, record encryption keys, Epic tokens, browser signer, or run-grant minting key. Give its Bitwarden machine account access only to VPS configuration in a separate project. The trusted web deploy account can read web secrets. Inject values from Bitwarden in the deploy environment or protected files; never echo them or pass them as command arguments.

The browser calls `/api/chat/v1` on the same origin with its Better Auth session cookie. The VPS coordinator calls `/api/chat/worker/v1` outbound over HTTPS. There is no public VPS chat API, separate browser token, external API origin, or browser-to-VPS connection.

## Deployment order

1. Review and merge the additive code/schema change while `CHAT_ENABLED` remains `0`. The Vercel build applies migration `0009_web_owned_chat.sql` before serving new code. Existing non-chat functionality keeps serving. A failed migration fails the new build.
2. With a trusted operator connection to the **production** Neon branch, apply `scripts/upgrade-chat-roles.sql` for the already existing roles. It is repeatable and does not change passwords. For a new test database only, use `scripts/provision-chat-roles.sql` instead. Do not send an owner connection to the VPS.
3. Create a random coordinator credential in the secret manager. Inject it as `CHAT_COORDINATOR_CREDENTIAL` and the operator connection as `DATABASE_URL_UNPOOLED`, then run `npm run chat:coordinator` on the trusted deploy machine. Only its SHA-256 verifier is stored. Supply that same credential to the VPS coordinator as `CHAT_COORDINATOR_TOKEN`; the relay and workers do not receive it. The script prints the non-patient coordinator ID for later revocation and never prints the credential. It does not load `.env.local` or guess a database.
4. Put the restricted role URLs, existing record key, new grant key, and model alias in the web backend's **Production** server environment. Configure preview branches separately. Register the new `reap-chat-runs` minute job with the existing Inngest deployment. It interrupts expired begun work independently of VPS health; it never reruns a question.
5. Deploy the coordinator, private relay, Iggy, and worker image using `services/chat/README.md` and its Compose configuration. Use a durable private inference endpoint reachable from the VPS, such as a fixed Tailscale hostname; a developer SSH tunnel is not a production dependency. Configure the matching model alias. Iggy controls Docker and is a trusted host component; its control endpoint/socket must stay private.
6. Remove obsolete direct-DB and signer settings from the VPS's old runtime file. Inventory variable **names only** before editing `/opt/wildhearts-chat-prod/runtime.env`; do not print existing values. If database/encryption credentials were previously placed there, remove them deliberately and assess exposure. Changing the record encryption key requires a data/key migration; do not blindly rotate it.
7. Set `CHAT_ENABLED=1` on the acceptance deployment and redeploy. API runtime initialization verifies the restricted roles, RLS policies, and fixed metadata-only session-lock function; unsafe configuration fails closed. Test with two synthetic accounts before enabling real health-data use.

## Acceptance

- A question persists immediately; closing the tab lets the active session's worker finish, and reopening shows its answer and ordered tool trace.
- User A cannot read, cancel, delete, or cite user B's conversation, run, records, notes, summaries, or evidence. Injected identity fields and arbitrary tool/SQL/HTTP operations fail.
- Logout or expiry revokes subsequent context, tool, summary, event, and completion access. Cancelling stops subsequent protected access. Already disclosed plaintext cannot be recalled.
- A stopped worker/coordinator becomes interrupted after lease expiry. Retry is an explicit new user submission. Claims and exact event retries do not create duplicate turns or tool writes.
- Summaries require records or notes actually read in the same run and remain unavailable to future conversations until that run completes. Changed/deleted evidence makes them stale. Persistent content and tool trace payloads are encrypted with the owner's key.
- Inspect images and Compose for absence of database, encryption, and grant-minting secrets. Repeat real Docker isolation checks, verify generic logs/errors, and confirm Matrix/Element stays healthy on the shared test VPS.
- Run app lint, typecheck, tests and build, service tests/typecheck/build, and an independent Sol review before committing delivery changes.

## Revocation, rollback, and portability

To stop new and existing API access quickly, set `CHAT_ENABLED=0` and redeploy the web backend; stop the coordinator while doing so. To replace a compromised coordinator, inject a **new** credential plus its prior ID as `CHAT_COORDINATOR_REPLACE_ID` and run `npm run chat:coordinator`; the transaction disables the old credential and interrupts its active jobs. Deploy the new credential to the coordinator. Disabled credentials cannot be re-enabled by this script.

Rotating `CHAT_GRANT_DERIVATION_KEY` invalidates existing grants. Interrupt those jobs and allow users to retry after configuration is consistent. Keep the additive migration on rollback; do not drop history or rename columns while older code is serving.

Short HTTPS requests and persistent state avoid depending on Vercel for long model runs. The web application and API can move to another Node host with the same database, auth configuration, secrets, and background reaper; VPS workers require only the new fixed web origin. Polling and tool requests still consume web-host resources, so measure usage and latency before promising a free operating tier.

A compromised VPS can observe context for jobs it legitimately claims until revoked. The web backend and inference host remain sensitive trust boundaries. This design and review do not certify HIPAA compliance, Epic production approval, or clinical accuracy.
