import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.TRUNK_AGENT_SECRET = "test-trunk-secret";
  process.env.TRUNK_RELAY_URL = "https://mock-relay.test";
  process.env.FROM_EMAIL = "agent@test.trunk.bot";
  process.env.AGENT_PAIRING_CODE = "TESTCODE";
  process.env.SENDGRID_API_KEY = "sg-test-key";
  process.env.EMAIL_AGENT_MAP = JSON.stringify({
    "support@example.com": "agent-support",
    "sales@example.com": "agent-sales",
  });
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  handleInboundEmail,
  handleTrunkWebhook,
  resolveTargetAgent,
  type InboundEmail,
} from "../adapters/email/index.js";

function trunkWebhookRequest(payload: Record<string, unknown>): Request {
  return new Request("https://example.com/trunk-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function makeEmail(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    from: "customer@example.com",
    to: "support@example.com",
    subject: "Help with my order",
    text: "I need help with order #12345",
    messageId: `<msg-${Date.now()}@example.com>`,
    ...overrides,
  };
}

describe("Email adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  // --- resolveTargetAgent ---

  describe("resolveTargetAgent", () => {
    it("uses override when provided", () => {
      expect(resolveTargetAgent("support@example.com", "override-agent")).toBe("override-agent");
    });

    it("resolves from agent map when no override", () => {
      expect(resolveTargetAgent("support@example.com", null, {
        "support@example.com": "agent-support",
      })).toBe("agent-support");
    });

    it("normalizes email addresses (case insensitive)", () => {
      expect(resolveTargetAgent("Support@Example.COM", null, {
        "support@example.com": "agent-support",
      })).toBe("agent-support");
    });

    it("extracts email from angle bracket format", () => {
      expect(resolveTargetAgent("Support <Support@Example.com>", null, {
        "support@example.com": "agent-support",
      })).toBe("agent-support");
    });

    it("returns empty string for unmapped addresses", () => {
      expect(resolveTargetAgent("unknown@example.com", null, {
        "support@example.com": "agent-support",
      })).toBe("");
    });

    it("returns empty string when override is null and address is unmapped", () => {
      expect(resolveTargetAgent("nope@example.com", null)).toBe("");
    });
  });

  // --- handleInboundEmail ---

  describe("handleInboundEmail", () => {
    it("sends email content to target agent via Trunk", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-1", thread_id: "trunk-thread-1" }), { status: 200 }),
      );

      const email = makeEmail();
      const res = await handleInboundEmail(email, "agent-support");

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://mock-relay.test/messages");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body.to).toBe("agent-support");
      expect(body.type).toBe("question");
      expect(body.payload.content).toBe("I need help with order #12345");
      expect(body.payload.source).toBe("email");
      expect(headerValue(opts.headers, "Authorization")).toBe("Bearer test-trunk-secret");
    });

    it("includes email context (from and subject)", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-2", thread_id: "trunk-thread-2" }), { status: 200 }),
      );

      const email = makeEmail({
        from: "john@corp.com",
        subject: "Urgent bug report",
        text: "The API returns 500 on POST /users",
      });
      await handleInboundEmail(email, "agent-support");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Content is the email body text
      expect(body.payload.content).toBe("The API returns 500 on POST /users");
      // Context is built from email metadata (from + subject)
      expect(body.payload.context).toContain("john@corp.com");
      expect(body.payload.context).toContain("Urgent bug report");
    });

    it("returns 502 when Trunk API fails", async () => {
      mockFetch.mockResolvedValueOnce(new Response("error", { status: 500 }));

      const email = makeEmail();
      const res = await handleInboundEmail(email, "agent-support");

      expect(res.status).toBe(502);
      expect(await res.text()).toBe("Failed to relay to Trunk");
    });

    it("resolves thread from inReplyTo header", async () => {
      // First email creates a thread
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-3", thread_id: "trunk-thread-3" }), { status: 200 }),
      );
      const firstEmail = makeEmail({ messageId: "<first@example.com>" });
      await handleInboundEmail(firstEmail, "agent-support");
      mockFetch.mockClear();

      // Reply email references the first
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-4", thread_id: "trunk-thread-3" }), { status: 200 }),
      );
      const replyEmail = makeEmail({
        messageId: "<reply@example.com>",
        inReplyTo: "<first@example.com>",
        text: "Following up on my order issue",
      });
      await handleInboundEmail(replyEmail, "agent-support");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.thread_id).toBe("trunk-thread-3");
    });
  });

  // --- handleTrunkWebhook ---

  describe("handleTrunkWebhook", () => {
    it("ignores non-message.received events", async () => {
      const req = trunkWebhookRequest({
        event: "message.delivered",
        message: { id: "m1", fromAgent: "a1", threadId: "t1", payload: { content: "test" } },
      });
      const res = await handleTrunkWebhook(req);
      expect(res.status).toBe(200);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("ignores messages sourced from email (echo prevention)", async () => {
      const req = trunkWebhookRequest({
        event: "message.received",
        message: { id: "m2", fromAgent: "a2", threadId: "t2", payload: { content: "test", source: "email" } },
      });
      const res = await handleTrunkWebhook(req);
      expect(res.status).toBe(200);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips delivery when no thread mapping exists", async () => {
      const req = trunkWebhookRequest({
        event: "message.received",
        message: { id: "m3", fromAgent: "a3", threadId: "unmapped-thread", payload: { content: "reply" } },
      });
      const res = await handleTrunkWebhook(req);
      expect(res.status).toBe(200);
      // No email sent and no ack
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sends email reply and acks when thread mapping exists", async () => {
      // Create a thread mapping via inbound email first
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-10", thread_id: "trunk-thread-10" }), { status: 200 }),
      );
      await handleInboundEmail(
        makeEmail({
          from: "customer@test.com",
          subject: "Need help",
          messageId: "<original@test.com>",
        }),
        "agent-support",
      );
      mockFetch.mockClear();

      // Now simulate agent reply via Trunk webhook
      mockFetch
        .mockResolvedValueOnce(new Response("", { status: 202 })) // sendEmail (SendGrid)
        .mockResolvedValueOnce(new Response("ok", { status: 200 })); // trunkAck

      const req = trunkWebhookRequest({
        event: "message.received",
        message: {
          id: "msg-reply-10",
          fromAgent: "agent-support",
          threadId: "trunk-thread-10",
          payload: { content: "Here's how to fix your issue..." },
        },
      });
      const res = await handleTrunkWebhook(req);

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // First call: sendEmail via SendGrid
      const [sendGridUrl, sendGridOpts] = mockFetch.mock.calls[0];
      expect(sendGridUrl).toBe("https://api.sendgrid.com/v3/mail/send");
      const emailBody = JSON.parse(sendGridOpts.body);
      expect(emailBody.personalizations[0].to[0].email).toBe("customer@test.com");
      expect(emailBody.subject).toBe("Re: Need help");
      expect(emailBody.content[0].value).toContain("Here's how to fix your issue...");
      expect(emailBody.content[0].value).toContain("Trunk");
      expect(emailBody.headers["In-Reply-To"]).toBe("<original@test.com>");
      expect(sendGridOpts.headers["Authorization"]).toBe("Bearer sg-test-key");

      // Second call: trunkAck
      const [ackUrl] = mockFetch.mock.calls[1];
      expect(ackUrl).toBe("https://mock-relay.test/messages/msg-reply-10/ack");
    });
  });

  // --- Worker entry point ---

  describe("worker entry point", () => {
    it("returns health check on root path", async () => {
      const mod = await import("../adapters/email/index.js");
      const res = await mod.default.fetch(new Request("https://example.com/"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.name).toBe("trunk-email-adapter");
      expect(json.status).toBe("ok");
    });

    it("returns 404 for unknown routes", async () => {
      const mod = await import("../adapters/email/index.js");
      const res = await mod.default.fetch(new Request("https://example.com/unknown"));
      expect(res.status).toBe(404);
    });

    it("rejects inbound email without target agent mapping", async () => {
      const mod = await import("../adapters/email/index.js");
      const req = new Request("https://example.com/inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeEmail({ to: "unmapped@example.com" })),
      });
      const res = await mod.default.fetch(req);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("No target agent mapping for recipient");
    });

    it("routes POST /trunk-webhook to handler", async () => {
      const mod = await import("../adapters/email/index.js");
      const req = new Request("https://example.com/trunk-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "message.delivered",
          message: { id: "m-route", fromAgent: "a1", threadId: "t-route", payload: {} },
        }),
      });
      const res = await mod.default.fetch(req);
      expect(res.status).toBe(200);
    });
  });
});

function headerValue(headers: HeadersInit, name: string): string | null {
  return headers instanceof Headers ? headers.get(name) : (headers as Record<string, string>)[name] ?? null;
}
