"""Synthetic end-to-end acceptance through real Iggy, OpenMed, and local inference.

This server holds only a made-up document. It never connects to the application's
database or production document APIs. Output contains counts and scores only.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import threading
import time
import uuid
import httpx
import gateway

LINES = ["Patient: Jane Example", "DOB: 1980-06-20", "MRN: ABC123", "Glucose 100 mg/dL", "Hemoglobin 13.5 g/dL"]

def synthetic_pdf():
    stream = "BT /F1 16 Tf 50 760 Td " + " ".join(("0 -30 Td " if i else "") + "(" + line + ") Tj" for i, line in enumerate(LINES)) + " ET"
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream"]
    output = bytearray(b"%PDF-1.4\n"); offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(output)); output.extend(f"{i} 0 obj\n{obj}\nendobj\n".encode())
    start = len(output); output.extend(f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]: output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(f"trailer << /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF".encode())
    return bytes(output)

def run():
    source = synthetic_pdf()
    jobs, completed, failures = {}, {}, {}
    mutex = threading.Lock()
    def fake_web(method, path, token, content=None):
        with mutex:
            job = jobs[token]
            if path == "config": return json.dumps({"method": job["method"], "encounterDate": "2025-03-01", "deadlineAt": "2099-01-01T00:00:00Z"}).encode(), "application/json"
            if path == "status": return json.dumps({"status": "completed" if token in completed else "running"}).encode(), "application/json"
            if path == "source": return job["source"], job["mime"]
            if path == "finish":
                result = json.loads(content)
                if result["sourceSha256"] != hashlib.sha256(job["source"]).hexdigest(): raise ValueError("source_mismatch")
                completed[token] = result; return b'{"ok":true}', "application/json"
            if path == "fail":
                failures[token] = json.loads(content or b"{}"); return b'{"ok":true}', "application/json"
            raise ValueError("unsupported")
    gateway.web = fake_web
    server = gateway.ThreadingHTTPServer(("0.0.0.0", 8080), gateway.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    scores = []
    with httpx.Client(base_url=gateway.private_url(os.environ["IGGY_URL"]), headers={"Authorization": "Bearer " + os.environ["IGGY_BEARER_TOKEN"]}, trust_env=False, follow_redirects=False, timeout=15) as client:
        if os.environ.get("EXTRACTION_TEST_RECOVERY") == "1":
            token = "whdoc1." + secrets.token_urlsafe(32); run_id = str(uuid.uuid4())
            jobs[token] = {"method": "native", "source": source, "mime": "application/pdf"}
            endpoint = os.environ["EXTRACTION_INFERENCE_URL"]
            os.environ["EXTRACTION_INFERENCE_URL"] = "http://127.0.0.1:1/v1"
            try:
                response = client.post("/v1/runs", json={"id": run_id, "profile": "health-chat/v1", "capability": token}); response.raise_for_status()
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    time.sleep(2)
                    state = client.get("/v1/runs/" + run_id).json()["status"]
                    if state in {"succeeded", "failed", "cancelled"}: break
                if token in completed or failures.get(token) != {"retryable": True}: raise ValueError("outage_not_retryable")
                scores.append({"test": "inference_outage", "retryable": True, "partial_completion": False})
            finally:
                os.environ["EXTRACTION_INFERENCE_URL"] = endpoint
                client.post("/v1/runs/" + run_id + "/cancel")
        for method in ("native", "tesseract"):
            token = "whdoc1." + secrets.token_urlsafe(32); run_id = str(uuid.uuid4())
            jobs[token] = {"method": method, "source": source, "mime": "application/pdf"}
            response = client.post("/v1/runs", json={"id": run_id, "profile": "health-chat/v1", "capability": token}); response.raise_for_status()
            try:
                deadline = time.monotonic() + 900
                while time.monotonic() < deadline:
                    time.sleep(2)
                    status = client.get("/v1/runs/" + run_id).json()["status"]
                    if status in ("succeeded", "failed", "cancelled"): break
                result = completed.get(token)
                if not result or status != "succeeded": raise ValueError("acceptance_failed")
                page = result["pages"][0]; text = page["redaction"]["text"]
                gold = "\n".join(LINES)
                expected_tokens = gold.lower().split(); actual_tokens = page["text"].lower().split()
                from collections import Counter
                common = sum((Counter(expected_tokens) & Counter(actual_tokens)).values())
                score = {"method": method, "token_precision": common / len(actual_tokens) if actual_tokens else 0, "token_recall": common / len(expected_tokens),
                         "name_removed": "Jane" not in text and "Example" not in text, "dob_removed": "1980" not in text, "id_removed": "ABC123" not in text,
                         "age_correct": result["ageAtEncounter"] == 44, "quantities_preserved": "100 mg/dL" in text and "13.5 g/dL" in text,
                         "summary_status": result["summaryStatus"], "measurements": len(result["measurements"]), "elapsed_ms": result["elapsedMs"],
                         "rules_spans": len(page["redaction"]["rules"]), "openmed_spans": len(page["redaction"]["openmed"]), "combined_spans": len(page["redaction"]["combined"])}
                gold_pii = {("NAME", "jane example"), ("DOB", "1980-06-20"), ("ID", "abc123")}
                for detector in ("rules", "openmed", "combined"):
                    spans = page["redaction"][detector]
                    surfaces = {(s["label"], page["text"][s["start"]:s["end"]].casefold()) for s in spans}
                    tp = len(surfaces & gold_pii)
                    score[detector + "_pii_recall"] = tp / len(gold_pii)
                    score[detector + "_pii_precision"] = tp / len(spans) if spans else None
                if not all(score[k] for k in ("name_removed", "dob_removed", "id_removed", "age_correct", "quantities_preserved")): raise ValueError("privacy_or_preservation_failed")
                if score["summary_status"] != "accepted" or score["measurements"] != 2: raise ValueError("local_inference_failed")
                scores.append(score)
            finally:
                try: client.post("/v1/runs/" + run_id + "/cancel")
                except Exception: pass
    Path("/state/synthetic-scores.json").write_text(json.dumps({"corpus": "synthetic-only/v1", "scores": scores}, indent=2))
    print(json.dumps({"corpus": "synthetic-only/v1", "scores": scores}), flush=True)
    server.shutdown()

if __name__ == "__main__":
    try: run()
    except Exception: raise SystemExit("synthetic_acceptance_failed") from None
