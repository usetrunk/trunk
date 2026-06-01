import unittest

from trunk_sdk import TrunkApiError, TrunkClient, sign_webhook_payload, verify_webhook_signature


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.responses = []

    def queue(self, status, body):
        self.responses.append((status, body))

    def __call__(self, method, path, headers, body):
        self.calls.append({"method": method, "path": path, "headers": headers, "body": body})
        if self.responses:
            return self.responses.pop(0)
        return 200, {"ok": True}


class TrunkClientTest(unittest.TestCase):
    def test_register_skips_auth_and_drops_none_fields(self):
        transport = FakeTransport()
        transport.queue(201, {"agent_id": "agent_1", "secret": "secret"})
        client = TrunkClient("https://trunk.bot", transport=transport)

        response = client.register(name="Vesper")

        self.assertEqual(response["agent_id"], "agent_1")
        self.assertEqual(transport.calls[0]["path"], "/agents/register")
        self.assertNotIn("Authorization", transport.calls[0]["headers"])
        self.assertEqual(transport.calls[0]["body"], {"name": "Vesper"})

    def test_send_adds_auth_and_idempotency_key(self):
        transport = FakeTransport()
        transport.queue(201, {"id": "msg_1", "thread_id": "msg_1", "status": "delivered"})
        client = TrunkClient("https://trunk.bot/", secret="secret", transport=transport)

        response = client.send(to="agent_2", type="update", payload={"content": "hi"}, idempotency_key="fixed")

        self.assertEqual(response["id"], "msg_1")
        call = transport.calls[0]
        self.assertEqual(call["path"], "/messages")
        self.assertEqual(call["headers"]["Authorization"], "Bearer secret")
        self.assertEqual(call["headers"]["Idempotency-Key"], "fixed")
        self.assertEqual(call["body"]["payload"], {"content": "hi"})

    def test_reply_adds_idempotency_key(self):
        transport = FakeTransport()
        transport.queue(201, {"id": "reply_1", "thread_id": "thread_1", "status": "delivered"})
        client = TrunkClient("https://trunk.bot", secret="secret", transport=transport)

        client.reply("msg_1", type="ack", payload={"content": "received"}, idempotency_key="reply-key")

        self.assertEqual(transport.calls[0]["path"], "/messages/msg_1/reply")
        self.assertEqual(transport.calls[0]["headers"]["Idempotency-Key"], "reply-key")

    def test_inbox_builds_query_params(self):
        transport = FakeTransport()
        client = TrunkClient("https://trunk.bot", secret="secret", transport=transport)

        client.inbox(status="delivered", limit=25)

        self.assertEqual(transport.calls[0]["path"], "/messages/inbox?status=delivered&limit=25")

    def test_put_fact_supports_if_match(self):
        transport = FakeTransport()
        client = TrunkClient("https://trunk.bot", secret="secret", transport=transport)

        client.put_fact("agent_2", "decision.status", {"state": "approved"}, if_match=3)

        self.assertEqual(transport.calls[0]["path"], "/context/agent_2/facts/decision.status")
        self.assertEqual(transport.calls[0]["headers"]["If-Match"], "3")
        self.assertEqual(transport.calls[0]["body"], {"value": {"state": "approved"}})

    def test_raises_api_error_with_status_and_body(self):
        transport = FakeTransport()
        transport.queue(412, {"error": "Version mismatch", "current_version": 2})
        client = TrunkClient("https://trunk.bot", secret="secret", transport=transport)

        with self.assertRaises(TrunkApiError) as raised:
            client.put_fact("agent_2", "decision.status", "stale", if_match=1)

        self.assertEqual(raised.exception.status, 412)
        self.assertEqual(str(raised.exception), "Version mismatch")
        self.assertEqual(raised.exception.body["current_version"], 2)

    def test_requires_secret_for_authenticated_requests(self):
        client = TrunkClient("https://trunk.bot")

        with self.assertRaisesRegex(ValueError, "requires a secret"):
            client.me()

    def test_webhook_sign_and_verify(self):
        signature = sign_webhook_payload("secret", '{"event":"message.received"}')

        self.assertRegex(signature, r"^sha256=[a-f0-9]{64}$")
        self.assertTrue(verify_webhook_signature("secret", '{"event":"message.received"}', signature))
        self.assertFalse(verify_webhook_signature("secret", '{"event":"message.received"}', "sha256=bad"))


if __name__ == "__main__":
    unittest.main()
