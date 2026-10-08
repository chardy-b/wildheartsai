# Wild Hearts chat worker transport

This package runs the VPS coordinator and private Iggy gateway. The web application remains the authority for queued jobs, run context, cancellation, tool access, transcript events, and finalization. The VPS has no Postgres adapter, record-encryption key, browser ticket signer, or public chat API.

The coordinator sends an idempotent claim request to `CHAT_WEB_API_URL`, then gives Iggy the run's execution grant. It keeps the separate control grant in coordinator memory for heartbeat and finalization calls. User IDs and database scope never enter the coordinator or worker. Each retry reuses the original request ID and body so a lost response cannot claim a different run.

The fixed gateway forwards worker context, cancellation, tool, and event requests to the web API. It accepts only an execution grant. Before forwarding inference it checks cancellation; while a stream is open it polls the web API every second and aborts if the run is cancelled or the authority cannot be reached. The inference URL and model come only from gateway configuration. Requests override model selection and cap `max_tokens`; upstream response bytes and request bodies are bounded. Prompts, answers, tokens, and provider errors are never written to logs.

## Configure

Provide the coordinator and gateway with separate environment sets. The coordinator needs `CHAT_WEB_API_URL`, `CHAT_COORDINATOR_TOKEN`, `CHAT_WORKER_ID`, `IGGY_URL`, and `IGGY_BEARER_TOKEN`. The gateway needs `CHAT_WEB_API_URL`, `CHAT_INFERENCE_URL`, `CHAT_INFERENCE_MODEL`, and optionally `CHAT_INFERENCE_MAX_TOKENS` and `CHAT_INFERENCE_API_KEY`. Do not put coordinator credentials in the gateway environment or execution grants in coordinator configuration. The URL prefix is fixed to `/api/chat/worker/v1`; it is not accepted from request bodies.

`CHAT_WEB_API_URL` should use HTTPS in deployed environments. HTTP is accepted only for loopback tests. Inference may use HTTP for a private model endpoint; credentials, query strings, and fragments are rejected in configured URLs. Keep all values in the deployment secret store or a restricted, uncommitted environment file.

## Build and run

Run from the repository root. Compose builds the coordinator and gateway. The worker image contains only the Pi entry point and runtime dependencies.

```sh
docker compose --env-file services/chat/.env -f services/chat/docker-compose.yml build
docker build -f services/chat/Dockerfile --target worker -t wildhearts-health-worker:local .
docker compose --env-file services/chat/.env -f services/chat/docker-compose.yml up -d
```

Neither service publishes a host port. Compose creates the fixed `wildhearts-chat-trusted` network for the coordinator and gateway. Attach the separately provisioned Iggy management container to that network, give it the DNS name `wildhearts-iggy`, and have it listen on port 8417 inside the network without publishing that port. Iggy attaches the fixed gateway container to each isolated worker network; each worker joins only its own network and receives only its execution grant and gateway URL. The coordinator does not join worker networks.

Keep the existing worker image digest and Iggy health-run timeout consistent. The current Pi worker deadline and supported Iggy health-run limit are 120 seconds. The web authority may enforce a longer overall deadline, but this VPS configuration does not extend Iggy's run limit; a longer worker window requires an Iggy-side change and verification before it can be claimed.

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
