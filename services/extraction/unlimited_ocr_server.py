"""Private, authenticated GPU OCR service. Receives queue-rendered pages only."""
import base64
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import ipaddress
import json
import os
from pathlib import Path
import socket
import tempfile
import threading

from prepare_unlimited_ocr import MODEL, POLICY, digest, verified

MAX_BODY = 12 * 1024 * 1024
MAX_OUTPUT = 100_000
MAX_TOKENS = 8192
TIMEOUT = 120

def page_image(value):
    from PIL import Image
    prefix = "data:image/png;base64,"
    if not isinstance(value, str) or not value.startswith(prefix) or len(value) > MAX_BODY:
        raise ValueError("invalid_image")
    data = base64.b64decode(value[len(prefix):], validate=True)
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "PNG" or not 0 < image.width <= 1800 or not 0 < image.height <= 1800:
            raise ValueError("pixel_limit")
        return image.convert("RGB")

def private_bind(value):
    address = ipaddress.ip_address(value)
    if address.is_unspecified or address.is_multicast or not (address.is_private or address in ipaddress.ip_network("100.64.0.0/10")):
        raise ValueError("private_bind_required")
    return value

class Runtime:
    def __init__(self, target, device):
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                          TOKENIZERS_PARALLELISM="false", HF_HOME=str(target / ".runtime-cache"))
        prepared = verified(target)
        import torch
        from transformers import AutoModel, AutoTokenizer
        if not torch.cuda.is_available(): raise ValueError("gpu_unavailable")
        torch.cuda.set_device(device)
        # Check the actual driver/device before loading the full checkpoint.
        probe = torch.ones((32, 32), device="cuda", dtype=torch.bfloat16)
        if float((probe @ probe)[0, 0]) != 32: raise ValueError("gpu_math_failed")
        self.tokenizer = AutoTokenizer.from_pretrained(target, trust_remote_code=True, local_files_only=True)
        self.model = AutoModel.from_pretrained(target, trust_remote_code=True, local_files_only=True,
                                              use_safetensors=True, dtype=torch.bfloat16,
                                              attn_implementation="eager").eval().cuda()
        self.torch, self.device = torch, device
        # The checkpoint sets max_new_tokens=32768, which overrides max_length.
        # Bound generation explicitly and fail on any unterminated output.
        generate = self.model.generate
        def bounded_generate(**kwargs):
            kwargs.update(max_new_tokens=MAX_TOKENS, max_time=TIMEOUT,
                          attention_mask=torch.ones_like(kwargs["input_ids"]),
                          pad_token_id=self.tokenizer.eos_token_id)
            result = generate(**kwargs)
            if result[0, -1].item() != self.tokenizer.eos_token_id:
                if result.shape[-1] - kwargs["input_ids"].shape[-1] >= MAX_TOKENS: raise ValueError("text_limit")
                raise TimeoutError("ocr_timeout")
            return result
        self.model.generate = bounded_generate
        identity = {"prepared": prepared, "runtime_sha256": digest(Path(__file__)),
                    "torch": torch.__version__, "transformers": __import__("transformers").__version__,
                    "device": torch.cuda.get_device_name(device), "max_tokens": MAX_TOKENS, "timeout": TIMEOUT}
        self.manifest = {"model": MODEL, "revision": prepared["revision"], "policy": POLICY,
                         "torch": identity["torch"], "transformers": identity["transformers"], "device": identity["device"],
                         "fingerprint": hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()}

    def transcribe(self, image):
        # CUDA/ROCm's current device is thread-local; HTTP handlers execute on
        # different threads from model loading, including on multi-GPU hosts.
        self.torch.cuda.set_device(self.device)
        # Only empty helper directories exist on disk. Pixels and transcripts
        # remain in RAM; the isolated worker owns source/result custody.
        with tempfile.TemporaryDirectory(prefix="ocr-empty-") as scratch:
            text = self.model.infer(self.tokenizer, prompt="<image>document parsing.", image_file=image,
                                    output_path=scratch, base_size=1024, image_size=640, crop_mode=True,
                                    max_length=32768, no_repeat_ngram_size=35, ngram_window=128,
                                    save_results=False, eval_mode=True)
        if not isinstance(text, str) or len(text) > MAX_OUTPUT: raise ValueError("text_limit")
        return text

class Server(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, runtime, credential):
        self.runtime, self.credential, self.inference_lock = runtime, credential, threading.Lock()
        super().__init__(address, Handler)
    def handle_error(self, request, client_address): pass

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def setup(self):
        super().setup(); self.connection.settimeout(30)
    def respond(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close"); self.end_headers(); self.wfile.write(data)
        self.close_connection = True
    def authorized(self):
        return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.credential)
    def do_GET(self):
        if not self.authorized(): return self.respond(401, {"error": "unauthorized"})
        if self.path != "/ready": return self.respond(404, {"error": "not_found"})
        self.respond(200, {"manifest": self.server.runtime.manifest})
    def do_POST(self):
        if not self.authorized(): return self.respond(401, {"error": "unauthorized"})
        if self.path != "/ocr": return self.respond(404, {"error": "not_found"})
        image = None
        try:
            if self.headers.get("Transfer-Encoding"): raise ValueError("invalid_body")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_BODY: return self.respond(413, {"error": "request_limit"})
            raw = self.rfile.read(size)
            if len(raw) != size: raise ValueError("invalid_body")
            value = json.loads(raw)
            if not isinstance(value, dict) or set(value) != {"image", "fingerprint"}: raise ValueError("invalid_body")
            if value["fingerprint"] != self.server.runtime.manifest["fingerprint"]:
                return self.respond(409, {"error": "model_changed"})
            image = page_image(value["image"])
        except Exception:
            return self.respond(422, {"error": "invalid_input"})
        try:
            if not self.server.inference_lock.acquire(blocking=False): return self.respond(503, {"error": "busy"})
            try:
                text = self.server.runtime.transcribe(image)
                self.respond(200, {"text": text, "fingerprint": self.server.runtime.manifest["fingerprint"]})
            finally:
                self.server.inference_lock.release()
        except Exception:
            self.respond(422, {"error": "ocr_failed"})
        finally:
            image.close()

def main():
    credential = Path(os.environ["UNLIMITED_OCR_TOKEN_FILE"]).read_text().strip()
    if len(credential) < 32: raise ValueError("invalid_credential")
    host = private_bind(os.environ.get("UNLIMITED_OCR_HOST", "127.0.0.1"))
    # OS-level stdout/stderr suppression also covers native model libraries and
    # logging handlers created before inference. No private exception text escapes.
    with open(os.devnull, "w") as sink:
        os.dup2(sink.fileno(), 1); os.dup2(sink.fileno(), 2)
        with redirect_stdout(sink), redirect_stderr(sink):
            runtime = Runtime(Path(os.environ["UNLIMITED_OCR_MODEL_DIR"]).resolve(), int(os.environ.get("UNLIMITED_OCR_DEVICE", "0")))
            def deny_outbound(*args, **kwargs): raise RuntimeError("offline_runtime")
            socket.socket.connect = deny_outbound
            socket.create_connection = deny_outbound
            Server((host, int(os.environ.get("UNLIMITED_OCR_PORT", "8091"))), runtime, credential).serve_forever()

if __name__ == "__main__":
    try: main()
    except Exception: raise SystemExit(1) from None
