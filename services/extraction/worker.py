"""Iggy entry point: no stdout, no credentials beyond this execution grant."""
import hashlib
import importlib.metadata
import json
import os
import platform
from pathlib import Path
import tempfile
import time
import httpx
from parsers import parse
from privacy import LocalPrivacy, age_context
from inference import synthesize
from failures import failure_code, bounded_processing_retry
from auto_parser import parse_auto, POLICY

os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false", "OMP_NUM_THREADS": "1"})

class ServiceUnavailable(Exception): pass

def checked_request(client, method, path, **kwargs):
    try:
        response = client.request(method, path, **kwargs)
        if response.status_code in {408, 429} or response.status_code >= 500: raise ServiceUnavailable()
        response.raise_for_status()
        return response
    except httpx.TransportError:
        raise ServiceUnavailable() from None

def main():
    token = os.environ["IGGY_BROKER_CAPABILITY"]
    gateway = os.environ["IGGY_GATEWAY_URL"].rstrip("/")
    if not gateway.startswith("http://wildhearts-extraction-gateway:"): raise ValueError("invalid_gateway")
    client = httpx.Client(base_url=gateway, headers={"Authorization": "Bearer " + token}, follow_redirects=False, trust_env=False, timeout=180)
    def request(method, path, **kwargs):
        return checked_request(client, method, path, **kwargs)
    def check_active(): request("GET", "/config")
    def infer(mode, content):
        if mode == "unlimitedocr":
            content = {"image": content, "fingerprint": config["unlimitedOcrManifest"]["fingerprint"]}
        return request("POST", "/infer", json={"mode": mode, "content": content}).json()["text"]
    started = time.monotonic()
    stage = "source"
    config = {}
    try:
        config = request("GET", "/config").json()
        with tempfile.TemporaryDirectory(prefix="document-") as temp:
            source = Path(temp) / "source"
            sha = hashlib.sha256(); size = 0
            with client.stream("GET", "/source") as response:
                response.raise_for_status()
                mime = response.headers["content-type"].split(";")[0]
                extension = {"application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "text/plain": ".txt"}[mime]
                source = source.with_suffix(extension)
                with source.open("wb") as output:
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > 25 * 1024 * 1024: raise ValueError("size_limit")
                        sha.update(chunk); output.write(chunk)
            stage = "privacy"
            privacy = LocalPrivacy("/models/pii")
            stage = "parse"
            pages = parse_auto(source, mime, infer, check_active, (ServiceUnavailable, httpx.HTTPError)) if config.get("pipeline") == POLICY else parse(source, mime, config["method"], infer, check_active)
            stage = "privacy"
            identifiers, warnings = [], []
            if any(not p["text"].strip() for p in pages): warnings.append("pages_without_extracted_text")
            for page in pages:
                check_active()
                page["redaction"] = privacy.redact(page["text"])
                identifiers.extend(page["text"][s["start"]:s["end"]] for s in page["redaction"]["combined"])
                if "nativeAttempt" in page:
                    native = page["nativeAttempt"]
                    native["redaction"] = privacy.redact(native["text"])
                    identifiers.extend(native["text"][s["start"]:s["end"]] for s in native["redaction"]["combined"])
            age = age_context("\n".join(p["text"] for p in pages), config.get("encounterDate"))
            if age is None: warnings.append("age_omitted_without_unambiguous_iso_dob_and_encounter_date")
            stage = "inference"
            summary, measurements, summary_status, inference_warnings, inference_manifest = synthesize(pages,privacy,identifiers,age,infer,check_active,(ServiceUnavailable,))
            stage = "result"
            warnings.extend(inference_warnings)
            manifest = {p: importlib.metadata.version(p) for p in ("openmed", "torch", "transformers", "tokenizers", "pdfplumber", "pypdfium2", "pytesseract", "Pillow")}
            import pytesseract
            manifest.update({"python": platform.python_version(), "tesseract": str(pytesseract.get_tesseract_version())})
            if config["method"] == "docling": manifest["docling"] = importlib.metadata.version("docling")
            if config["method"] == "rapidocr":
                from rapid_adapter import HASHES
                manifest.update({"rapidocr":importlib.metadata.version("rapidocr"),"onnxruntime":importlib.metadata.version("onnxruntime"),"rapidocr_assets":json.dumps(HASHES,sort_keys=True)})
            if config["method"] == "unlimitedocr" and not mime.startswith("text/"):
                manifest.update({"unlimited_ocr_" + key: value for key, value in config["unlimitedOcrManifest"].items()})
            manifest.update({"worker": "document-extraction/v3", "worker_image": config.get("workerImage", "unrecorded"), "privacy_policy": "no-names-dob-to-age/v1", "pii_model": Path("/models/pii/REVISION").read_text().strip(), "summary_model": config["summaryModel"], "vision_model": config.get("visionModel", "disabled"),
                             "summary_model_revision": config.get("summaryModelRevision", "unknown-alias-only"), "vision_model_revision": config.get("visionModelRevision", "unknown-alias-only"), "source_mime": mime,
                             "parser_configuration": json.dumps({"render_scale_max":2.5,"max_pixels":20_000_000,"tesseract_psm":3,"foreground_threshold":220,"diagnostic_grid":20},sort_keys=True,separators=(',',':'))})
            if config.get("pipeline") == POLICY:
                manifest.update({"pipeline": POLICY, "fallback_policy": "scanLike-or-empty-with-ink-or-sparse-image-header32-or-image-header-under300-coverage-under0.35;Tesseract-psm3"})
            # Run-specific completion counts are provenance, not part of tool identity.
            manifest.update({k:v for k,v in inference_manifest.items() if k.startswith("inference_")})
            manifest["environment_fingerprint"] = hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            manifest.update(inference_manifest)
            if config.get("parentRunId"):
                manifest["parent_run_id"]=config["parentRunId"]
                manifest["requested_environment_fingerprint"]=config.get("expectedEnvironment","unknown")
                if config.get("expectedEnvironment") != manifest["environment_fingerprint"] or manifest["summary_model_revision"].startswith("unknown") or config["method"] == "vision" and manifest["vision_model_revision"].startswith("unknown"): warnings.append("rerun_environment_changed_or_unknown")
            result = {"version": 1, "sourceSha256": sha.hexdigest(), "method": config["method"], "manifest": manifest,
                      "elapsedMs": (time.monotonic() - started) * 1000, "pages": pages, "totalPages": len(pages),
                      "summary": summary, "summaryStatus": summary_status, "ageAtEncounter": age, "measurements": measurements, "warnings": list(dict.fromkeys(warnings))}
            encoded = json.dumps(result, ensure_ascii=False).encode()
            if len(encoded) > 2_500_000: raise ValueError("result_limit")
            check_active()
            stage = "completion"
            # Exact bytes are reused on retry; completed grants authorize only duplicate completion.
            for attempt in range(3):
                try:
                    request("POST", "/finish", content=encoded, headers={"Content-Type": "application/json"}); break
                except httpx.TransportError:
                    if attempt == 2: raise
                    time.sleep(1)
    except Exception as error:
        transient = isinstance(error, (ServiceUnavailable, httpx.TransportError)) or isinstance(error, httpx.HTTPStatusError) and (error.response.status_code in {408, 429} or error.response.status_code >= 500)
        code = failure_code(error, stage)
        if config.get("pipeline") == POLICY and bounded_processing_retry(code, config.get("attempt", 1)):
            transient = True
        try: request("POST", "/fail", json={"retryable": transient, "code": code})
        except Exception: pass
        raise SystemExit(1) from None
    finally: client.close()

if __name__ == "__main__": main()
