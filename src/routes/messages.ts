import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, contacts, messages } from "../db/schema.js";
import { eq, or, and, desc } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { deliverWebhook } from "../lib/webhook.js";

const app = new Hono();

app.use("/*", authMiddleware);

// Send a message
app.post("/", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{
    to: string;
    type: string;
    payload: Record<string, unknown>;
    thread_id?: string;
  }>();

  if (!body.to || !body.type || !body.payload) {
    return c.json({ error: "to, type, and payload are required" }, 400);
  }

  // Verify they're contacts
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

  // Create message
  const [message] = await db
    .insert(messages)
    .values({
      fromAgent: agentId,
      toAgent: body.to,
      threadId: body.thread_id,
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

  // Deliver webhook (fire and forget — don't block response)
  const [recipient] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, body.to))
    .limit(1);

  if (recipient) {
    deliverWebhook(message, recipient).catch(() => {});
  }

  return c.json({
    id: message.id,
    thread_id: message.threadId,
    status: message.status,
    created_at: message.createdAt,
  }, 201);
});

// Get inbox (pending/unread messages)
app.get("/inbox", async (c) => {
  const agentId = c.get("agentId");
  const status = c.req.query("status") || "pending";
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.toAgent, agentId), eq(messages.status, status)))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return c.json({ messages: rows });
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
    .set({ status: "read", readAt: new Date() })
    .where(eq(messages.id, messageId));

  return c.json({ ok: true });
});

// Reply (ack + send in one call)
app.post("/:id/reply", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");
  const body = await c.req.json<{
    type: string;
    payload: Record<string, unknown>;
  }>();

  // Find original message
  const [original] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.toAgent, agentId)))
    .limit(1);

  if (!original) {
    return c.json({ error: "Message not found" }, 404);
  }

  // Mark original as replied
  await db
    .update(messages)
    .set({ status: "replied", repliedAt: new Date() })
    .where(eq(messages.id, messageId));

  // Send reply in same thread
  const [reply] = await db
    .insert(messages)
    .values({
      fromAgent: agentId,
      toAgent: original.fromAgent,
      threadId: original.threadId,
      type: body.type,
      payload: body.payload,
    })
    .returning();

  // Deliver webhook
  const [recipient] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, original.fromAgent))
    .limit(1);

  if (recipient) {
    deliverWebhook(reply, recipient).catch(() => {});
  }

  return c.json({
    id: reply.id,
    thread_id: reply.threadId,
    status: reply.status,
    created_at: reply.createdAt,
  }, 201);
});

export default app;
