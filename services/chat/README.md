# Wild Hearts chat worker transport

This package runs the VPS coordinator and private Iggy gateway. The web application remains the authority for queued jobs, run context, cancellation, tool access, transcript events, and finalization. The VPS has no Postgres adapter, record-encryption key, browser ticket signer, or public chat API.

The coordinator sends an idempotent claim request to `CHAT_WEB_API_URL`, then gives Iggy the run's execution grant. It keeps the separate control grant in coordinator memory for heartbeat and finalization calls. User IDs and database scope never enter the coordinator or worker. Each retry reuses the original request ID and body so a lost response cannot claim a different run.

With wake ingress configured, Vercel sends an authenticated empty hint after a chat submission commits to Neon. The coordinator checks at startup, on a hint, and every five minutes to recover missed hints (about 288 checks per fully idle day). It drains queued jobs after completing work, even when hints coalesce, and preserves hints arriving while busy or in a claim cooldown. A ten-second minimum between claim starts and HTTP Retry-After cooldowns bound wake bursts below six claims/minute. Active-run heartbeats remain every five seconds; shutdown interrupts idle waits. Without wake configuration, the original 10–30 second polling remains for staged rollout and rollback. Deploying the web app alone does not update this loop: rebuild and restart only `chat-coordinator` when no chat is running.

The fixed gateway forwards worker context, cancellation, tool, and event requests to the web API. It accepts only an execution grant. Before forwarding inference it checks cancellation; while a stream is open it polls the web API every second and aborts if the run is cancelled or the authority cannot be reached. The inference URL and model come only from gateway configuration. Requests override model selection and cap `max_tokens`; upstream response bytes and request bodies are bounded. Prompts, answers, tokens, and provider errors are never written to logs.

## Configure

Provide the coordinator and gateway with separate environment sets. The coordinator needs `CHAT_WEB_API_URL`, `CHAT_COORDINATOR_TOKEN`, `CHAT_WORKER_ID`, `IGGY_URL`, and `IGGY_BEARER_TOKEN`. The gateway needs `CHAT_WEB_API_URL`, `CHAT_INFERENCE_URL`, and `CHAT_INFERENCE_MODEL`; optionally set `CHAT_INFERENCE_MAX_TOKENS`, `CHAT_INFERENCE_API_KEY`, `CHAT_INFERENCE_FALLBACK_MODELS`, and `CHAT_INFERENCE_ATTEMPT_TIMEOUT_MS`. Do not put coordinator credentials in the gateway environment or execution grants in coordinator configuration. The URL prefix is fixed to `/api/chat/worker/v1`; it is not accepted from request bodies.

Keep inference settings in the private gateway environment. The web app's configured primary model must match `CHAT_INFERENCE_MODEL`; callers cannot select models. `CHAT_INFERENCE_FALLBACK_MODELS` is an optional JSON array of up to three distinct model IDs, tried in order after eligible transient failures before the downstream response begins. No fallback runs after streaming starts or the request is cancelled. For example, the thinking primary `qwen3.8-27b-gsq-9070-thinking` can retain `qwen3.8-27b-q6k-112k-mtp-dual` as its backup. Fallbacks use the same fixed inference URL and API key, so prompts and requests remain within the configured private inference endpoint. `CHAT_INFERENCE_ATTEMPT_TIMEOUT_MS` defaults to 120000 and accepts values from 1000 through 120000; it limits waiting for response headers and the first upstream byte on each attempt. A single 240-second inference deadline covers cancellation checks, all fallback attempts, and the stream. The Pi worker allows 270 seconds so it can report a terminal event after a gateway timeout; the web run and Iggy limits must remain longer. The timeout is only returned by the gateway runtime when fallbacks are configured. Neither setting belongs in browser-visible or `NEXT_PUBLIC_*` configuration.

`CHAT_WEB_API_URL` should use HTTPS in deployed environments. HTTP is accepted only for loopback tests. Inference may use HTTP for a private model endpoint; credentials, query strings, and fragments are rejected in configured URLs. Keep all values in the deployment secret store or a restricted, uncommitted environment file.

## Build and run

Run from the repository root. Compose builds the coordinator and gateway. The worker image contains only the Pi entry point and runtime dependencies.

```sh
docker compose --env-file services/chat/.env -f services/chat/docker-compose.yml build
docker build -f services/chat/Dockerfile --target worker -t wildhearts-health-worker:local .
docker compose --env-file services/chat/.env -f services/chat/docker-compose.yml up -d
```

Neither service publishes a host port. Compose creates the fixed `wildhearts-chat-trusted` network for the coordinator and gateway. Attach the separately provisioned Iggy management container to that network, give it the DNS name `wildhearts-iggy`, and have it listen on port 8417 inside the network without publishing that port. Iggy attaches the fixed gateway container to each isolated worker network; each worker joins only its own network and receives only its execution grant and gateway URL. The coordinator does not join worker networks.

### Optional notification ingress

The base Compose file above publishes no ports. To enable wake notifications, add `docker-compose.wake.yml`. It publishes only the coordinator's wake listener on host loopback `127.0.0.1:8091`; Iggy, the worker and the gateway remain private. A VPS-host TLS reverse proxy must forward **only** the exact `/internal/chat/wake` path to that listener, preserving the Authorization header and rejecting other paths/methods. Do not forward a whole host to Iggy or the gateway. Keep normal network and request-size/rate protections on the proxy; never log Authorization headers.

Generate a new, separate `whwake1.` credential followed by 32 random bytes encoded as base64url (43 characters). Store it as `CHAT_WAKE_SECRET` in the coordinator's protected environment and in the matching Vercel environment as a Secret. Do not reuse coordinator, Iggy, execution, research, database or record-encryption credentials. Set Vercel's `CHAT_WAKE_URL` to the HTTPS endpoint with the exact `/internal/chat/wake` path and no credentials/query/fragment. HTTP is accepted only for loopback tests. Preview must use its own test coordinator, URL and secret, not production's.

The receiver accepts only `POST`, a valid dedicated bearer credential and an empty request body. It responds with 204, holds at most one in-memory wake flag, and cannot receive a job ID, tenant, prompt, or operation. It does not give the VPS database access. The sender schedules delivery with Next.js `after()` **after the database transaction has committed**, sends no user/record data, refuses redirects, times out each attempt after two seconds, and retries once. Failed hints never roll back a saved message; `chat_wake_failed` emits a fixed safe code and the recovery check discovers the job. An idempotent replay of a still-queued submission sends another hint.

Rollout (no active chat):

1. Deploy the web code first with wake settings absent; existing polling continues. Configure the separate environment-scoped Vercel wake URL/Secret for the next web deployment.
2. Prepare the TLS reverse proxy, then build/restart only `chat-coordinator` using both the base and wake Compose files. Preserve any existing research overrides. Startup reports `chat_coordinator_started` with mode `notifications`. During this short transition, queued jobs can wait for the five-minute recovery check.
3. Redeploy the web app with both wake settings and verify a synthetic chat is picked up promptly, even after more than five minutes idle. Verify empty/bad credentials and scope-bearing bodies are rejected, and the coordinator makes roughly 12 claims/hour when fully idle.
4. In a synthetic environment, interrupt notification delivery and verify saved queued work is discovered on the next recovery check. No secrets or health data should enter acceptance output.

To roll back dispatch, remove the wake override/Secret and restart the coordinator in polling mode, then remove the web wake settings and the reverse-proxy route. Keep the Neon queue and grants unchanged. Merging this PR does not publish a VPS endpoint, set secrets, or deploy the coordinator.

### Optional offline research snapshot

The gateway can read a manually published Markdown snapshot when the research override is enabled. On the VPS, set `CHAT_RESEARCH_SOURCE_PATH` to the raw checkout and `CHAT_RESEARCH_CORPUS_HOST_PATH` to a dedicated private parent directory; create the parent with restrictive ownership and permissions (for example, `install -d -m 0700 -o 1000 -g 1000 /srv/wildhearts/research`). Put the raw GitHub checkout in the source directory and keep both host paths out of the application repository. The web app receives only the SHA-256 hash of the gateway token; keep the raw `CHAT_RESEARCH_GATEWAY_TOKEN` in the VPS-only research environment file.

From the repository root, build the gateway and one-shot publisher, then publish with `run`:

```sh
docker compose --env-file services/chat/.env --env-file services/chat/.env.research -f services/chat/docker-compose.yml -f services/chat/docker-compose.research.yml build chat-gateway research-publisher
docker compose --env-file services/chat/.env --env-file services/chat/.env.research -f services/chat/docker-compose.yml -f services/chat/docker-compose.research.yml run --rm --no-deps research-publisher
docker compose --env-file services/chat/.env --env-file services/chat/.env.research -f services/chat/docker-compose.yml -f services/chat/docker-compose.research.yml up -d --no-deps chat-gateway
```

Do not use `docker compose up` for `research-publisher`; it is a one-shot validation-and-publish command in the `research-publish` profile. The gateway mounts the dedicated published parent read-only at `/published`; its corpus engine reads only `/published/current`. The publisher scans only the configured curated Markdown directories and `index.md`, enforces file and byte bounds, validates the staged snapshot, then replaces `current` with a brief fail-closed rename gap. Update the raw checkout and run the publisher again to publish a newer snapshot. Retained snapshots support in-flight runs within the gateway process; after a gateway restart, a missing old pin fails closed instead of switching to the latest snapshot. Never mount the raw checkout into the gateway, coordinator, or worker.

Deploy the matching Iggy health-profile update (285-second timeout) before starting this 270-second Pi worker. Update its pinned worker image digest during the same idle rollout. The old Iggy profile stops workers after 120 seconds, so increasing gateway or worker settings alone does not extend the available run time.

Pin the deployed worker as `registry/image@sha256:<digest>`. Build and exercise the synthetic Iggy profile in an approved test environment before connecting real accounts. Do not expose the coordinator, private gateway, Iggy API, Docker socket, or worker network to the public internet.

## Verify

```sh
cd services/chat
npm ci
npm run typecheck
npm test
npm run build
```

The transport tests use synthetic credentials and responses. They verify credential separation, claim retry identity, malformed request rejection, bounded relays, cancellation propagation, and operation without database configuration. They do not establish compatibility with a deployed inference model or clinical accuracy.

### Thinking and activity

The Wild Hearts primary profile is `qwen3.8-27b-gsq-9070-thinking` (alias `single-9070-thinking`). Merge `llama-swap.example.yaml` into the host's private configuration with the known working executable/model paths. The server enables thinking with a 1024-token budget and extracts it into `reasoning_content`. Keep the original fast profile available; fallback profiles may have different thinking settings. Use `CHAT_INFERENCE_MAX_TOKENS=6144` for thinking plus the final answer, and set the same primary ID in the web authority and private gateway. Model choice and thinking limits stay server controlled.

`ttl: 3600` retains an idle model for an hour; swapping to another model or Gaming Mode can still unload it. Cold starts have a 120-second first-byte attempt budget, a 240-second total inference limit, a 270-second Pi limit, a 285-second Iggy health profile limit, and a 300-second web run deadline. Setup occurs at different phases, so these limits do not guarantee a fixed cleanup window.

Model thinking is emitted separately from answers as encrypted, user-scoped events (up to 32 KiB and 16 events per run), replayed in a collapsed Thinking panel, and excluded from conversation history sent to future runs. Tool activity shows bounded descriptions of search queries and filters, selected record titles, returned counts, secondary elapsed time and allowlisted failure stages/codes. Descriptions remain in encrypted, user-scoped events; raw provider exceptions, record identifiers and full tool arguments/results are not diagnostic UI fields. Deploy the web protocol update before the matching worker image so the web authority accepts the new optional activity fields. Older saved events retain generic labels. The six-call durable lookup budget is enforced both by the authority and worker. Exhaustion is non-retryable, and the worker reserves a final response without tools using available evidence, dates and coverage limits.
