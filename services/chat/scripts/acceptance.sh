#!/usr/bin/env bash
set -euo pipefail
# Synthetic-only integration fixture. It never uses existing host data or containers.
root=${CHAT_TEST_ROOT:?Set an absolute isolated directory named whchat-test-*}
iggy=${IGGY_TEST_BINARY:?Set the absolute path to the reviewed Linux Iggy binary}
root=$(realpath -m -- "$root")
case "$root" in /*/whchat-test-*) ;; *) echo 'CHAT_TEST_ROOT must be an isolated whchat-test-* directory'; exit 1;; esac
test_dir="$root/acceptance-$(date +%s)-$$"
mkdir -p "$test_dir/runs" "$test_dir/cache"
prefix=${CHAT_TEST_PREFIX:-whchat-test-$(date +%s)-$$}
[[ "$prefix" =~ ^whchat-test-[a-zA-Z0-9-]+$ ]] || { echo 'Invalid isolated test prefix'; exit 1; }
db="$prefix-db"
gateway="$prefix-gateway"
api="$prefix-api"
model="$prefix-model"
manager="$prefix-iggy"
network="$prefix-service"
daemon_pid=
for name in "$api" "$manager" "$gateway" "$model" "$db"; do
  if docker container inspect "$name" >/dev/null 2>&1; then echo "Refusing existing container: $name"; exit 1; fi
done
if docker network inspect "$network" >/dev/null 2>&1; then echo 'Refusing existing network'; exit 1; fi
cleanup() {
  if [ -n "$daemon_pid" ]; then kill "$daemon_pid" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true; fi
  for name in "$api" "$manager" "$gateway" "$model" "$db"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
DOCKER_BUILDKIT=0 docker build --memory=256m --cpu-period=100000 --cpu-quota=50000 -f services/chat/Dockerfile --target worker -t "$prefix-pi-worker:local" . >"$test_dir/worker-build.log" 2>&1
DOCKER_BUILDKIT=0 docker build --memory=256m --cpu-period=100000 --cpu-quota=50000 -f services/chat/Dockerfile --target service -t "$prefix-chat-service:local" . >"$test_dir/service-build.log" 2>&1
echo 'Real worker and service Docker targets built.'
docker network create "$network" >/dev/null
mkdir -p "$test_dir/postgres"
docker run -d --name "$db" --network "$network" --memory=128m --cpus=.5 -v "$test_dir/postgres:/var/lib/postgresql" -e POSTGRES_PASSWORD=synthetic-only -e POSTGRES_DB=chat postgres:18.6-alpine -c shared_buffers=16MB -c max_connections=20 >/dev/null
# TCP readiness avoids observing initdb's temporary Unix-socket-only server.
for _ in $(seq 1 60); do docker exec "$db" pg_isready -h 127.0.0.1 -U postgres -d chat >/dev/null 2>&1 && break; sleep .5; done
for migration in drizzle/*.sql; do docker exec -i "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d chat <"$migration" >"$test_dir/migration.log" 2>&1; done
docker exec -i "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d chat -v chat_data_password=synthetic-data -v chat_queue_password=synthetic-queue <scripts/provision-chat-roles.sql >"$test_dir/roles.log" 2>&1
docker exec -i "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d chat >"$test_dir/seed.log" <<'SQL'
INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ('synthetic-alice','Synthetic Alice','alice@synthetic.example',true,now(),now());
INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES ('synthetic-session','synthetic-unused-session-token','synthetic-alice',now()+interval '1 hour',now(),now());
INSERT INTO health_source (id,user_id,vendor,fhir_base_url,organization_name,status,last_sync_status) VALUES ('10000000-0000-4000-8000-000000000001','synthetic-alice','epic','https://synthetic.example/R4','Synthetic organization','disconnected','partial');
INSERT INTO fhir_resource (id,user_id,source_id,resource_type,fhir_id,category,content_hmac,sealed_resource,sealed_summary,normalizer_version,first_seen_at,last_seen_at) VALUES ('20000000-0000-4000-8000-000000000001','synthetic-alice','10000000-0000-4000-8000-000000000001','Observation','synthetic-observation','lab','synthetic-hmac','synthetic-unused','synthetic-unused',2,now(),now());
SQL
cat >"$test_dir/model.mjs" <<'JS'
import { createServer } from 'node:http';
let rounds=0;
createServer(async (req,res)=>{
  if(req.url!='/v1/chat/completions'){res.writeHead(404);return res.end();}
  let data='';for await(const chunk of req)data+=chunk;
  const input=JSON.parse(data);if(input.model!=='synthetic-model'){res.writeHead(400);return res.end();}
  const round=++rounds;
  let delta;
  if(round===1) delta={role:'assistant',tool_calls:[{index:0,id:'call_synthetic_coverage',type:'function',function:{name:'get_data_coverage',arguments:'{}'}}]};
  else if(round===2) delta={role:'assistant',tool_calls:[{index:0,id:'call_synthetic_summary',type:'function',function:{name:'save_summary',arguments:JSON.stringify({title:'Synthetic record coverage',text:'One synthetic lab record is stored; coverage is partial.',coverageState:'partial',evidence:[{kind:'record',targetId:'20000000-0000-4000-8000-000000000001'}]})}}]};
  else delta={role:'assistant',content:'One synthetic lab record is available [20000000-0000-4000-8000-000000000001].'};
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const d of [delta,{}])res.write('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',created:1,model:'synthetic-model',choices:[{index:0,delta:d,finish_reason:Object.keys(d).length?null:round<3?'tool_calls':'stop'}]})+'\n\n');
  res.end('data: [DONE]\n\n');
}).listen(8080,'0.0.0.0');
JS
docker run -d --name "$model" --network "$network" --memory=64m --cpus=.25 --read-only --cap-drop=ALL --security-opt=no-new-privileges -v "$test_dir/model.mjs:/fixture.mjs:ro" --entrypoint node "$prefix-chat-service:local" /fixture.mjs >/dev/null
signing=synthetic-signing-key-at-least-thirty-two-characters
runner=$(python3 -c 'import base64; print(base64.urlsafe_b64encode(bytes([2])*32).decode().rstrip("="))')
records=$(python3 -c 'import base64; print(base64.b64encode(bytes([1])*32).decode())')
token=synthetic-iggy-management-token
printf '%s' "$token" >"$test_dir/iggy-token"
chmod 600 "$test_dir/iggy-token"
cat >"$test_dir/common.env" <<EOF
CHAT_DATABASE_URL=postgres://wildhearts_chat_data:synthetic-data@$db:5432/chat
CHAT_QUEUE_DATABASE_URL=postgres://wildhearts_chat_queue:synthetic-queue@$db:5432/chat
RECORDS_ENCRYPTION_KEY=$records
CHAT_INFERENCE_URL=http://$model:8080/v1
CHAT_INFERENCE_MODEL=synthetic-model
IGGY_URL=http://$manager:8417
IGGY_BEARER_TOKEN=$token
CHAT_RUNNER_CAPABILITY_KEY=$runner
CHAT_RUNNER_ISSUER=wild-hearts-chat-service
PORT=8080
EOF
chmod 600 "$test_dir/common.env"
docker run -d --name "$gateway" --network "$network" --memory=128m --cpus=.5 --read-only --cap-drop=ALL --security-opt=no-new-privileges --env-file "$test_dir/common.env" -e CHAT_SERVICE_MODE=gateway "$prefix-chat-service:local" >/dev/null
image=$(docker image inspect "$prefix-pi-worker:local" --format '{{.Id}}')
docker run -d --name "$manager" --network "$network" --memory=64m --cpus=.25 -v /var/run/docker.sock:/var/run/docker.sock -v "$iggy:/iggyd:ro" -v "$test_dir:/fixture" --entrypoint /iggyd busybox:1.37.0 -bind 0.0.0.0:8417 -runs-dir /fixture/runs -cache-dir /fixture/cache -token-file /fixture/iggy-token -health-image "$image" -health-gateway-container "$gateway" -health-gateway-alias "$gateway" -health-gateway-port 8080 >/dev/null
docker run -d --name "$api" --network "$network" --memory=128m --cpus=.5 --read-only --cap-drop=ALL --security-opt=no-new-privileges --env-file "$test_dir/common.env" -e CHAT_SERVICE_MODE=public -e CHAT_SIGNING_KEY="$signing" -e CHAT_WEB_ORIGIN=http://localhost:3000 -e CHAT_WORKER_ID=synthetic-dispatcher -p 127.0.0.1:18081:8080 "$prefix-chat-service:local" >/dev/null
ticket=$(python3 - <<'PY'
import base64,json,hmac,hashlib,time,uuid
enc=lambda v:base64.urlsafe_b64encode(json.dumps(v,separators=(',',':')).encode()).decode().rstrip('=')
now=int(time.time()); data=enc({'alg':'HS256','typ':'JWT'})+'.'+enc({'sub':'synthetic-alice','sid':'synthetic-session','iss':'wildhearts-web','aud':'wildhearts-chat','jti':str(uuid.uuid4()),'iat':now,'exp':now+90})
print(data+'.'+base64.urlsafe_b64encode(hmac.new(b'synthetic-signing-key-at-least-thirty-two-characters',data.encode(),hashlib.sha256).digest()).decode().rstrip('='))
PY
)
for _ in $(seq 1 60); do curl -fsS -H "Authorization: Bearer $ticket" http://127.0.0.1:18081/v1/conversations >"$test_dir/list.json" 2>/dev/null && break; sleep .5; done
curl -fsS -X POST -H "Authorization: Bearer $ticket" -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:18081/v1/conversations >"$test_dir/conversation.json"
conversation=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["conversation"]["id"])' "$test_dir/conversation.json")
nonce=$(python3 -c 'import uuid;print(uuid.uuid4())')
curl -fsS -X POST -H "Authorization: Bearer $ticket" -H 'Origin: http://localhost:3000' -H "Idempotency-Key: $nonce" -H 'Content-Type: application/json' -d '{"message":"What synthetic records are available? Save useful coverage memory."}' "http://127.0.0.1:18081/v1/conversations/$conversation/runs" >"$test_dir/run.json"
# Closing this HTTP request leaves the run executing; retrieve the saved result afterwards.
for _ in $(seq 1 90); do
  curl -fsS -H "Authorization: Bearer $ticket" "http://127.0.0.1:18081/v1/conversations/$conversation" >"$test_dir/detail.json"
  state=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runs"][-1]["status"])' "$test_dir/detail.json")
  [ "$state" = completed ] && break
  if [ "$state" = failed ] || [ "$state" = interrupted ]; then echo "Synthetic run failed: $state"; docker logs "$api"; docker logs "$gateway"; docker logs "$manager"; docker logs "$model"; exit 1; fi
  sleep .5
done
[ "$state" = completed ]
curl -fsS -H "Authorization: Bearer $ticket" http://127.0.0.1:18081/v1/summaries >"$test_dir/summaries.json"
python3 - "$test_dir" <<'PY'
import json,sys
root=sys.argv[1];detail=json.load(open(root+'/detail.json'));summaries=json.load(open(root+'/summaries.json'))
assert len(detail['messages'])==2
assert detail['messages'][-1]['role']=='assistant' and 'One synthetic lab record' in detail['messages'][-1]['content']
assert len(summaries['summaries'])==1
print('Authenticated HTTP -> durable queue -> isolated Pi worker -> coverage tool -> automatic encrypted summary -> saved final answer: PASS')
PY
count=$(docker exec "$db" psql -XAt -U postgres -d chat -c 'select count(*) from chat_tool_call')
[ "$count" = 2 ]
docker exec "$db" psql -XAt -U postgres -d chat -c 'select sealed_content from chat_message union all select sealed_content from user_summary' >"$test_dir/ciphertext.txt"
if grep -q 'synthetic lab record\|synthetic records are available' "$test_dir/ciphertext.txt"; then echo 'Plaintext leaked into ciphertext'; exit 1; fi
run=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runId"])' "$test_dir/run.json")
for _ in $(seq 1 30); do docker network inspect "iggy-health-$run" >/dev/null 2>&1 || break; sleep .5; done
if docker network inspect "iggy-health-$run" >/dev/null 2>&1; then echo 'Run network leaked'; exit 1; fi
if grep -R -q 'synthetic records are available\|One synthetic lab record\|IGGY_BROKER_CAPABILITY' "$test_dir/runs"; then echo 'Health content leaked into Iggy artifacts'; exit 1; fi
echo "Synthetic real Docker acceptance PASS; retained evidence: $test_dir"
