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
    def test_attempt_ids_are_stable_for_restart_but_change_on_retry(self):
        def respond(request):
            return httpx.Response(404 if request.method == 'GET' else 201)
        run={'id':'11111111-1111-4111-8111-111111111111','capability':'whdoc1.synthetic-attempt-1'}
        with httpx.Client(transport=httpx.MockTransport(respond)) as client:
            first=gateway.ensure_execution(client,'http://iggy',run)
            again=gateway.ensure_execution(client,'http://iggy',run)
            second=gateway.ensure_execution(client,'http://iggy',{**run,'capability':'whdoc1.synthetic-attempt-2'})
        self.assertEqual(first,again); self.assertNotEqual(first,second)
        self.assertNotIn('synthetic',first)

    def test_lost_start_reply_reconnects_without_duplicate_execution(self):
        started=[]
        def respond(request):
            if request.method == 'GET': return httpx.Response(200,json={'status':'running'}) if started else httpx.Response(404)
            started.append(json.loads(request.content)['id']); raise httpx.ReadTimeout('synthetic',request=request)
        with httpx.Client(transport=httpx.MockTransport(respond)) as client:
            execution=gateway.ensure_execution(client,'http://iggy',{'id':'11111111-1111-4111-8111-111111111111','capability':'synthetic'})
        self.assertEqual(started,[execution])

    def test_upgrade_resumes_legacy_active_worker(self):
        run={'id':'11111111-1111-4111-8111-111111111111','capability':'synthetic','resumed':True}
        with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'status':'running'}))) as client:
            self.assertEqual(gateway.ensure_execution(client,'http://iggy',run),run['id'])

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
