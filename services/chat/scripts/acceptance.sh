#!/usr/bin/env bash
set -euo pipefail

# Synthetic-only end-to-end check for the web-owned worker API. It creates and
# removes containers/networks with an isolated prefix and never uses production.
root=${CHAT_TEST_ROOT:?Set an absolute isolated directory named whchat-test-*}
iggy=${IGGY_TEST_BINARY:?Set the absolute path to the reviewed Linux Iggy binary}
root=$(realpath -m -- "$root")
case "$root" in /*/whchat-test-*) ;; *) echo 'CHAT_TEST_ROOT must be an isolated whchat-test-* directory'; exit 1;; esac
test_dir="$root/acceptance-$(date +%s)-$$"
mkdir -p "$test_dir/runs" "$test_dir/cache"
chmod 700 "$test_dir"
prefix=${CHAT_TEST_PREFIX:-whchat-test-$(date +%s)-$$}
[[ "$prefix" =~ ^whchat-test-[a-zA-Z0-9-]+$ ]] || { echo 'Invalid isolated test prefix'; exit 1; }
command -v openssl >/dev/null || { echo 'openssl is required to create the isolated test certificate'; exit 1; }
db="$prefix-db"
web="$prefix-web"
coordinator="$prefix-coordinator"
gateway="$prefix-gateway"
model="$prefix-model"
manager="$prefix-iggy"
worker_probe="$prefix-worker-import"
network="$prefix-service"
browser_network="$prefix-browser"
port=${CHAT_TEST_PORT:-18083}
[[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || { echo 'Invalid CHAT_TEST_PORT'; exit 1; }
python3 - "$port" <<'PY'
import socket,sys
s=socket.socket();
try: s.bind(('127.0.0.1',int(sys.argv[1])))
except OSError: raise SystemExit('CHAT_TEST_PORT is already in use')
finally: s.close()
PY
for name in "$web" "$coordinator" "$gateway" "$manager" "$model" "$db" "$worker_probe"; do
  if docker container inspect "$name" >/dev/null 2>&1; then echo "Refusing existing container: $name"; exit 1; fi
done
if docker network inspect "$network" >/dev/null 2>&1; then echo 'Refusing existing network'; exit 1; fi
if docker network inspect "$browser_network" >/dev/null 2>&1; then echo 'Refusing existing browser network'; exit 1; fi
capture_web_diagnostic() {
  local raw_line
  raw_line=$(docker logs --tail 100 "$web" 2>&1 | grep -E '^synthetic_web_fixture_failed phase=[a-z_]+ code=[A-Z0-9_]+ slug=[a-z0-9_]+$' | tail -n 1) || true
  if [[ "$raw_line" =~ ^synthetic_web_fixture_failed\ phase=(validate_synthetic_environment|connect_and_seed_synthetic_database|preflight_restricted_data_and_queue_roles|preflight_restricted_data_role|preflight_restricted_queue_role|initialize_web_authority|read_test_tls_material|start_test_http_listener|listen_with_test_tls|listen_test_http)\ code=([A-Z0-9_]+)\ slug=([a-z0-9_]+)$ ]]; then
    printf '%s\n' "$raw_line" >"$test_dir/web-startup-diagnostic.txt"
  else
    printf '%s\n' 'synthetic_web_fixture_diagnostic_unavailable' >"$test_dir/web-startup-diagnostic.txt"
  fi
}
cleanup() {
  if docker container inspect "$web" >/dev/null 2>&1; then
    capture_web_diagnostic
  fi
  for name in "$web" "$coordinator" "$gateway" "$manager" "$model" "$db" "$worker_probe"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  docker network rm "$browser_network" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -f "$test_dir"/*.env "$test_dir"/iggy-token
  if [ -f "$test_dir/web-startup-diagnostic.txt" ]; then
    echo "Synthetic web startup diagnostic retained at $test_dir/web-startup-diagnostic.txt" >&2
  fi
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$test_dir/tls.key" -out "$test_dir/tls.pem" -days 1 -subj "/CN=$web" -addext "subjectAltName=DNS:$web,IP:127.0.0.1" >/dev/null 2>&1
chown 1000:1000 "$test_dir/tls.key"
chmod 600 "$test_dir/tls.key"
chmod 644 "$test_dir/tls.pem"

DOCKER_BUILDKIT=0 docker build --memory=256m --cpu-period=100000 --cpu-quota=50000 -f services/chat/Dockerfile --target worker -t "$prefix-pi-worker:local" . >"$test_dir/worker-build.log" 2>&1
DOCKER_BUILDKIT=0 docker build --memory=256m --cpu-period=100000 --cpu-quota=50000 -f services/chat/Dockerfile --target service -t "$prefix-chat-service:local" . >"$test_dir/service-build.log" 2>&1
DOCKER_BUILDKIT=0 docker build --memory=256m --cpu-period=100000 --cpu-quota=50000 -f scripts/chat-acceptance/Dockerfile -t "$prefix-chat-web:local" . >"$test_dir/web-build.log" 2>&1
# Import the built worker and real SDK dependencies before creating any queued job.
# Empty worker settings prevent configuration/context access; network none is an extra fence.
worker_import=$(timeout --kill-after=2s 10s docker run --rm --name "$worker_probe" --network none --read-only --memory=128m --cpus=.25 --cap-drop=ALL --security-opt=no-new-privileges --env IGGY_BROKER_CAPABILITY= --env IGGY_GATEWAY_URL= --entrypoint node "$prefix-pi-worker:local" --input-type=module -e 'setTimeout(() => { console.log("synthetic_worker_import failed"); process.exit(1); }, 5000); try { await import("file:///app/dist/worker-entry.js"); console.log("synthetic_worker_import ready"); process.exit(0); } catch { console.log("synthetic_worker_import failed"); process.exit(1); }' 2>&1 | grep -E '^synthetic_worker_import (ready|failed)$' | tail -n 1) || true
if [ "$worker_import" != 'synthetic_worker_import ready' ]; then
  printf '%s\n' 'synthetic_worker_import failed' >"$test_dir/worker-import-diagnostic.txt"
  echo "Synthetic worker import failed; safe diagnostic retained at $test_dir/worker-import-diagnostic.txt" >&2
  exit 1
fi
printf '%s\n' 'synthetic_worker_import ready' >"$test_dir/worker-import-diagnostic.txt"
docker network create --internal "$network" >/dev/null
docker network create "$browser_network" >/dev/null
mkdir -p "$test_dir/postgres"
docker run -d --name "$db" --network "$network" --memory=128m --cpus=.5 -v "$test_dir/postgres:/var/lib/postgresql" -e POSTGRES_PASSWORD=synthetic-only -e POSTGRES_DB=chat postgres:18.6-alpine -c shared_buffers=16MB -c max_connections=30 >/dev/null
for _ in $(seq 1 60); do docker exec "$db" pg_isready -h 127.0.0.1 -U postgres -d chat >/dev/null 2>&1 && break; sleep .5; done
docker exec "$db" pg_isready -h 127.0.0.1 -U postgres -d chat >/dev/null
for migration in drizzle/*.sql; do docker exec -i "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d chat <"$migration" >"$test_dir/migration.log" 2>&1; done
docker exec -i "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d chat -v chat_data_password=synthetic-data -v chat_queue_password=synthetic-queue <scripts/provision-chat-roles.sql >"$test_dir/roles.log" 2>&1

records=$(python3 -c 'import base64; print(base64.b64encode(bytes([1])*32).decode())')
grant_key=$(python3 -c 'import base64; print(base64.urlsafe_b64encode(bytes([3])*32).decode().rstrip("="))')
credential=$(python3 -c 'print("a"*43)')
token=synthetic-iggy-management-token-long-enough
printf '%s' "$token" >"$test_dir/iggy-token"
chmod 600 "$test_dir/iggy-token"
web_origin="https://$web:8080"
cat >"$test_dir/web.env" <<EOF
DATABASE_URL_UNPOOLED=postgres://postgres:synthetic-only@$db:5432/chat
CHAT_TEST_ONLY=synthetic-accounts
CHAT_TEST_WEB_ORIGIN=$web_origin
CHAT_ENABLED=1
CHAT_DATABASE_URL=postgres://wildhearts_chat_data:synthetic-data@$db:5432/chat
CHAT_QUEUE_DATABASE_URL=postgres://wildhearts_chat_queue:synthetic-queue@$db:5432/chat
RECORDS_ENCRYPTION_KEY=$records
CHAT_GRANT_DERIVATION_KEY=$grant_key
CHAT_INFERENCE_MODEL=synthetic-model
CHAT_COORDINATOR_CREDENTIAL=$credential
CHAT_TEST_TLS_KEY=/fixture/tls.key
CHAT_TEST_TLS_CERT=/fixture/tls.pem
EOF
cat >"$test_dir/coordinator.env" <<EOF
CHAT_SERVICE_MODE=coordinator
CHAT_WEB_API_URL=$web_origin/api/chat/worker/v1
CHAT_COORDINATOR_TOKEN=$credential
CHAT_WORKER_ID=$prefix-worker
IGGY_URL=http://$manager:8417
IGGY_BEARER_TOKEN=$token
NODE_EXTRA_CA_CERTS=/fixture/tls.pem
EOF
cat >"$test_dir/gateway.env" <<EOF
CHAT_SERVICE_MODE=gateway
CHAT_WEB_API_URL=$web_origin/api/chat/worker/v1
CHAT_INFERENCE_URL=http://$model:8080/v1
CHAT_INFERENCE_MODEL=synthetic-model
CHAT_INFERENCE_MAX_TOKENS=2048
NODE_EXTRA_CA_CERTS=/fixture/tls.pem
EOF
chmod 600 "$test_dir"/*.env

cat >"$test_dir/model.mjs" <<'JS'
import { createServer } from 'node:http';
const tools = [
  ['get_data_coverage', '{}'],
  ['find_records', JSON.stringify({query:'Synthetic lab',limit:5})],
  ['read_records', JSON.stringify({recordIds:['20000000-0000-4000-8000-000000000001'],includeDetails:false})],
  ['save_summary', JSON.stringify({title:'Synthetic lab coverage',text:'One synthetic lab record is stored.',coverageState:'partial',evidence:[{kind:'record',targetId:'20000000-0000-4000-8000-000000000001'}]})],
];
let rounds=0;
createServer(async (req,res)=>{
  if(req.url!='/v1/chat/completions'){res.writeHead(404);return res.end();}
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>524288){res.writeHead(413);return res.end();}}
  let input;try{input=JSON.parse(raw);}catch{res.writeHead(400);return res.end();}
  if(input.model!=='synthetic-model'||input.max_tokens>2048||!Array.isArray(input.messages)){res.writeHead(400);return res.end();}
  const round=rounds++;
  const delta=round<tools.length
    ? {role:'assistant',tool_calls:[{index:0,id:`call_synthetic_${round+1}`,type:'function',function:{name:tools[round][0],arguments:tools[round][1]}}]}
    : {role:'assistant',content:'One synthetic lab record is stored [20000000-0000-4000-8000-000000000001].'};
  const finish=round<tools.length?'tool_calls':'stop';
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
  for(const d of [delta,{}])res.write('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',created:1,model:'synthetic-model',choices:[{index:0,delta:d,finish_reason:Object.keys(d).length?null:finish}]})+'\n\n');
  res.end('data: [DONE]\n\n');
}).listen(8080,'0.0.0.0');
JS

docker run -d --name "$model" --network "$network" --memory=64m --cpus=.25 --read-only --cap-drop=ALL --security-opt=no-new-privileges -v "$test_dir/model.mjs:/fixture.mjs:ro" --entrypoint node "$prefix-chat-service:local" /fixture.mjs >/dev/null
docker run -d --name "$web" --network "$network" --memory=256m --cpus=.5 --read-only --cap-drop=ALL --security-opt=no-new-privileges --mount "type=bind,src=$test_dir/tls.key,dst=/fixture/tls.key,readonly" --mount "type=bind,src=$test_dir/tls.pem,dst=/fixture/tls.pem,readonly" --env-file "$test_dir/web.env" -p "127.0.0.1:$port:8080" "$prefix-chat-web:local" >/dev/null
docker network connect "$browser_network" "$web"
web_url="https://127.0.0.1:$port"
web_curl() { curl --cacert "$test_dir/tls.pem" --connect-timeout 2 --max-time 3 -fsS "$@"; }
capture_run_diagnostic() {
  local run_id event_summary tool_count
  run_id=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runId"])' "$test_dir/run.json")
  event_summary=$(web_curl -H "Cookie: $cookie" "$web_url/api/chat/v1/runs/$run_id/events" 2>/dev/null | python3 -c '
import json,sys
try:
    data=json.load(sys.stdin)
    allowed={"run.started","answer.delta","tool.started","tool.completed","answer.completed","run.completed","run.cancelled","run.failed"}
    safe_codes={"worker_failed","worker_timeout","inference_unavailable","runner_start_failed","runner_failed","coordinator_stopped"}
    kinds=[event.get("kind") for event in data.get("events",[]) if event.get("kind") in allowed]
    codes=sorted({event.get("payload",{}).get("code") for event in data.get("events",[]) if isinstance(event.get("payload"),dict) and event["payload"].get("code") in safe_codes})
    print("events="+(",".join(kinds) if kinds else "none")+" codes="+(",".join(codes) if codes else "none"))
except Exception:
    print("events=unavailable codes=none")
' 2>/dev/null) || event_summary='events=unavailable codes=none'
  [[ "$event_summary" =~ ^events=[a-z.,]+\ codes=[a-z_,]+$ ]] || event_summary='events=unavailable codes=none'
  tool_count=$(docker exec "$db" psql -XAt -U postgres -d chat -c 'select count(*) from chat_tool_call' 2>/dev/null || true)
  [[ "$tool_count" =~ ^[0-9]{1,6}$ ]] || tool_count=unavailable
  printf 'synthetic_run_diagnostic state=%s %s tool_calls=%s\n' "$state" "$event_summary" "$tool_count" >"$test_dir/run-diagnostic.txt"
}
probe_internal_web() {
  local line
  line=$(timeout 5s docker exec -e NODE_EXTRA_CA_CERTS=/fixture/tls.pem "$web" node --input-type=module -e 'let response; try { response = await fetch(process.argv[1], { redirect: "error", signal: AbortSignal.timeout(2000) }); console.log(`synthetic_internal_health status=${response.status}`); } catch { console.log("synthetic_internal_health error"); process.exitCode = 1; } finally { await response?.body?.cancel().catch(() => {}); }' "https://127.0.0.1:8080/health" 2>&1 | grep -E '^synthetic_internal_health (status=[0-9]{3}|error)$' | tail -n 1) || true
  if [[ "$line" =~ ^synthetic_internal_health\ status=([0-9]{3})$ ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf '%s' "000"; fi
}
internal_status=000
for _ in $(seq 1 60); do
  internal_status=$(probe_internal_web)
  [ "$internal_status" = 200 ] && break
  sleep .5
done
ready=0
external_status=000
for _ in $(seq 1 60); do
  external_status=$(curl --cacert "$test_dir/tls.pem" --connect-timeout 2 --max-time 3 -sS -o /dev/null -w '%{http_code}' "$web_url/health" 2>/dev/null || true)
  [[ "$external_status" =~ ^[0-9]{3}$ ]] || external_status=000
  if [ "$external_status" = 200 ]; then ready=1; break; fi
  sleep .5
done
printf 'synthetic_web_health internal_status=%s external_status=%s\n' "$internal_status" "$external_status" >"$test_dir/web-health-diagnostic.txt"
if [ "$ready" != 1 ]; then
  capture_web_diagnostic
  echo "Synthetic web fixture readiness failed; safe diagnostics retained at $test_dir/web-health-diagnostic.txt and $test_dir/web-startup-diagnostic.txt" >&2
  exit 1
fi
docker run -d --name "$gateway" --network "$network" --memory=128m --cpus=.5 --read-only --cap-drop=ALL --security-opt=no-new-privileges --mount "type=bind,src=$test_dir/tls.pem,dst=/fixture/tls.pem,readonly" --env-file "$test_dir/gateway.env" "$prefix-chat-service:local" >/dev/null
worker_image_id=$(docker image inspect --format '{{.Id}}' "$prefix-pi-worker:local")
docker run -d --name "$manager" --network "$network" --memory=64m --cpus=.25 -v /var/run/docker.sock:/var/run/docker.sock -v "$iggy:/iggyd:ro" -v "$test_dir:/fixture" --entrypoint /iggyd busybox:1.37.0 -bind 0.0.0.0:8417 -runs-dir /fixture/runs -cache-dir /fixture/cache -token-file /fixture/iggy-token -health-image "$worker_image_id" -health-gateway-container "$gateway" -health-gateway-alias "$gateway" -health-gateway-port 8080 >/dev/null
docker run -d --name "$coordinator" --network "$network" --memory=128m --cpus=.5 --read-only --cap-drop=ALL --security-opt=no-new-privileges --mount "type=bind,src=$test_dir/tls.pem,dst=/fixture/tls.pem,readonly" --env-file "$test_dir/coordinator.env" "$prefix-chat-service:local" >/dev/null
rm -f "$test_dir"/web.env "$test_dir"/coordinator.env "$test_dir"/gateway.env "$test_dir"/iggy-token

if [ -n "$(docker port "$coordinator")" ] || [ -n "$(docker port "$gateway")" ]; then echo 'Coordinator or gateway unexpectedly publishes a port'; exit 1; fi
cookie='whchat-test=alice'
origin="$web_origin"
web_curl -X POST -H "Cookie: $cookie" -H "Origin: $origin" -H 'Content-Type: application/json' -d '{}' "$web_url/api/chat/v1/conversations" >"$test_dir/conversation.json"
conversation=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["conversation"]["id"])' "$test_dir/conversation.json")
nonce=$(python3 -c 'import uuid;print(uuid.uuid4())')
web_curl -X POST -H "Cookie: $cookie" -H "Origin: $origin" -H "Idempotency-Key: $nonce" -H 'Content-Type: application/json' -d '{"message":"What synthetic health record is stored? Read it before saving a useful summary."}' "$web_url/api/chat/v1/conversations/$conversation/runs" >"$test_dir/run.json"
for _ in $(seq 1 240); do
  web_curl -H "Cookie: $cookie" "$web_url/api/chat/v1/conversations/$conversation" >"$test_dir/detail.json"
  state=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["runs"][-1]["status"] if d.get("runs") else "missing")' "$test_dir/detail.json")
  [ "$state" = completed ] && break
  if [ "$state" = failed ] || [ "$state" = interrupted ] || [ "$state" = missing ]; then
    capture_run_diagnostic
    echo "Synthetic chat run ended as $state; safe diagnostic retained at $test_dir/run-diagnostic.txt"
    exit 1
  fi
  sleep .5
done
[ "$state" = completed ]
other_user_status=$(curl --cacert "$test_dir/tls.pem" --connect-timeout 2 --max-time 3 -sS -o /dev/null -w '%{http_code}' -H 'Cookie: whchat-test=bob' "$web_url/api/chat/v1/conversations/$conversation")
[ "$other_user_status" = 404 ]
web_curl -H "Cookie: $cookie" "$web_url/api/chat/v1/summaries" >"$test_dir/summaries.json"
python3 - "$test_dir" <<'PY'
import json,sys
root=sys.argv[1];detail=json.load(open(root+'/detail.json'));summaries=json.load(open(root+'/summaries.json'))
assert len(detail['messages'])==2
assert detail['messages'][-1]['role']=='assistant' and 'One synthetic lab record' in detail['messages'][-1]['content']
assert len(summaries['summaries'])==1
print('Web-owned API -> remote coordinator -> isolated worker -> read receipt -> encrypted summary and final answer: PASS')
PY
tool_count=$(docker exec "$db" psql -XAt -U postgres -d chat -c 'select count(*) from chat_tool_call')
[ "$tool_count" = 4 ]
docker exec "$db" psql -XAt -U postgres -d chat -c 'select sealed_content from chat_message union all select sealed_content from user_summary' >"$test_dir/ciphertext.txt"
if grep -q 'synthetic health record is stored\|synthetic lab coverage' "$test_dir/ciphertext.txt"; then echo 'Plaintext appeared in encrypted content'; exit 1; fi
run=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runId"])' "$test_dir/run.json")
for _ in $(seq 1 30); do docker network inspect "iggy-health-$run" >/dev/null 2>&1 || break; sleep .5; done
if docker network inspect "iggy-health-$run" >/dev/null 2>&1; then echo 'Run network leaked'; exit 1; fi
if grep -R -q 'synthetic health record is stored\|IGGY_BROKER_CAPABILITY' "$test_dir/runs"; then echo 'Health content appeared in Iggy artifacts'; exit 1; fi
echo "Synthetic remote chat Docker acceptance PASS; retained evidence: $test_dir"
