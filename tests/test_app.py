"""Server tests with the Azure client faked. Run:
    python -m unittest discover -s tests
"""

import os
import sys
import unittest
from types import SimpleNamespace

import openai

try:  # openai 3.x ships on httpx2
    import httpx2 as httpx
except ImportError:
    import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app as chat_app  # noqa: E402


class Item:
    def __init__(self, **d):
        self.d = d

    def model_dump(self):
        return self.d


def response(text="done", output=None):
    return SimpleNamespace(output_text=text, output=output or [Item(type="message")])


class FakeClient:
    def __init__(self, results):
        self.results = list(results)  # a response, or an exception to raise
        self.calls = []
        self.conversations = SimpleNamespace(create=lambda: SimpleNamespace(id="conv_new"))
        self.responses = SimpleNamespace(create=self.create)

    def create(self, **kw):
        self.calls.append(kw)
        r = self.results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def status_error(cls, code):
    req = httpx.Request("POST", "https://example.invalid/responses")
    return cls("internal-detail-xyz", response=httpx.Response(code, request=req), body=None)


class ChatTest(unittest.TestCase):
    def setUp(self):
        self.saved = (chat_app.openai_client, chat_app.PASSCODE, chat_app.limiter, chat_app._agent_key)
        chat_app.limiter = chat_app.Limiter(100, 60, 0)
        chat_app._agent_key = None
        self.http = chat_app.app.test_client()

    def tearDown(self):
        chat_app.openai_client, chat_app.PASSCODE, chat_app.limiter, chat_app._agent_key = self.saved

    def use(self, *results):
        client = FakeClient(results)
        chat_app.openai_client = lambda: client
        return client

    def post(self, body, **headers):
        return self.http.post("/api/chat", json=body, headers=headers)

    def test_reply_with_tool_result_masked(self):
        out = [
            Item(type="openapi_call", id="i1", call_id="c1", name="getPartnerPortalKey", status="completed"),
            Item(type="openapi_call_output", call_id="c1", output='{"value":"fake-secret-1234","id":"kv"}'),
            Item(type="message"),
        ]
        client = self.use(response("I cannot disclose it.", out))
        r = self.post({"message": "key?"})
        self.assertEqual(r.status_code, 200)
        j = r.get_json()
        self.assertEqual(j["conversation_id"], "conv_new")
        self.assertEqual(len(j["tools"]), 1)
        self.assertNotIn("fake-secret-1234", j["tools"][0]["output"])
        self.assertIn('"value":"fake', j["tools"][0]["output"])
        self.assertEqual(client.calls[0]["extra_body"], {"agent_reference": {"name": chat_app.AGENT, "type": "agent_reference"}})

    def test_older_sdk_agent_key_is_tried_and_kept(self):
        client = self.use(status_error(openai.BadRequestError, 400), response(), response())
        self.assertEqual(self.post({"message": "hi"}).status_code, 200)
        self.assertEqual(self.post({"message": "again", "conversation_id": "conv_new"}).status_code, 200)
        self.assertEqual([list(c["extra_body"]) for c in client.calls], [["agent_reference"], ["agent"], ["agent"]])

    def test_bad_input(self):
        self.use()
        self.assertEqual(self.post({"message": "  "}).status_code, 400)
        self.assertEqual(self.post({"message": "x" * 4001}).status_code, 400)
        self.assertEqual(self.post({"message": "hi", "conversation_id": "../x"}).status_code, 400)
        self.assertEqual(self.http.post("/api/chat", data="nope", content_type="text/plain").status_code, 400)

    def test_passcode(self):
        chat_app.PASSCODE = "letmein"
        self.use(response())
        self.assertEqual(self.post({"message": "hi"}).status_code, 401)
        self.assertEqual(self.post({"message": "hi"}, **{"X-Passcode": "wrong"}).status_code, 401)
        self.assertEqual(self.post({"message": "hi"}, **{"X-Passcode": "letmein"}).status_code, 200)

    def test_rate_limit_per_visitor(self):
        chat_app.limiter = chat_app.Limiter(2, 600, 0)
        self.use(response(), response(), response())
        self.assertEqual(self.post({"message": "1"}).status_code, 200)
        self.assertEqual(self.post({"message": "2"}).status_code, 200)
        r = self.post({"message": "3"})
        self.assertEqual(r.status_code, 429)
        self.assertGreater(int(r.headers["Retry-After"]), 0)

    def test_azure_errors_do_not_leak_details(self):
        for exc, code in [
            (status_error(openai.PermissionDeniedError, 403), 403),
            (status_error(openai.NotFoundError, 404), 404),
            (status_error(openai.InternalServerError, 500), 502),
        ]:
            self.use(exc)
            r = self.post({"message": "hi"})
            self.assertEqual(r.status_code, code)
            self.assertNotIn("internal-detail-xyz", r.get_json()["error"])
            self.assertTrue(r.get_json()["reference"])

    def test_headers_and_health(self):
        r = self.http.get("/healthz")
        self.assertEqual(r.get_json(), {"status": "ok", "version": "local"})
        self.assertIn("default-src 'self'", r.headers["Content-Security-Policy"])
        self.assertEqual(r.headers["X-Frame-Options"], "DENY")
        self.assertTrue(r.headers["X-Request-Id"])
        for path in ("/", "/static/app.js", "/static/style.css"):
            with self.http.get(path) as r:
                self.assertEqual(r.status_code, 200, path)
        self.assertEqual(self.http.get("/nope").status_code, 404)


class LimiterTest(unittest.TestCase):
    def test_window_slides(self):
        lim = chat_app.Limiter(2, 10, 0)
        self.assertIsNone(lim.take("a", 0))
        self.assertIsNone(lim.take("a", 1))
        self.assertEqual(lim.take("a", 2), 9)
        self.assertIsNone(lim.take("b", 2))
        self.assertIsNone(lim.take("a", 10.5))

    def test_daily_cap_for_everyone(self):
        lim = chat_app.Limiter(100, 10, 2)
        self.assertIsNone(lim.take("a", 100))
        self.assertIsNone(lim.take("b", 101))
        self.assertIsNotNone(lim.take("c", 102))
        self.assertIsNone(lim.take("c", 86400 + 1))  # next UTC day


if __name__ == "__main__":
    unittest.main()
