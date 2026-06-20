import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

// Use vi.hoisted so env vars are set before ANY module imports
const TEST_SIGNING_SECRET = "test_slack_signing_secret";
const TEST_BOT_TOKEN = "xoxb-test-token";
const TEST_AGENT_SECRET = "test-trunk-secret";
const TEST_RELAY_URL = "https://mock-relay.test";

vi.hoisted(() => {
  process.env.SLACK_SIGNING_SECRET = "test_slack_signing_secret";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  process.env.TRUNK_AGENT_SECRET = "test-trunk-secret";
  process.env.TRUNK_RELAY_URL = "https://mock-relay.test";
  process.env.SLACK_CHANNEL_AGENT_MAP = JSON.stringify({
    C_GENERAL: "agent-general",
    C_SUPPORT: "agent-support",
    "C_GENERAL:1710000.0001": "agent-thread-override",
  });
});

// Mock global fetch to prevent real HTTP calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Now import — adapter reads env vars at module scope
import { handleSlackEvent, handleTrunkWebhook, resolveSlackTarget } from "../adapters/slack/index.js";

function currentTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function signSlackRequest(body: string, timestamp: string, secret = TEST_SIGNING_SECRET): string {
  const baseString = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", secret).update(baseString).digest("hex")}`;
}

function slackRequest(body: string, timestamp?: string, signature?: string): Request {
  const ts = timestamp || currentTimestamp();
  const sig = signature || signSlackRequest(body, ts);
  return new Request("https://example.com/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": sig,
    },
    body,
  });
}

function trunkWebhookRequest(payload: Record<string, unknown>): Request {
  return new Request("https://example.com/slack/trunk-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("Slack adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: fetch succeeds for Trunk API sends
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  // --- Replay protection ---

  describe("replay protection", () => {
    it("rejects requests with timestamps older than 5 minutes", async () => {
      const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301); // 5 min + 1 sec ago
      const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
      const sig = signSlackRequest(body, staleTimestamp);
      const req = slackRequest(body, staleTimestamp, sig);
      const res = await handleSlackEvent(req);

      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Request too old");
    });

    it("accepts requests with timestamps within 5 minutes", async () => {
      const freshTimestamp = String(Math.floor(Date.now() / 1000) - 120); // 2 min ago
      const body = JSON.stringify({ type: "url_verification", challenge: "fresh" });
      const sig = signSlackRequest(body, freshTimestamp);
      const req = slackRequest(body, freshTimestamp, sig);
      const res = await handleSlackEvent(req);

      expect(res.status).toBe(200);
    });

    it("rejects requests with non-numeric timestamps", async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
      const req = slackRequest(body, "not-a-number", "v0=anything");
      const res = await handleSlackEvent(req);

      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Request too old");
    });

    it("rejects requests with missing timestamp header", async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
      const req = new Request("https://example.com/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Signature": "v0=anything",
        },
        body,
      });
      const res = await handleSlackEvent(req);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Request too old");
    });
  });

  // --- Signature verification ---

  describe("signature verification", () => {
    it("rejects requests with invalid signature", async () => {
      const ts = currentTimestamp();
      const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
      const req = slackRequest(body, ts, "v0=invalid_signature_here");
      const res = await handleSlackEvent(req);

      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Invalid signature");
    });

    it("rejects requests with wrong signing secret", async () => {
      const ts = currentTimestamp();
      const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
      const sig = signSlackRequest(body, ts, "wrong_secret");
      const req = slackRequest(body, ts, sig);
      const res = await handleSlackEvent(req);

      expect(res.status).toBe(401);
    });

    it("accepts requests with valid signature", async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "test123" });
      const req = slackRequest(body);
      const res = await handleSlackEvent(req);

      expect(res.status).toBe(200);
    });
  });

  // --- URL verification challenge ---

  describe("URL verification", () => {
    it("responds with challenge for url_verification events", async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
      const req = slackRequest(body);
      const res = await handleSlackEvent(req);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
    });

    it("returns JSON content-type for challenge response", async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
      const req = slackRequest(body);
      const res = await handleSlackEvent(req);

      expect(res.headers.get("Content-Type")).toBe("application/json");
    });
  });

  // --- app_mention events ---

  describe("app_mention events", () => {
    it("sends message to Trunk when mentioned in a mapped channel", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-1", thread_id: "thread-1", status: "pending" }), { status: 200 }),
      );

      const body = JSON.stringify({
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@U123BOT> What is the status?",
          channel: "C_GENERAL",
          ts: "1710000.0002",
          thread_ts: "1710000.0001",
        },
      });
      const req = slackRequest(body);
      const res = await handleSlackEvent(req);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");

      // Should have called trunkSend (fetch to relay)
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${TEST_RELAY_URL}/messages`);
      expect(opts.method).toBe("POST");
      const sentBody = JSON.parse(opts.body);
      // Thread override should resolve to agent-thread-override
      expect(sentBody.to).toBe("agent-thread-override");
      expect(sentBody.type).toBe("question");
      expect(sentBody.payload.content).toBe("What is the status?");
      expect(sentBody.payload.source).toBe("slack");
    });

    it("strips bot mention from message text", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-2", thread_id: "thread-2", status: "pending" }), { status: 200 }),
      );

      const body = JSON.stringify({
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@UBOT123> <@UOTHER> hello there",
          channel: "C_SUPPORT",
          ts: "1710000.0005",
        },
      });
      const req = slackRequest(body);
      await handleSlackEvent(req);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.payload.content).toBe("hello there");
    });

    it("falls back to channel mapping when no thread override exists", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-3", thread_id: "thread-3", status: "pending" }), { status: 200 }),
      );

      const body = JSON.stringify({
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@UBOT> help",
          channel: "C_SUPPORT",
          ts: "1710099.0001",
        },
      });
      const req = slackRequest(body);
      await handleSlackEvent(req);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.to).toBe("agent-support");
    });

    it("does not call Trunk API when channel has no mapping", async () => {
      const body = JSON.stringify({
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@UBOT> hello",
          channel: "C_UNMAPPED",
          ts: "1710099.0002",
        },
      });
      const req = slackRequest(body);
      const res = await handleSlackEvent(req);

      expect(res.status).toBe(200);
      // resolveSlackTarget returns "" for unmapped, so trunkSend is NOT called
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("uses ts as thread_ts when thread_ts is absent (new thread)", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-4", thread_id: "thread-4", status: "pending" }), { status: 200 }),
      );

      const body = JSON.stringify({
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@UBOT> start a new thread",
          channel: "C_GENERAL",
          ts: "1720000.0001",
        },
      });
      const req = slackRequest(body);
      await handleSlackEvent(req);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.to).toBe("agent-general");
    });

    it("includes authorization header when sending to Trunk", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-5", thread_id: "thread-5", status: "pending" }), { status: 200 }),
      );

      const body = JSON.stringify({
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@UBOT> check auth",
          channel: "C_GENERAL",
          ts: "1720000.0002",
        },
      });
      const req = slackRequest(body);
      await handleSlackEvent(req);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headerValue(headers, "Authorization")).toBe(`Bearer ${TEST_AGENT_SECRET}`);
      expect(headerValue(headers, "Idempotency-Key")).toBeDefined();
    });

    it("handles Trunk API failure gracefully", async () => {
      mockFetch.mockResolvedValueOnce(new Response("error", { status: 500 }));

      const body = JSON.stringify({
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@UBOT> test failure",
          channel: "C_GENERAL",
          ts: "1720000.0003",
        },
      });
      const req = slackRequest(body);
      const res = await handleSlackEvent(req);

      // Should still return ok to Slack (don't retry)
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    });
  });

  // --- Unhandled event types ---

  describe("unhandled events", () => {
    it("returns ok for unrecognized event types", async () => {
      const body = JSON.stringify({
        type: "event_callback",
        event: { type: "message", text: "not a mention" },
      });
      const req = slackRequest(body);
      const res = await handleSlackEvent(req);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // --- Trunk webhook handler (Trunk → Slack) ---

  describe("handleTrunkWebhook", () => {
    it("posts to Slack when thread mapping exists", async () => {
      // First, create a thread mapping by sending an app_mention
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-10", thread_id: "trunk-thread-10", status: "pending" }), { status: 200 }),
      );

      const mentionBody = JSON.stringify({
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@UBOT> setup thread",
          channel: "C_GENERAL",
          ts: "1730000.0001",
          thread_ts: "1730000.0001",
        },
      });
      await handleSlackEvent(slackRequest(mentionBody));
      mockFetch.mockClear();

      // Now simulate Trunk webhook delivery
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // slackPost
        .mockResolvedValueOnce(new Response("ok", { status: 200 })); // trunkAck

      const webhookReq = trunkWebhookRequest({
        event: "message.received",
        message: {
          id: "msg-reply-10",
          payload: { content: "Here is the answer" },
          threadId: "trunk-thread-10",
        },
      });
      const res = await handleTrunkWebhook(webhookReq);

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // First call: slackPost
      const [slackUrl, slackOpts] = mockFetch.mock.calls[0];
      expect(slackUrl).toBe("https://slack.com/api/chat.postMessage");
      const slackBody = JSON.parse(slackOpts.body);
      expect(slackBody.channel).toBe("C_GENERAL");
      expect(slackBody.text).toContain("Here is the answer");
      expect(slackBody.text).toContain("Trunk");
      expect(slackBody.thread_ts).toBe("1730000.0001");
      expect(slackOpts.headers["Authorization"]).toBe(`Bearer ${TEST_BOT_TOKEN}`);

      // Second call: trunkAck
      const [ackUrl, ackOpts] = mockFetch.mock.calls[1];
      expect(ackUrl).toBe(`${TEST_RELAY_URL}/messages/msg-reply-10/ack`);
      expect(ackOpts.method).toBe("POST");
    });

    it("skips delivery when no thread mapping exists", async () => {
      const webhookReq = trunkWebhookRequest({
        event: "message.received",
        message: {
          id: "msg-orphan",
          payload: { content: "No thread match" },
          threadId: "unknown-trunk-thread",
        },
      });
      const res = await handleTrunkWebhook(webhookReq);

      expect(res.status).toBe(200);
      // No slackPost or trunkAck calls
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("uses (no content) fallback when payload.content is empty", async () => {
      // Set up thread mapping
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-20", thread_id: "trunk-thread-20", status: "pending" }), { status: 200 }),
      );
      const mentionBody = JSON.stringify({
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@UBOT> setup",
          channel: "C_SUPPORT",
          ts: "1740000.0001",
          thread_ts: "1740000.0001",
        },
      });
      await handleSlackEvent(slackRequest(mentionBody));
      mockFetch.mockClear();

      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      const webhookReq = trunkWebhookRequest({
        event: "message.received",
        message: {
          id: "msg-empty",
          payload: {},
          threadId: "trunk-thread-20",
        },
      });
      await handleTrunkWebhook(webhookReq);

      const slackBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(slackBody.text).toContain("(no content)");
    });

    it("ignores non-message.received events", async () => {
      const webhookReq = trunkWebhookRequest({
        event: "message.delivered",
        message: {
          id: "msg-other",
          payload: { content: "delivered" },
          threadId: "some-thread",
        },
      });
      const res = await handleTrunkWebhook(webhookReq);

      expect(res.status).toBe(200);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Trunk webhook signature verification", () => {
    it("rejects requests with invalid signature when TRUNK_WEBHOOK_SECRET is set", async () => {
      // Temporarily set the webhook secret
      const origSecret = process.env.TRUNK_WEBHOOK_SECRET;
      process.env.TRUNK_WEBHOOK_SECRET = "test-webhook-secret";

      // Re-import to pick up the new env var
      vi.resetModules();
      const { handleTrunkWebhook: freshHandler } = await import("../adapters/slack/index.js");

      const webhookReq = new Request("https://example.com/slack/trunk-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Trunk-Signature": "sha256=invalid_signature",
        },
        body: JSON.stringify({
          event: "message.received",
          message: { id: "msg-1", payload: { content: "test" }, threadId: "t-1" },
        }),
      });

      const res = await freshHandler(webhookReq);
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("Invalid Trunk webhook signature");

      // Restore
      process.env.TRUNK_WEBHOOK_SECRET = origSecret || "";
      vi.resetModules();
    });

    it("rejects requests with missing signature when TRUNK_WEBHOOK_SECRET is set", async () => {
      const origSecret = process.env.TRUNK_WEBHOOK_SECRET;
      process.env.TRUNK_WEBHOOK_SECRET = "test-webhook-secret";
      vi.resetModules();
      const { handleTrunkWebhook: freshHandler } = await import("../adapters/slack/index.js");

      const webhookReq = new Request("https://example.com/slack/trunk-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "message.received",
          message: { id: "msg-1", payload: { content: "test" }, threadId: "t-1" },
        }),
      });

      const res = await freshHandler(webhookReq);
      expect(res.status).toBe(401);

      process.env.TRUNK_WEBHOOK_SECRET = origSecret || "";
      vi.resetModules();
    });
  });

  // --- resolveSlackTarget ---

  describe("resolveSlackTarget", () => {
    const map = {
      C1: "agent-1",
      C2: "agent-2",
      "C1:1710.0001": "agent-thread-1",
    };

    it("resolves thread-level mapping over channel", () => {
      expect(resolveSlackTarget("C1", "1710.0001", map)).toBe("agent-thread-1");
    });

    it("falls back to channel mapping", () => {
      expect(resolveSlackTarget("C1", "1799.9999", map)).toBe("agent-1");
    });

    it("returns empty string for unmapped channel", () => {
      expect(resolveSlackTarget("C_UNKNOWN", undefined, map)).toBe("");
    });

    it("returns channel mapping when no threadTs provided", () => {
      expect(resolveSlackTarget("C2", undefined, map)).toBe("agent-2");
    });
  });

  // --- parseJsonMap (tested indirectly through env var) ---

  describe("channel map parsing", () => {
    it("module loaded channel map from SLACK_CHANNEL_AGENT_MAP env var", async () => {
      expect(resolveSlackTarget("C_GENERAL", undefined)).toBe("agent-general");
      expect(resolveSlackTarget("C_SUPPORT", undefined)).toBe("agent-support");
      expect(resolveSlackTarget("C_GENERAL", "1710000.0001")).toBe("agent-thread-override");
    });
  });
});

function headerValue(headers: HeadersInit, name: string): string | null {
  return headers instanceof Headers ? headers.get(name) : (headers as Record<string, string>)[name] ?? null;
}
