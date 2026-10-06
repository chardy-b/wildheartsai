# Wild Hearts chat service

This portable Node service contains the concrete Postgres adapter, public chat API, private data/inference gateway, queue coordinator, and Pi worker. No application-specific runtime adapter needs to be supplied. Stored conversations, messages, tool arguments/results, events, and personal summaries use the existing per-user encrypted storage in `src/lib/chat`.

Browser identity comes from the web application's short-lived ticket. The service verifies the literal `CHAT_SIGNING_KEY`, issuer `wildhearts-web`, audience `wildhearts-chat`, session ID, and maximum 90-second lifetime. It rechecks session expiry, revocation, and verified email against Postgres on every public request and SSE poll. The browser cannot select a user. `POST /v1/conversations/:id/runs` requires a UUID `Idempotency-Key`; its question and run are persisted together. Public routes also list/delete conversations and summaries, cancel runs, and replay numbered SSE events through `/v1/runs/:id/events`. `/health` contains no secrets or dependency probes.

Closing the browser leaves the response running. A begun response with an expired worker lease becomes `interrupted`; the service never automatically reruns it. The person can explicitly retry. Cancellation immediately terminates queued work and fences data-bearing requests for running work. Tool calls have a durable six-call budget, sealed provider-call identifiers and arguments/results, and replay protection. Terminal worker and coordinator events commit atomically with the answer/run state.

The Pi worker receives only an opaque fenced run capability and Iggy's fixed gateway URL. It fetches bounded conversation context and the configured model ID from the broker. The broker proxies only the configured OpenAI-compatible `/chat/completions` endpoint, overrides model selection, and bounds generated tokens. Workers get neither database credentials, inference credentials, record keys, signing keys, an internet tool, shell tools, nor filesystem tools. Helpful supported summaries may be saved automatically through `save_summary`; evidence targets remain ownership checked and summary nonce/evidence row IDs come from the trusted service.

## Configure

Apply the additive Drizzle migrations through the existing deployment process. Separately review and run `scripts/provision-chat-roles.sql` to provision two distinct least-privilege accounts; do not point either service URL at an owner/superuser account. `CHAT_DATABASE_URL` supplies the context-scoped data role. `CHAT_QUEUE_DATABASE_URL` supplies metadata-only discovery/lease grants. Before either listener starts, preflight checks every effective column/table grant, non-owner/non-bypass roles, role memberships, forced RLS, exact fail-closed owner policies, restrictive policies on legacy record/key/source tables, and unscoped visibility. Incorrect or excessive grants prevent startup.

Inject runtime secrets through the deployment environment or an uncommitted restricted `.env` file. Required values are listed in `.env.example`. The web app and public API must share the exact literal `CHAT_SIGNING_KEY` string (at least 32 bytes); it is not decoded. `CHAT_RUNNER_CAPABILITY_KEY` is a separate random value encoded as base64url representing at least 32 bytes. `RECORDS_ENCRYPTION_KEY` is the existing record encryption key, with its existing base64 encoding. Keep all three distinct. Only the public API needs the browser signing key.

Set `CHAT_INFERENCE_URL` to the configured server's API base, usually ending in `/v1`, and set `CHAT_INFERENCE_MODEL` to the model identifier accepted by llama-swap/llama.cpp or Strata. Use `CHAT_INFERENCE_API_KEY` only if that endpoint requires it. `CHAT_WEB_ORIGIN` must be the exact browser origin. `IGGY_URL` must be reachable from the trusted service containers and protected by `IGGY_BEARER_TOKEN`.

## Build and start on the VPS

Run from the Wild Hearts repository root:

```sh
docker compose --env-file services/chat/.env -f services/chat/docker-compose.yml build
docker build -f services/chat/Dockerfile --target worker -t wildhearts-health-worker:local .
docker compose --env-file services/chat/.env -f services/chat/docker-compose.yml up -d
```

The Dockerfile uses the repository root as its build context so shared storage/tool code is bundled. The `service` target contains `dist/index.js`; the `worker` target contains only `dist/worker-entry.js`. The Compose public API publishes `127.0.0.1:8080`; put the existing site's TLS reverse proxy in front of it before configuring `CHAT_API_URL` in Wild Hearts. The private gateway has no published port and uses port 8080, matching Iggy's default. Both trusted processes need outbound Postgres access; the private gateway also needs outbound access to the configured inference endpoint. Their trusted network is deliberately routable. Workers must never join that network.

Build the reviewed Iggy daemon separately. Run it as a trusted host management process with a protected token file and only a private/Tailscale bind reachable by the Compose API. Binding host loopback alone will not be reachable from an ordinary bridge container. For example, with operator-supplied paths and a registry digest:

```sh
iggyd -bind "$PRIVATE_HOST_IP:8417" \
  -token-file "$IGGY_TOKEN_FILE" -runs-dir "$IGGY_RUNS_DIR" -cache-dir "$IGGY_CACHE_DIR" \
  -health-image "$HEALTH_WORKER_IMAGE_DIGEST" \
  -health-gateway-container wildhearts-chat-gateway \
  -health-gateway-alias wildhearts-chat-gateway -health-gateway-port 8080
```

Set `IGGY_URL=http://<PRIVATE_HOST_IP>:8417` in the trusted service environment. Iggy receives the Docker socket; neither chat container nor worker does. Pin the production worker to `registry/image@sha256:<digest>` rather than a mutable tag. A local Docker `sha256:<image-id>` is accepted by Iggy only for synthetic operator acceptance. Docker Engine 28 or newer is required for Iggy's per-run isolated bridge mode. Each worker gets its own isolated internal bridge containing only that worker and the fixed gateway. Iggy removes workers/networks after completion, failure, timeout, or cancellation. Run Iggy's synthetic `scripts/health-profile-acceptance.sh` before using real health data; validate no direct IP, DNS, host-service, or other-worker access and no plaintext run logs.

No database migration, production configuration, registry publish, reverse-proxy change, or deployment occurs merely by building this package. Maintain the existing Matrix/Element services when testing on a shared VPS; use a distinct Compose project/container name and resource budgets appropriate to available memory.

## Verify

```sh
npm ci --ignore-scripts # repository root dependencies for shared source/type checks
cd services/chat
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

Tests use synthetic values. The concrete adapter test migrates PGlite, applies the actual provisioning script, runs HTTP/tool/final-answer operations under constrained roles, validates real web tickets, and checks idempotency, encryption, ownership, revocation, terminal replay, crash interruption, cancellation races, and excessive grant rejection. Pi inference tests use a synthetic OpenAI-compatible response; they do not establish compatibility with an operator's actual model or clinical accuracy. Run the root application's four required delivery checks as well.

## Verified private management-container topology

A private host address must be reachable from the service bridge; a shared host firewall may block it. The synthetic VPS acceptance also verified Iggy running as a management container on the trusted Compose network, listening on `0.0.0.0:8417` inside that network with **no published port**. Set `IGGY_URL=http://wildhearts-iggy:8417` for that topology. Mount the Docker socket only into this trusted manager, plus its reviewed Linux binary, protected token file and its own state directories. Neither the public API, private gateway nor health worker gets that socket. This is an alternative deployment topology; it requires an operator to configure and supervise the manager container.

## Synthetic real-Docker acceptance

From the repository root on an approved Docker test host, supply a reviewed Iggy binary and an isolated directory:

```sh
CHAT_TEST_ROOT=/root/whchat-test-service \
IGGY_TEST_BINARY=/opt/iggy/iggyd \
bash services/chat/scripts/acceptance.sh
```

The fixture refuses colliding container/network names, limits test resources, creates its own Postgres cluster, applies migrations and the exact role-provisioning script, and runs the actual service/gateway/Pi worker against an inference stub. It checks authenticated background execution, two encrypted tool traces, automatic memory, final-answer persistence, ciphertext/artifact privacy and per-run network removal. It stops only its own containers/network and retains synthetic database and log files in the supplied test directory. It uses Docker's legacy builder solely to bound build memory/CPU on the small shared test host; production Docker builds may use BuildKit.

The fixture passed on Docker 29.8.2 / Postgres 18.6 in `/root/whchat-test-20261005-3477-service/acceptance-1791179716`. These synthetic protocol checks do not validate the operator's actual model weights, template or clinical output. The shared Matrix/Element services remained healthy.
