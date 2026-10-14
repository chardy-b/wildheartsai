"""Operator-only staging on the authorized VPS. No secret values are printed.

Run from /opt/wildhearts-extraction after building the worker and namespaced Iggy.
Does not start a coordinator or change the web app/production chat configuration.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess

ROOT = Path("/opt/wildhearts-extraction")

def protected(path, values):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any("\n" in value or "\r" in value for value in values.values()): raise ValueError("invalid_environment")
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items())); path.chmod(0o600)

def inspect(name): return json.loads(subprocess.check_output(["docker", "inspect", name]))[0]

def stage():
    if ROOT.resolve() != ROOT or not ROOT.is_dir(): raise SystemExit("Unexpected staging directory")
    existing = inspect("wildhearts-chat-gateway")
    worker_id = subprocess.check_output(["docker", "image", "inspect", "wildhearts-extraction-worker:v1", "--format", "{{.Id}}"], text=True).strip()
    inference = dict(x.split("=", 1) for x in existing["Config"]["Env"] if "=" in x)
    common = {"EXTRACTION_WEB_URL": "https://www.wildheartsai.com", "EXTRACTION_INFERENCE_URL": inference["CHAT_INFERENCE_URL"],
              "EXTRACTION_INFERENCE_KEY": inference.get("CHAT_INFERENCE_API_KEY", ""), "EXTRACTION_SUMMARY_MODEL": inference["CHAT_INFERENCE_MODEL"], "EXTRACTION_WORKER_IMAGE": worker_id}
    token_file = ROOT / "secrets" / "iggy-token"
    token_file.parent.mkdir(mode=0o700, exist_ok=True)
    if not token_file.exists(): token_file.write_text(secrets.token_urlsafe(48)); token_file.chmod(0o600)
    coordinator_file = ROOT / "secrets" / "coordinator-token"
    if not coordinator_file.exists(): coordinator_file.write_text(secrets.token_urlsafe(48)); coordinator_file.chmod(0o600)
    control = {"IGGY_URL": "http://wildhearts-extraction-iggy:8417", "IGGY_BEARER_TOKEN": token_file.read_text().strip()}
    protected(ROOT / "services/extraction/.env.gateway", common)
    protected(ROOT / "services/extraction/.env.coordinator", {"EXTRACTION_WEB_URL": common["EXTRACTION_WEB_URL"], "EXTRACTION_COORDINATOR_TOKEN": coordinator_file.read_text().strip(), **control})
    protected(ROOT / "services/extraction/.env.acceptance", {**common, **control})
    # This verifier is safe to install on the web backend. Keep the raw token VPS-only.
    (ROOT / "secrets/coordinator-token.sha256").write_text(hashlib.sha256(coordinator_file.read_bytes()).hexdigest())
    subprocess.run(["docker", "network", "inspect", "wildhearts-extraction-trusted"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if subprocess.run(["docker", "network", "inspect", "wildhearts-extraction-trusted"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        subprocess.run(["docker", "network", "create", "wildhearts-extraction-trusted"], check=True, stdout=subprocess.DEVNULL)
    daemon_image = inspect("wildhearts-iggy")["Image"]
    exists = subprocess.run(["docker", "inspect", "wildhearts-extraction-iggy"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if exists and worker_id not in inspect("wildhearts-extraction-iggy")["Config"]["Cmd"]:
        active = subprocess.check_output(["docker", "ps", "-q", "--filter", "label=whdoc.run"], text=True).strip()
        if active: raise SystemExit("Document workers active; stop coordinator and wait before repinning")
        owned = inspect("wildhearts-extraction-iggy")
        if not any(m.get("Source") == str(ROOT / "state") and m.get("Destination") == "/state" for m in owned["Mounts"]): raise SystemExit("Unexpected daemon custody")
        subprocess.run(["docker", "rm", "-f", "wildhearts-extraction-iggy"], check=True, stdout=subprocess.DEVNULL)
    if subprocess.run(["docker", "inspect", "wildhearts-extraction-iggy"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        subprocess.run(["docker", "run", "-d", "--name", "wildhearts-extraction-iggy", "--network", "wildhearts-extraction-trusted", "--restart", "unless-stopped", "--memory", "128m", "--cpus", "0.25",
                        "-v", str(ROOT / "iggy/iggyd") + ":/iggyd:ro", "-v", str(token_file) + ":/iggy-token:ro", "-v", str(ROOT / "state") + ":/state", "-v", "/var/run/docker.sock:/var/run/docker.sock", daemon_image,
                        "/iggyd", "-bind", "0.0.0.0:8417", "-runs-dir", "/state/runs", "-cache-dir", "/state/cache", "-token-file", "/iggy-token", "-health-image", worker_id,
                        "-health-gateway-container", "wildhearts-extraction-gateway", "-health-gateway-alias", "wildhearts-extraction-gateway", "-health-gateway-port", "8080"], check=True, stdout=subprocess.DEVNULL)
    print("Extraction Iggy staged. Coordinator remains stopped. Production chat unchanged.")

if __name__ == "__main__": stage()
