# Chat about your records: implementation plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking. Each stage ends with a shippable PR. Later stages get more task detail when they start.

**Goal:** signed-in people can hold many chats about their own records, answered by a pi agent on our VPS running a local model through llama-swap, with the agent reading data only through a per-person tools API on the Next.js app.

**Spec:** `docs/superpowers/specs/2026-09-29-records-chat-design.md` (decisions in §10).

## Global constraints

- **The agent service never gets database credentials or encryption keys.** All data goes through the tools API, running `asUser(db, userId, …)`.
- **Chat titles, message content and tool results are sealed** with the person's data key (`sealField`) before they reach Postgres.
- **Logs, audit detail and stream events never hold health data,** message text, tokens or patient identifiers: only ids, counts, tool names and error codes.
- **Tokens travel in `Authorization` headers,** never in URLs.
- **Chat is off unless `AGENT_TOKEN_PRIVATE_JWK`, `AGENT_SERVICE_SECRET` and `AGENT_URL` are all set.** Keep it off in Preview scope.
- **No HIPAA, clinical-accuracy or medical-advice claims.**
- **Before each PR:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. From stage 3, also the agent's own `npm test` and `npm run build` in `agent/`.

## Stages

| # | Stage | Ships |
| --- | --- | --- |
| 0 | Infrastructure prep (by hand, no PR) | Tailscale on the VPS, tailnet ACL, llama-swap API key and logging off, Funnel allowed for the VPS, a model chosen and its tool calling checked |
| 1 | Chat storage | `chat`, `chat_message` tables, migration with RLS, sealed read and write helpers. No behaviour change. |
| 2 | Tokens and tools API | Env vars, key script, `/api/agent/token`, `/api/agent/jwks`, service-secret check, chat and tool endpoints, audit action. Still no UI. |
| 3 | Agent service | `agent/` package: core, Node adapter, SSE, pi tools, context trimming, queue, tests with pi's faux provider, local dev |
| 4 | Chat UI | Chat list and chat pages, streaming client, safe Markdown, cancel, CSP, feature flag. Works end to end locally. |
| 5 | VPS deploy and consent | systemd unit, Tailscale Funnel, env files, smoke test, privacy and consent copy, `CONSENT_VERSION` bump. Turned on in production. |
| 6 | Hardening and quality | Rate limits, re-attach, evaluations on sandbox recordings, deploy automation, better search |

---

## Stage 0: infrastructure prep (by hand)

- [ ] **VPS:** Tailscale is already installed; tag the machine (e.g. `tag:agent`). Create a system user `wildhearts-agent` with no login shell. Install Node 22 LTS.
- [ ] **Tailnet ACL:** allow `tag:agent` to reach only the GPU machine's llama-swap port. Nothing else, and nothing the other way.
- [ ] **GPU machine:**
  - bind llama-swap to the tailnet interface;
  - turn on its API key check if the installed version supports it; if it doesn't, put a small proxy in front that checks one;
  - make sure neither llama-swap nor llama-server logs prompts or responses.
- [ ] **Model:** pick one, then check by hand with `curl` against `/v1/chat/completions` that it:
  - calls a simple tool correctly;
  - streams;
  - fits the context size we plan for.

  Write down its id, context window and any `compat` quirks.
- [ ] **Funnel:** in the tailnet policy, grant the `funnel` node attribute to the VPS only. Note the VPS's `ts.net` name; it becomes `AGENT_URL`. Don't turn Funnel on until stage 5.
- [ ] Record the outcomes (model id, context window, ports; no secrets) in the stage 3 PR description.

## Stage 1: chat storage

### Files

| File | Responsibility |
| --- | --- |
| `src/lib/db/chat-schema.ts` | `chat`, `chat_message` as in spec §3, exported from `schema.ts` |
| `drizzle/00xx_chat.sql` | Generated migration, plus hand-added `ENABLE`/`FORCE ROW LEVEL SECURITY` and `owner_only` policies copied from `0006_row_level_security.sql` |
| `src/lib/db/rls.ts` | Add `chat`, `chat_message` to `RLS_TABLES` |
| `src/lib/chats.ts` | `createChat`, `listChats`, `renameChat`, `deleteChat`, `loadMessages`, `appendMessages`, `setTitle`. All take a `tx` from `asUser` plus the person's keys. |

### Tasks

- [ ] Schema and migration (`npm run db:generate`, then add the RLS statements by hand). `npm run db:check-rls` stays clean.
- [ ] Sealing:
  - `sealed_title` at `{ table: "chat", field: "title", rowId: chat.id }`;
  - `sealed_content` at `{ table: "chat_message", field: "content", rowId: message.id }`.

  Message ids are generated before insert, so the location is known when sealing.
- [ ] `appendMessages(tx, keys, chatId, messages[{ seq, role, content, model?, usage? }])`:
  - inserts with `ON CONFLICT (chat_id, seq) DO NOTHING`;
  - rejects a first `seq` that isn't the current count;
  - bumps `chat.updated_at`.
- [ ] `listChats` returns id, title (unsealed, or null), updated_at, newest first. `loadMessages` returns messages in `seq` order.
- [ ] Tests (PGlite):
  - round trip of sealed content;
  - another user sees nothing, through RLS and through the helpers;
  - a duplicate `seq` is ignored, a gap is rejected;
  - deleting a chat deletes its messages, and deleting the user deletes everything;
  - a sealed message doesn't open under another row id.

## Stage 2: tokens and tools API

### Files

| File | Responsibility |
| --- | --- |
| `src/lib/env.ts`, `.env.example`, `src/test/setup.ts` | `AGENT_TOKEN_PRIVATE_JWK`, `AGENT_SERVICE_SECRET` (≥ 32 chars), `AGENT_URL`, all optional; `chatEnabled()` true only when all three are set |
| `scripts/generate-agent-key.mjs`, `package.json` | `npm run agent:key` prints a new Ed25519 JWK (private for the env, public for checking) |
| `src/lib/agent-api/token.ts` | `issueChatToken(userId, chatId)`, `verifyChatToken(token)` with `aud`, `iss`, `exp`, `chat` checks |
| `src/lib/agent-api/contract.ts` | zod schemas for every tools API request and response, shared with `agent/` |
| `src/lib/agent-api/guard.ts` | `withAgentAuth(handler)`: constant-time service-secret check, token check, loads the chat through `asUser` (404 if not theirs), passes `{ userId, chatId }` |
| `src/lib/agent-api/tools.ts` | `getProfile`, `listSourcesTool`, `searchRecords`, `getRecord`, `getNote`: output shaping and size caps (spec §4) |
| `src/app/api/agent/token/route.ts` | Session + onboarding + chat ownership → token |
| `src/app/api/agent/jwks/route.ts` | Public key set |
| `src/app/api/agent/chats/[id]/messages/route.ts`, `…/title/route.ts` | Load and append messages, set title |
| `src/app/api/agent/tools/[tool]/route.ts` | Dispatches to `tools.ts`, validating input with the contract |
| `src/lib/db/audit-schema.ts`, `src/lib/audit.ts` | Add `chat_turn` action; detail holds counts only |

### Tasks

- [ ] Env and key script. The env tests cover: all three set turns chat on; any one missing turns it off; a short secret is rejected.
- [ ] Token issue and check. Tests: wrong audience, wrong issuer, expired, missing `chat`, and a token for another chat are all rejected.
- [ ] `withAgentAuth`. Tests:
  - no secret → 401;
  - wrong secret → 401;
  - no token → 401;
  - another person's chat → 404;
  - every response carries `Cache-Control: no-store`.
- [ ] Tools, all read-only inside `asUser`:
  - `searchRecords` builds on `allMatching` and matches text in memory;
  - `getRecord` trims empty FHIR fields and caps size;
  - `getNote` pages stored note text;
  - each says when output was cut.
- [ ] Tool tests on the seeded or replay data (`src/test/epic-replay.ts`):
  - results only ever include the caller's records;
  - limits and truncation messages;
  - date and category filters;
  - unknown record id → 404, not another person's record.
- [ ] `POST /api/agent/token` records nothing. `chat_turn` audit events are written by the messages endpoint when the agent reports a finished turn.

## Stage 3: agent service

### Layout

```
agent/
  package.json          # pinned: @mariozechner/pi-agent-core, @mariozechner/pi-ai, jose, zod
  tsconfig.json
  src/core/turn.ts      # runTurn({ history, text, model, tools, emit, signal }) → new messages
  src/core/tools.ts     # pi AgentTool definitions → AppClient calls
  src/core/context.ts   # transformContext: trim to the window (spec §5.2)
  src/core/events.ts    # pi events → our stream events (no tool results)
  src/core/app-client.ts# interface + fetch implementation (token + service secret headers)
  src/node/server.ts    # HTTP routes, CORS, SSE, per-chat lock, GPU queue, config
  src/node/config.ts    # zod-checked env
  test/…                # Vitest
```

- [ ] Exclude `agent/` from the root `tsconfig.json` (`exclude`) so the app's typecheck doesn't need the agent's dependencies. The root Vitest config already only includes `src/**`.
- [ ] `core/turn.ts`:
  - builds a pi `Agent` with an `openai-completions` `Model` (`baseUrl`, `compat` from stage 0 notes, `getApiKey`);
  - system prompt from spec §6;
  - tools;
  - `transformContext`;
  - an 8-tool-call limit via `beforeToolCall`;
  - `abort()` on signal;
  - an 8-minute turn timeout.
- [ ] `node/server.ts`:
  - `POST /chats/:id/turns` (SSE), `POST /chats/:id/cancel`, `GET /healthz`;
  - listens on `127.0.0.1` only;
  - token checked with `createRemoteJWKSet(APP_URL/api/agent/jwks)`;
  - 409 when the chat is busy;
  - a semaphore of `MAX_CONCURRENT_TURNS` with `queued` events.
- [ ] Persistence order:
  1. append the person's message before calling the model;
  2. append assistant and tool-result messages at each pi `turn_end`;
  3. set the title after the first answer.
- [ ] Logging per spec §5.3 (hash ids with a per-process salt).
- [ ] Tests, with no network and no GPU, using pi-ai's faux provider and a fake `AppClient`:
  - a tool call reaches the app with both headers;
  - stream events are in order and contain no tool results;
  - cancel aborts and saves the partial answer;
  - a second turn on a busy chat → 409;
  - context trimming keeps the system prompt and the latest question;
  - a bad or expired token → 401 before any model call.
- [ ] `npm run agent:dev` (root script) runs the service locally against `APP_URL=http://localhost:3000`. `LLM_BASE_URL` is either the real llama-swap over the tailnet or a local OpenAI-compatible server.

## Stage 4: chat UI

- [ ] **Routes:**
  - `/app/chat`: list of chats, a New chat button, rename and delete;
  - `/app/chat/[id]`: history and composer.

  Server components load through `asUser`. Create, rename and delete are server actions. Add a nav entry, shown only when `chatEnabled()`.
- [ ] **Client:** before each send, get a token from `/api/agent/token`, then `fetch(AGENT_URL + /chats/:id/turns)` and read the SSE stream. Show `queued` position, streaming text, tool activity labels, a Stop button (cancel), and errors with a retry.
- [ ] **Safe Markdown renderer:** a small allowlist, no raw HTML, no images, only same-origin links clickable. Tests with injected `![](https://evil/?q=…)`, `<img>`, `<script>` and `javascript:` links.
- [ ] **CSP:** add `AGENT_URL` to `connect-src` when set (`src/lib/csp.ts`, with a test).
- [ ] **Disclaimer** on the chat page (spec §6).
- [ ] **End-to-end locally:** seeded account (`npm run db:seed`), agent in dev mode, a real or local model; ask "what were my last lab results?" and confirm the answer cites the seeded amended lab.

## Stage 5: VPS deploy and consent

- [ ] **Build:** `npm run build` in `agent/` produces one bundled `dist/server.js`, and `npm run agent:deploy` copies it and a lockfile-installed `node_modules` to the VPS. Deployment is by hand for now; automation is stage 6.
- [ ] **systemd unit** `wildhearts-agent.service`:
  - `User=wildhearts-agent`;
  - `EnvironmentFile=/etc/wildhearts-agent/env` (mode 600, root-owned);
  - `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`;
  - `MemoryMax=400M`, `Restart=on-failure`;
  - `ExecStart=node --max-old-space-size=256 dist/server.js`.
- [ ] **Funnel:** `tailscale funnel --bg <PORT>` (check flags with `tailscale funnel --help`). Confirm with `tailscale funnel status` that only this port is published, and that a 5-minute streamed answer arrives without being cut off.
- [ ] **Vercel, Production scope only:** set `AGENT_TOKEN_PRIVATE_JWK`, `AGENT_SERVICE_SECRET` and `AGENT_URL`.
- [ ] **Consent:** update the privacy page and consent text (spec §8) and bump `CONSENT_VERSION` in the same PR that turns chat on.
- [ ] **Smoke test on production** with the Epic sandbox account:
  - token issued;
  - turn streams;
  - messages stored sealed (check a row in Neon is ciphertext);
  - audit event written;
  - another account can't open the chat.
- [ ] **Check memory** on the VPS under a few concurrent turns: `systemctl status`, `free -h`.

## Stage 6: hardening and quality

- [ ] Per-person rate limits (20 turns an hour) in the agent, with a clear message.
- [ ] Re-attach: the agent keeps each running turn's events in a small buffer, and `GET /chats/:id/turns/current` replays and follows them.
- [ ] Evaluations: questions with known answers over the sandbox recordings. Run them against the real model on demand, not in CI. Record answer accuracy and tool-call counts.
- [ ] Tools: note text search; `lab_trend`.
- [ ] Deploy automation: a GitHub Action that builds `agent/` and deploys over SSH with a deploy key limited to the agent's directory, or a pull-based updater on the VPS.
- [ ] Revisit the Cloudflare Durable Object adapter if the VPS or GPU setup changes (spec §1.1).
