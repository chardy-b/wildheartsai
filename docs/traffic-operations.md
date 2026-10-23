# Website traffic operations

## Authentication labels

Server page-render GETs emit a `page_request` JSON event with `authState` set to `authenticated`, `anonymous`, or `unknown`. Authentication is verified through the existing cached server session lookup; a cookie alone does not establish authentication. Missing cookies skip the session lookup. Session-check failures produce `unknown` without logging the exception or breaking public pages. The proxy also logs anonymous redirects away from `/app`.

Each entry contains only the event name, authentication state, allowlisted route template, and render/redirect outcome. Document IDs, record categories, query strings, cookies, account details and record contents are excluded. Caller-supplied route headers are replaced by the proxy. This adds no database table, migration or environment variable.

These are server render requests, not unique people, a complete pageview count, or a patient access audit. Client-side cached navigation may not render the root layout; prefetches and retries can render it. APIs and workers are outside this page logger. Inspect their separate endpoint request records and existing chat failure logs rather than interpreting worker polling as user activity. State labels are not attached to client analytics and do not retroactively classify existing traffic.

Filter Vercel runtime logs by `page_request` and the JSON field `authState`. With the CLI, use message search (the JSON field is inside the log message, not a native request-log filter):

```powershell
npx vercel@latest --scope lichards-projects logs runtime --project wildheartsai --environment production --since 1h --query '"page_request" AND "authenticated"'
npx vercel@latest --scope lichards-projects logs runtime --project wildheartsai --environment production --since 1h --query '"page_request" AND "anonymous"'
```

Vercel Analytics continues to provide aggregate referrals, countries and devices. Its page URLs now replace document IDs and record categories with route templates and discard query strings, fragments and unknown paths. Existing historical analytics are unaffected. The privacy page describes both analytics and the separate operational entries.

## Credential-file probes

The reviewed log-mode custom rule is stored in `ops/firewall/credential-file-probes.json`. It matches only root `.env` files and variants, `.git`, `.aws`, and `.config/gcloud`. It cannot match `/api/epic/*`, `/api/chat/*`, `/api/extraction/*`, `/api/auth/*`, `/api/inngest`, or `/api/health`. Regression tests cover the observed probes and these exclusions. No broad IP, country, browser, Node, curl, or fingerprint block is used.

On October 23, 2026, this was staged for project `wildheartsai`, team `lichards-projects`, as `rule_credential_file_probes_9gVetq`. Staging is not publication. The operator must review the draft before publishing log mode:

```powershell
npx vercel@latest --scope lichards-projects firewall diff --project wildheartsai
npx vercel@latest --scope lichards-projects firewall publish --project wildheartsai --yes
```

Review matches at https://vercel.com/lichards-projects/wildheartsai/firewall/traffic?filter=rule_credential_file_probes_9gVetq. After confirming the scope using production log matches, test denial on a preview first, keeping a separate production log rule while doing so. Only then promote the narrowly scoped deny action to production. Each publication is an operator step. Keep automatic DDoS mitigation enabled throughout. Disabling the custom rule rolls back this additional protection without changing system mitigations.

## Trinity Health challenge diagnosis

The October 22 traffic investigation found 48 challenges for `170.232.224.10` (ASN 21833, Trinity Health Corporation), clustered around 13:00–15:00 America/Los_Angeles. The mitigation was `sys_dos_mitigation`, with `Epic-Interconnect/117.0.476.1253` in the sampled challenged traffic and public Epic signing-key paths in the path breakdown. Requests before and after this episode were allowed. Bot Protection was off, Attack Mode was off, and there were no custom rules at the time.

This is consistent with a system-level false positive affecting an Epic integration. Vercel does not expose the detector's exact trigger in the available data, so a specific fingerprint collision or causal link to the nearby credential scan is not proven. Firewall breakdowns are sampled and may differ from the summary totals.

A custom WAF bypass cannot override system DDoS mitigation. System Bypass is available only on Pro/Enterprise and is unavailable on this Hobby team. Do not pause DDoS protection or broadly allow Epic user-agent strings. If it recurs, capture the time window, public network IP, static signing-key route and `sys_dos_mitigation` label for Vercel support. An IP-scoped System Bypass would require an approved plan change and independent confirmation of the health system's source address. No plan purchase or bypass was performed.

Official references: https://vercel.com/docs/vercel-firewall/ddos-mitigation and https://vercel.com/docs/vercel-firewall/vercel-waf/system-bypass-rules.

## Coordinator rollout

The durable work queue remains in Neon. After a successful submission commits, Vercel sends an empty, separately authenticated wake hint to a dedicated VPS endpoint. Notification delivery is bounded and best-effort; startup claims, queue draining after work, and a five-minute recovery check cover coalesced or missed hints. Fully idle notification mode makes about 288 recovery claims/day instead of approximately 4,320. A ten-second claim cooldown prevents notification bursts from exceeding the API limit. Active heartbeats stay at five seconds. The wake credential grants no job, user, record or database access.

Build and restart only `chat-coordinator` while idle, using the optional loopback-only wake Compose override behind a TLS reverse proxy. Configure paired `CHAT_WAKE_URL`/`CHAT_WAKE_SECRET` on Vercel and the distinct Secret on the coordinator, separately for production and preview. Follow the staged rollout and rollback in `services/chat/README.md`. Without wake configuration the coordinator retains its original 10–30 second polling behavior; this avoids silently delaying work before ingress is ready. No new schema or queue service is required.

Verify successful claims, an idle rate near 12/hour, prompt synthetic chat pickup after an idle period, and recovery within five minutes when notification delivery is deliberately interrupted in a synthetic environment. Startup reports `chat_coordinator_started` with mode `notifications` or `polling`. Fixed `chat_wake_failed` codes are `invalid_config`, `scheduling_failed` and `delivery_failed`; notification failures do not fail an already committed submission. No credentials, destinations, health content or identifiers belong in these entries, rollout logs or command arguments. Web deployment alone does not update the VPS.
