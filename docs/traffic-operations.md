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

The coordinator's reduced idle polling is separate from the Vercel web deployment. Build and restart only `chat-coordinator` from the reviewed source on the VPS after confirming no run is active. Keep the gateway and worker image unchanged. The default idle interval grows to 30–60 seconds, averaging about 1,920 claims/day; it resets to 10 seconds after work. Active heartbeats stay at five seconds. A newly queued chat can wait up to a minute after sustained inactivity.

After restarting, verify successful `POST /api/chat/worker/v1/claims` responses, an idle rate near 80/hour, and pickup of a synthetic queued chat. No coordinator credentials belong in the rollout log or command arguments.
