"""Synthetic transport, authorization, parsing and privacy tests; no model download."""
import base64
import io
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import httpx
from PIL import Image
import gateway
from parsers import parse
from unlimited_ocr_adapter import transcript
from unlimited_ocr_server import Runtime, Server, page_image, private_bind

FINGERPRINT = "a" * 64
MANIFEST = {"model": "baidu/Unlimited-OCR", "revision": "b" * 40, "fingerprint": FINGERPRINT,
            "torch": "synthetic", "transformers": "synthetic", "device": "synthetic", "policy": "synthetic/v1"}
TOKEN = "synthetic-credential-" + "x" * 32

def png():
    output = io.BytesIO()
    Image.new("RGB", (100, 100), "white").save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()

class UnlimitedOcrTests(unittest.TestCase):
    def test_transcript_preserves_numbers_and_tables_without_inventing_word_boxes(self):
        raw = '<|det|>text [10,20,200,40]<|/det|>Glucose 100 mg/dL\n<|det|>table [0,0,999,999]<|/det|><table><tr><th>Test</th><th>Value</th></tr><tr><td>Sodium</td><td>140 mmol/L</td></tr></table>'
        text, tables = transcript(raw)
        self.assertIn("Glucose 100 mg/dL", text)
        self.assertIn("140 mmol/L", text)
        self.assertNotIn("<|det|>", text)
        self.assertEqual(tables, [[["Test", "Value"], ["Sodium", "140 mmol/L"]]])
        self.assertEqual(transcript('<|det|>image [0,0,10,10]<|/det|>invented caption\n<|det|>text [1,2,3,4]<|/det|>Actual text')[0], "Actual text")

    def test_parser_routes_only_page_rasters_through_the_inference_callback(self):
        infer = Mock(return_value="Glucose 100 mg/dL")
        active = Mock()
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "synthetic.png"
            Image.new("RGB", (100, 100), "white").save(source)
            pages = parse(source, "image/png", "unlimitedocr", infer, active)
            source.write_text("Synthetic direct text")
            direct = parse(source, "text/plain", "unlimitedocr", infer, active)
        self.assertEqual(infer.call_count, 1)
        self.assertEqual(infer.call_args.args[0], "unlimitedocr")
        self.assertTrue(infer.call_args.args[1].startswith("data:image/png;base64,"))
        self.assertEqual(pages[0]["text"], "Glucose 100 mg/dL")
        self.assertEqual(pages[0]["words"], [])
        self.assertIsNone(pages[0]["foregroundCoverage"])
        self.assertEqual(pages[0]["diagnostics"]["textSource"], "unlimitedocr")
        self.assertEqual(direct[0]["text"], "Synthetic direct text")
        active.assert_called_once()

    def test_pixels_and_bind_address_are_bounded(self):
        with page_image(png()) as image: self.assertEqual(image.size, (100, 100))
        for value in ("https://example.com/private.png", "data:image/png;base64,invalid"):
            with self.assertRaises(ValueError): page_image(value)
        self.assertEqual(private_bind("127.0.0.1"), "127.0.0.1")
        self.assertEqual(private_bind("100.64.0.1"), "100.64.0.1")
        for value in ("0.0.0.0", "8.8.8.8", "224.0.0.1"):
            with self.assertRaises(ValueError): private_bind(value)

    def test_runtime_selects_the_configured_gpu_on_the_request_thread_and_keeps_pixels_in_memory(self):
        runtime = Runtime.__new__(Runtime)
        runtime.device = 1
        runtime.torch = SimpleNamespace(cuda=SimpleNamespace(set_device=Mock()))
        runtime.tokenizer = object()
        observed = []
        def infer(tokenizer, **kwargs):
            runtime.torch.cuda.set_device.assert_called_once_with(1)
            self.assertIsInstance(kwargs["image_file"], Image.Image)
            self.assertTrue(kwargs["eval_mode"])
            self.assertFalse(kwargs["save_results"])
            observed.extend(Path(kwargs["output_path"]).iterdir())
            return "Synthetic OCR"
        runtime.model = SimpleNamespace(infer=infer)
        with Image.new("RGB", (10, 10)) as image:
            self.assertEqual(runtime.transcribe(image), "Synthetic OCR")
        self.assertEqual(observed, [])

    def test_service_requires_auth_rejects_changed_models_and_never_echoes_errors(self):
        runtime = SimpleNamespace(manifest=MANIFEST, transcribe=Mock(return_value="Synthetic OCR 13.5 g/dL"))
        server = Server(("127.0.0.1", 0), runtime, TOKEN)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{server.server_port}", trust_env=False) as client:
                self.assertEqual(client.get("/ready").status_code, 401)
                headers = {"Authorization": "Bearer " + TOKEN}
                self.assertEqual(client.get("/ready", headers=headers).json(), {"manifest": MANIFEST})
                payload = {"image": png(), "fingerprint": FINGERPRINT}
                self.assertEqual(client.post("/ocr", json=payload).status_code, 401)
                self.assertEqual(client.post("/ocr", json={**payload, "fingerprint": "changed"}, headers=headers).status_code, 409)
                server.inference_lock.acquire()
                try: self.assertEqual(client.post("/ocr", json=payload, headers=headers).status_code, 503)
                finally: server.inference_lock.release()
                response = client.post("/ocr", json=payload, headers=headers)
                self.assertEqual(response.json(), {"text": "Synthetic OCR 13.5 g/dL", "fingerprint": FINGERPRINT})
                runtime.transcribe.side_effect = ValueError("private patient text must never escape")
                response = client.post("/ocr", json=payload, headers=headers)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json(), {"error": "ocr_failed"})
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def gateway_request(self, config=None, revoked=False, status=200):
        handler = gateway.Handler.__new__(gateway.Handler)
        body = json.dumps({"mode": "unlimitedocr", "content": {"image": png(), "fingerprint": FINGERPRINT}}).encode()
        handler.path, handler.command = "/infer", "POST"
        handler.headers = {"Authorization": "Bearer whdoc1.synthetic", "Content-Length": str(len(body))}
        handler.rfile, handler.respond = io.BytesIO(body), Mock()
        web = Mock(return_value=(json.dumps(config or {"method": "unlimitedocr"}).encode(), "application/json"))
        if revoked: web.side_effect = [(b'{"method":"unlimitedocr"}', "application/json"), ValueError("revoked")]
        requests = []
        def response(request):
            requests.append(request)
            return httpx.Response(status, json={"text": "Synthetic private OCR", "fingerprint": FINGERPRINT})
        client = httpx.Client(transport=httpx.MockTransport(response))
        with patch.object(gateway, "web", web), patch.object(gateway.httpx, "Client", return_value=client), patch.dict(os.environ, {"EXTRACTION_UNLIMITED_OCR_URL": "http://ocr.ts.net:8091", "EXTRACTION_UNLIMITED_OCR_KEY": TOKEN}):
            handler.handle_request()
        return handler.respond.call_args.args, requests

    def test_gateway_uses_separate_credentials_and_checks_revocation_after_inference(self):
        result, requests = self.gateway_request()
        self.assertEqual(result[0], 200)
        self.assertEqual(requests[0].headers["authorization"], "Bearer " + TOKEN)
        self.assertNotIn(b"whdoc1", requests[0].content)
        result, _ = self.gateway_request(revoked=True)
        self.assertEqual(result[0], 403)
        self.assertNotIn(b"Synthetic private OCR", result[1])
        result, requests = self.gateway_request(config={"method": "native"})
        self.assertEqual(result[0], 403); self.assertEqual(requests, [])
        result, _ = self.gateway_request(status=503)
        self.assertEqual(result[0], 503)

    def test_manifest_is_finite_and_contains_no_service_credentials(self):
        self.assertEqual(gateway.ocr_manifest(MANIFEST), MANIFEST)
        for value in ({**MANIFEST, "api_key": TOKEN}, {**MANIFEST, "fingerprint": "alias"}):
            with self.assertRaises(ValueError): gateway.ocr_manifest(value)

if __name__ == "__main__": unittest.main()
