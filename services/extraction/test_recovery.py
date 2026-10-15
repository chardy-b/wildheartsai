"""Synthetic outage tests. No model assets, source documents, or credentials required."""
from contextlib import nullcontext
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import httpx
import gateway


class RecoveryTests(unittest.TestCase):
    def test_gateway_distinguishes_outage_from_invalid_inference(self):
        for status, expected in [(503, 503), (429, 503), (401, 403)]:
            handler = gateway.Handler.__new__(gateway.Handler)
            body = json.dumps({"mode": "summary", "content": "Synthetic evidence"}).encode()
            handler.path, handler.command = "/infer", "POST"
            handler.headers = {"Authorization": "Bearer whdoc1.synthetic", "Content-Length": str(len(body))}
            handler.rfile, handler.respond = io.BytesIO(body), Mock()
            client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(status)))
            with patch.object(gateway, "web", return_value=(b"{}", "application/json")), patch.object(gateway, "SUMMARY_MODEL", "synthetic"), patch.object(gateway.httpx, "Client", return_value=client), patch.dict(os.environ, {"EXTRACTION_INFERENCE_URL": "http://llama-swap:8080/v1"}):
                handler.handle_request()
            self.assertEqual(handler.respond.call_args.args[0], expected)
            self.assertNotIn(b"Synthetic evidence", handler.respond.call_args.args[1])

    def test_readiness_does_not_require_a_document_grant(self):
        handler = gateway.Handler.__new__(gateway.Handler)
        handler.path, handler.command, handler.respond = "/ready", "GET", Mock()
        client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"data": []})))
        with patch.object(gateway.httpx, "Client", return_value=client), patch.dict(os.environ, {"EXTRACTION_INFERENCE_URL": "http://llama-swap:8080/v1"}):
            handler.handle_request()
        self.assertEqual(handler.respond.call_args.args, (200, b'{"ready":true}'))

    def test_worker_requeues_instead_of_finishing_partial_success(self):
        # Replace heavyweight parsing/privacy imports; exercise the real worker control flow.
        privacy = Mock()
        privacy.redact.return_value = {"rules": [], "openmed": [], "combined": [], "text": "Synthetic text"}
        fake_privacy = SimpleNamespace(LocalPrivacy=Mock(return_value=privacy), age_context=Mock(return_value=None))
        fake_parsers = SimpleNamespace(parse=Mock(return_value=[{"page": 1, "text": "Synthetic text"}]))
        spec = importlib.util.spec_from_file_location("recovery_worker", Path(__file__).with_name("worker.py"))
        worker = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"privacy": fake_privacy, "parsers": fake_parsers}): spec.loader.exec_module(worker)
        calls = []
        failures = []
        def request(method, path, **kwargs):
            calls.append((path, kwargs))
            if path == "/fail": failures.append(repr(sys.exception()))
            return httpx.Response(503 if path == "/infer" else 200, json={"method": "native"}, request=httpx.Request(method, "http://synthetic" + path))
        client = Mock()
        client.request.side_effect = request
        client.stream.return_value = nullcontext(httpx.Response(200, content=b"Synthetic text", headers={"content-type": "text/plain"}, request=httpx.Request("GET", "http://synthetic/source")))
        with patch.object(worker.httpx, "Client", return_value=client), patch.dict(os.environ, {"IGGY_BROKER_CAPABILITY": "whdoc1.synthetic", "IGGY_GATEWAY_URL": "http://wildhearts-extraction-gateway:8080"}):
            with self.assertRaises(SystemExit) as raised: worker.main()
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual([kwargs["json"] for path, kwargs in calls if path == "/fail"], [{"retryable": True}], failures)
        self.assertFalse(any(path == "/finish" for path, _ in calls))


if __name__ == "__main__": unittest.main()
