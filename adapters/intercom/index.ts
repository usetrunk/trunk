/**
 * Trunk Intercom Adapter
 *
 * Bridges Intercom conversations ↔ Trunk messages for support escalation.
 * Deploy as a Cloudflare Worker or Vercel Function.
 *
 * Required env vars:
 * - INTERCOM_ACCESS_TOKEN: Intercom app token
 * - INTERCOM_WEBHOOK_SECRET: webhook signing secret (HMAC)
 * - TRUNK_AGENT_SECRET: Trunk agent secret for the adapter
 * - TRUNK_RELAY_URL: https://trunk.bot (default)
 * - ESCALATION_AGENT_ID: default Trunk agent to escalate to
 */

const TRUNK_RELAY = process.env.TRUNK_RELAY_URL || "https://trunk.bot";
const TRUNK_SECRET = process.env.TRUNK_AGENT_SECRET || "";
const TRUNK_WEBHOOK_SECRET = process.env.TRUNK_WEBHOOK_SECRET || "";
const INTERCOM_TOKEN = process.env.INTERCOM_ACCESS_TOKEN || "";
const INTERCOM_SECRET = process.env.INTERCOM_WEBHOOK_SECRET || "";
const ESCALATION_AGENT = process.env.ESCALATION_AGENT_ID || "";

// --- Conversation ↔ Thread mapping ---
// Single-worker deployments can keep the active conversation map in memory.
// Multi-instance deployments should back this with KV, D1, or the relay DB.
const conversationToThread = new Map<string, string>();
const threadToConversation = new Map<string, string>();

// --- Trunk API ---

async function trunkSend(to: string, type: string, content: string, opts: {
  threadId?: string;
  context?: string;
  updatesFacts?: Record<string, unknown>;
} = {}) {
  const payload: Record<string, unknown> = {
    content,
    source: "intercom",
  };
  if (opts.context) payload.context = opts.context;
  if (opts.updatesFacts) payload.updates_facts = opts.updatesFacts;

  return fetch(`${TRUNK_RELAY}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TRUNK_SECRET}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      to,
      type,
      payload,
      thread_id: opts.threadId,
    }),
  });
}

async function trunkAck(messageId: string) {
  return fetch(`${TRUNK_RELAY}/messages/${messageId}/ack`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TRUNK_SECRET}` },
  });
}

// --- Intercom API ---

async function intercomGetConversation(conversationId: string) {
  const res = await fetch(`https://api.intercom.io/conversations/${conversationId}`, {
    headers: {
      "Authorization": `Bearer ${INTERCOM_TOKEN}`,
      "Content-Type": "application/json",
      "Intercom-Version": "2.11",
    },
  });
  return res.json() as Promise<{
    id: string;
    title?: string;
    source?: { body?: string; author?: { name?: string; email?: string } };
    tags?: { tags?: Array<{ name: string }> };
    conversation_parts?: { conversation_parts?: Array<{ body?: string; author?: { type?: string } }> };
  }>;
}

async function intercomReply(conversationId: string, body: string, type: "admin" | "note" = "admin") {
  const res = await fetch(`https://api.intercom.io/conversations/${conversationId}/reply`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${INTERCOM_TOKEN}`,
      "Content-Type": "application/json",
      "Intercom-Version": "2.11",
    },
    body: JSON.stringify({
      message_type: type === "note" ? "note" : "comment",
      type: "admin",
      body: `${body}\n\n<i>Resolved via <a href="https://trunk.bot">Trunk</a> — agent-to-agent escalation</i>`,
    }),
  });
  return res.ok;
}

// --- Webhook signature verification ---

async function verifyIntercomWebhook(body: string, signature: string): Promise<boolean> {
  if (!INTERCOM_SECRET || !signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(INTERCOM_SECRET),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const computed = `sha1=${Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("")}`;

  // Constant-time comparison
  if (computed.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

// --- Webhook handler ---

export async function handleIntercomWebhook(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("X-Hub-Signature") || "";

  if (INTERCOM_SECRET && !await verifyIntercomWebhook(rawBody, signature)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = JSON.parse(rawBody) as {
    topic: string;
    data: {
      item: {
        id: string;
        type: string;
        tags_added?: { tags?: Array<{ name: string }> };
      };
    };
  };

  const conversationId = event.data.item.id;

  // Check if this is an escalation trigger
  if (event.topic === "conversation.admin.noted" || event.topic === "conversation_part.tag.created") {
    const tags = event.data.item.tags_added?.tags?.map(t => t.name) || [];
    const isEscalation = tags.some(t =>
      t.toLowerCase().includes("engineering") ||
      t.toLowerCase().includes("escalat") ||
      t.toLowerCase().includes("trunk")
    );

    if (!isEscalation) return new Response("ok");
  }

  // Get conversation context
  const conversation = await intercomGetConversation(conversationId);
  const customerName = conversation.source?.author?.name || "Customer";
  const customerEmail = conversation.source?.author?.email || "";
  const initialMessage = conversation.source?.body || "";

  // Get recent parts for context
  const recentParts = conversation.conversation_parts?.conversation_parts
    ?.slice(-5)
    ?.map(p => p.body || "")
    ?.filter(Boolean)
    ?.join("\n---\n") || "";

  const context = [
    `Intercom conversation ${conversationId}`,
    `Customer: ${customerName} (${customerEmail})`,
    `Initial message: ${initialMessage.slice(0, 500)}`,
    recentParts ? `Recent context:\n${recentParts.slice(0, 1000)}` : "",
  ].filter(Boolean).join("\n");

  // Check if we already have a thread for this conversation
  let threadId = conversationToThread.get(conversationId);

  // Send to engineering agent
  const res = await trunkSend(ESCALATION_AGENT, "handoff", `Support escalation from ${customerName}: ${initialMessage.slice(0, 200)}`, {
    threadId,
    context,
    updatesFacts: {
      [`intercom.${conversationId}.customer`]: customerName,
      [`intercom.${conversationId}.status`]: "escalated",
    },
  });

  if (res.ok) {
    const receipt = await res.json() as { thread_id: string };
    conversationToThread.set(conversationId, receipt.thread_id);
    threadToConversation.set(receipt.thread_id, conversationId);
  }

  return new Response("ok");
}

// --- Trunk webhook: engineering replied, post back to Intercom ---

export async function handleTrunkWebhook(request: Request): Promise<Response> {
  const rawBody = await request.text();

  // Verify Trunk webhook signature if a webhook secret is configured
  if (TRUNK_WEBHOOK_SECRET) {
    const signature = request.headers.get("X-Trunk-Signature") || "";
    if (!signature || !await verifyTrunkSignature(rawBody, signature, TRUNK_WEBHOOK_SECRET)) {
      return new Response("Invalid Trunk webhook signature", { status: 401 });
    }
  }

  const body = JSON.parse(rawBody) as {
    event: string;
    message: {
      id: string;
      threadId: string;
      payload: { content?: string; source?: string };
    };
  };

  if (body.event !== "message.received") return new Response("ok");
  if (body.message.payload.source === "intercom") return new Response("ok"); // avoid echo

  const content = body.message.payload.content || "";
  const conversationId = threadToConversation.get(body.message.threadId);

  if (conversationId && content) {
    await intercomReply(conversationId, content, "note");
    await trunkAck(body.message.id);
  }

  return new Response("ok");
}

// --- Worker entry point ---

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/intercom") {
      return handleIntercomWebhook(request);
    }

    if (request.method === "POST" && url.pathname === "/trunk-webhook") {
      return handleTrunkWebhook(request);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ name: "trunk-intercom-adapter", status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function verifyTrunkSignature(
  rawBody: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const computed = `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  if (computed.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}
