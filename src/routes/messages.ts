import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, contacts, messages } from "../db/schema.js";
import { eq, or, and, desc } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { applyFactUpdates } from "../lib/context.js";
import { requireIdempotencyKey } from "../lib/idempotency.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { deliverWebhook, notifyPushWorker } from "../lib/webhook.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// Send a message
app.post("/", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{
    to: string;
    type: string;
    payload: Record<string, unknown>;
    thread_id?: string;
    reply_to?: string;
  }>();
  const idempotencyKey = requireIdempotencyKey(c);
  if (idempotencyKey instanceof Response) return idempotencyKey;

  if (!body.to || !body.type || !body.payload) {
    return c.json({ error: "to, type, and payload are required" }, 400);
  }
  const rateLimit = await checkRateLimit(`messages:${agentId}`, 60, 60 * 1000);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const existing = await findIdempotentMessage(agentId, idempotencyKey);
  if (existing) {
    return c.json(receipt(existing), 200);
  }

  // Allow self-messaging (same agent, different sessions/terminals)
  // Otherwise verify they're contacts
  if (body.to !== agentId) {
    const contact = await db
      .select()
      .from(contacts)
      .where(
        or(
          and(eq(contacts.agentA, agentId), eq(contacts.agentB, body.to)),
          and(eq(contacts.agentA, body.to), eq(contacts.agentB, agentId))
        )
      )
      .limit(1);

    if (contact.length === 0) {
      return c.json({ error: "Not a contact. Pair first." }, 403);
    }
  }

  // Create message
  const [message] = await db
    .insert(messages)
    .values({
      fromAgent: agentId,
      toAgent: body.to,
      threadId: body.thread_id,
      replyTo: body.reply_to,
      idempotencyKey,
      type: body.type,
      payload: body.payload,
    })
    .returning();

  // If no thread_id provided, use the message's own id as thread root
  if (!message.threadId) {
    await db
      .update(messages)
      .set({ threadId: message.id })
      .where(eq(messages.id, message.id));
    message.threadId = message.id;
  }

  await applyFactUpdates(agentId, body.to, body.payload.updates_facts);
  await audit(agentId, "message.send", "message", message.id, {
    to: body.to,
    thread_id: message.threadId,
    reply_to: body.reply_to,
  });

  // Push notification (awaited — fast, single fetch to DO)
  await notifyPushWorker(body.to, message);

  await db
    .update(messages)
    .set({ status: "delivered", deliveredAt: new Date() })
    .where(eq(messages.id, message.id));
  message.status = "delivered";

  // Deliver webhook (fire and forget — has retries/delays)
  const [recipient] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, body.to))
    .limit(1);

  if (recipient?.webhookUrl) {
    deliverWebhook(message, recipient).catch(() => {});
  }

  return c.json(receipt(message), 201);
});

// Get inbox (pending/unread messages)
app.get("/inbox", async (c) => {
  const agentId = c.get("agentId");
  const status = c.req.query("status");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  const rows = await db
    .select()
    .from(messages)
    .where(status ? and(eq(messages.toAgent, agentId), eq(messages.status, status)) : eq(messages.toAgent, agentId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  const visible = status ? rows : rows.filter((row) => row.status === "pending" || row.status === "delivered");
  return c.json({ messages: visible.slice(0, limit) });
});

// Get thread
app.get("/thread/:threadId", async (c) => {
  const agentId = c.get("agentId");
  const threadId = c.req.param("threadId");

  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId))
      )
    )
    .orderBy(messages.createdAt);

  return c.json({ messages: rows });
});

// Acknowledge a message (mark as read)
app.post("/:id/ack", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");

  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.toAgent, agentId)))
    .limit(1);

  if (!msg) {
    return c.json({ error: "Message not found" }, 404);
  }

  await db
    .update(messages)
    .set({ status: "processed", readAt: new Date(), processedAt: new Date() })
    .where(eq(messages.id, messageId));
  await audit(agentId, "message.ack", "message", messageId);

  return c.json({ ok: true });
});

// Reply (ack + send in one call)
app.post("/:id/reply", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");
  const body = await c.req.json<{
    type: string;
    payload: Record<string, unknown>;
    reply_to?: string;
  }>();
  const idempotencyKey = requireIdempotencyKey(c);
  if (idempotencyKey instanceof Response) return idempotencyKey;

  // Find original message
  const [original] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.toAgent, agentId)))
    .limit(1);

  if (!original) {
    return c.json({ error: "Message not found" }, 404);
  }
  const rateLimit = await checkRateLimit(`messages:${agentId}`, 60, 60 * 1000);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const existing = await findIdempotentMessage(agentId, idempotencyKey);
  if (existing) {
    return c.json(receipt(existing), 200);
  }

  // Mark original as replied
  await db
    .update(messages)
    .set({ status: "replied", repliedAt: new Date(), readAt: original.readAt ?? new Date(), processedAt: new Date() })
    .where(eq(messages.id, messageId));

  // Send reply in same thread
  const [reply] = await db
    .insert(messages)
    .values({
      fromAgent: agentId,
      toAgent: original.fromAgent,
      threadId: original.threadId,
      replyTo: body.reply_to ?? original.id,
      idempotencyKey,
      type: body.type,
      payload: body.payload,
    })
    .returning();

  await applyFactUpdates(agentId, original.fromAgent, body.payload.updates_facts);
  await audit(agentId, "message.reply", "message", reply.id, {
    original_message_id: original.id,
    thread_id: original.threadId,
  });

  // Deliver webhook
  const [recipient] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, original.fromAgent))
    .limit(1);

  if (recipient) {
    await notifyPushWorker(original.fromAgent, reply);
    await db
      .update(messages)
      .set({ status: "delivered", deliveredAt: new Date() })
      .where(eq(messages.id, reply.id));
    reply.status = "delivered";
    deliverWebhook(reply, recipient).catch(() => {});
  }

  return c.json(receipt(reply), 201);
});

export default app;

type MessageRow = typeof messages.$inferSelect;

async function findIdempotentMessage(agentId: string, idempotencyKey: string): Promise<MessageRow | undefined> {
  const [existing] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.fromAgent, agentId), eq(messages.idempotencyKey, idempotencyKey)))
    .limit(1);
  return existing;
}

function receipt(message: MessageRow) {
  return {
    id: message.id,
    thread_id: message.threadId,
    status: message.status,
    created_at: message.createdAt,
  };
}
