import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, contacts, messages, workspaces } from "../db/schema.js";
import { eq, or, and, desc } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { applyFactUpdates } from "../lib/context.js";
import { requireIdempotencyKey } from "../lib/idempotency.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { deliverWebhook, notifyPushWorker } from "../lib/webhook.js";
import { canMessage, getWorkspaceMembers } from "../lib/workspace.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 90;

app.use("/*", authMiddleware);

// Send a message (supports workspace:<id> addressing for fan-out)
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
  if (payloadSizeBytes(body.payload) > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "payload exceeds 1MB limit" }, 413);
  }
  const rateLimit = await checkRateLimit(`messages:${agentId}`, 60, 60 * 1000);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const existing = await findIdempotentMessage(agentId, idempotencyKey);
  if (existing) {
    return c.json(receipt(existing), 200);
  }

  // Handle workspace addressing: "workspace:<id>"
  if (body.to.startsWith("workspace:")) {
    const workspaceId = body.to.slice("workspace:".length);

    // Verify workspace exists
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    // Get all workspace members
    const memberIds = await getWorkspaceMembers(workspaceId);
    if (memberIds.length === 0) {
      return c.json({ error: "Workspace has no members" }, 400);
    }

    // Filter out the sender from fan-out recipients
    const recipients = memberIds.filter((id) => id !== agentId);
    if (recipients.length === 0) {
      return c.json({ error: "No other members in workspace" }, 400);
    }

    // Verify sender can message the workspace (member or workspace_contact)
    const senderCanMessage = await canMessage(agentId, recipients[0]);
    if (!senderCanMessage) {
      return c.json({ error: "Not a contact. Pair first." }, 403);
    }

    // Fan-out: create a message for each recipient
    const threadId = body.thread_id ?? crypto.randomUUID();
    const created: MessageRow[] = [];

    for (const recipientId of recipients) {
      const [message] = await db
        .insert(messages)
        .values({
          fromAgent: agentId,
          toAgent: recipientId,
          toWorkspace: workspaceId,
          threadId,
          replyTo: body.reply_to,
          idempotencyKey: `${idempotencyKey}:${recipientId}`,
          type: body.type,
          payload: body.payload,
        })
        .returning();

      await notifyRealtime(recipientId, message);
      await db
        .update(messages)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(eq(messages.id, message.id));
      message.status = "delivered";

      const [recipient] = await db.select().from(agents).where(eq(agents.id, recipientId)).limit(1);
      if (recipient?.webhookUrl) {
        deliverWebhook(message, recipient).catch(() => {});
      }

      created.push(message);
    }

    await audit(agentId, "message.send_workspace", "workspace", workspaceId, {
      thread_id: threadId,
      recipient_count: recipients.length,
    });

    return c.json({
      id: created[0].id,
      thread_id: threadId,
      status: "delivered",
      created_at: created[0].createdAt,
      recipients: recipients.length,
    }, 201);
  }

  // Direct message: verify contact via canMessage helper
  const allowed = await canMessage(agentId, body.to);
  if (!allowed) {
    return c.json({ error: "Not a contact. Pair first." }, 403);
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

  // Push notification is best-effort. Durable inbox delivery must not depend on it.
  await notifyRealtime(body.to, message);

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

  const visible = status
    ? rows.filter((row) => row.status !== "deleted")
    : rows.filter((row) => row.status === "pending" || row.status === "delivered");
  return c.json({ messages: visible.slice(0, limit) });
});

// Get sent messages (outbox)
app.get("/sent", async (c) => {
  const agentId = c.get("agentId");
  const toFilter = c.req.query("to");
  const typeFilter = c.req.query("type");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  const conditions = [eq(messages.fromAgent, agentId)];
  if (toFilter) conditions.push(eq(messages.toAgent, toFilter));
  if (typeFilter) conditions.push(eq(messages.type, typeFilter));

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  const visible = rows.filter((row) => row.status !== "deleted");
  return c.json({ messages: visible });
});

// Search messages by content, type, contact, and date range
app.get("/search", async (c) => {
  const agentId = c.get("agentId");
  const q = c.req.query("q")?.toLowerCase();
  const type = c.req.query("type");
  const contact = c.req.query("contact");
  const after = c.req.query("after");
  const before = c.req.query("before");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  // Build DB-level conditions for indexed fields
  const conditions = [
    or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId)),
  ];
  if (type) {
    conditions.push(eq(messages.type, type));
  }
  if (contact) {
    conditions.push(or(
      and(eq(messages.fromAgent, agentId), eq(messages.toAgent, contact)),
      and(eq(messages.fromAgent, contact), eq(messages.toAgent, agentId)),
    ));
  }

  // Fetch a larger set when JS filtering is needed
  const fetchLimit = (q || after || before) ? 500 : limit;
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(fetchLimit);

  // JS-level filtering for text search and date range
  let filtered = rows.filter((row) => row.status !== "deleted");
  if (q) {
    filtered = filtered.filter((row) => {
      const content = (row.payload as Record<string, unknown>).content;
      return typeof content === "string" && content.toLowerCase().includes(q);
    });
  }
  if (after) {
    const afterDate = new Date(after);
    filtered = filtered.filter((row) => row.createdAt >= afterDate);
  }
  if (before) {
    const beforeDate = new Date(before);
    filtered = filtered.filter((row) => row.createdAt <= beforeDate);
  }

  return c.json({ messages: filtered.slice(0, limit) });
});

app.post("/purge-expired", async (c) => {
  const agentId = c.get("agentId");
  const body: { days?: number } = await c.req.json<{ days?: number }>().catch(() => ({}));
  const days = Math.max(1, Math.min(body.days ?? DEFAULT_RETENTION_DAYS, 3650));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const rows = await db
    .select()
    .from(messages)
    .where(or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId)));
  const expired = rows.filter((row) => row.createdAt.getTime() < cutoff);

  for (const row of expired) {
    await db.delete(messages).where(eq(messages.id, row.id));
  }
  await audit(agentId, "message.retention_purge", "message", null, { days, count: expired.length });
  return c.json({ purged: expired.length, cutoff: new Date(cutoff).toISOString() });
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

  return c.json({ messages: rows.filter((row) => row.status !== "deleted") });
});

app.delete("/:id", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");

  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.fromAgent, agentId)))
    .limit(1);

  if (!msg) return c.json({ error: "Message not found" }, 404);

  await db
    .update(messages)
    .set({ status: "deleted", deletedAt: new Date() })
    .where(eq(messages.id, messageId));
  await audit(agentId, "message.delete", "message", messageId);
  return c.json({ ok: true });
});

// Edit a sent message (only sender can edit, only payload)
app.patch("/:id", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");
  const body = await c.req.json<{
    payload: Record<string, unknown>;
  }>();

  if (!body.payload) {
    return c.json({ error: "payload is required" }, 400);
  }
  if (payloadSizeBytes(body.payload) > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "payload exceeds 1MB limit" }, 413);
  }

  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.fromAgent, agentId)))
    .limit(1);

  if (!msg) return c.json({ error: "Message not found" }, 404);
  if (msg.status === "deleted") return c.json({ error: "Cannot edit a deleted message" }, 400);

  const [updated] = await db
    .update(messages)
    .set({ payload: body.payload, editedAt: new Date() })
    .where(eq(messages.id, messageId))
    .returning();

  await audit(agentId, "message.edit", "message", messageId);

  return c.json({
    id: updated.id,
    thread_id: updated.threadId,
    payload: updated.payload,
    edited_at: updated.editedAt,
    status: updated.status,
  });
});

// Bulk acknowledge messages (mark multiple as read)
app.post("/ack-bulk", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ message_ids: string[] }>();

  if (!Array.isArray(body.message_ids) || body.message_ids.length === 0) {
    return c.json({ error: "message_ids array is required" }, 400);
  }
  if (body.message_ids.length > 100) {
    return c.json({ error: "Cannot ack more than 100 messages at once" }, 400);
  }

  let acked = 0;
  for (const messageId of body.message_ids) {
    const [msg] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.toAgent, agentId)))
      .limit(1);

    if (msg) {
      await db
        .update(messages)
        .set({ status: "processed", readAt: new Date(), processedAt: new Date() })
        .where(eq(messages.id, messageId));
      acked++;
    }
  }

  await audit(agentId, "message.ack_bulk", "message", null, { count: acked });
  return c.json({ ok: true, acked });
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
  if (payloadSizeBytes(body.payload) > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "payload exceeds 1MB limit" }, 413);
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
    await notifyRealtime(original.fromAgent, reply);
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

function payloadSizeBytes(payload: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

async function notifyRealtime(agentId: string, message: MessageRow): Promise<void> {
  try {
    await notifyPushWorker(agentId, message);
  } catch (error) {
    await audit(message.fromAgent, "message.push_failed", "message", message.id, {
      to: agentId,
      error: error instanceof Error ? error.message : "unknown",
    }).catch(() => {});
  }
}
