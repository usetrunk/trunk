import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, contacts, messages, workspaces, reactions } from "../db/schema.js";
import { eq, or, and, desc, lt } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { parsePaginationQuery, paginateResults, type PaginationParams } from "../lib/pagination.js";
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
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const conditions = [eq(messages.toAgent, agentId)];
  if (status) conditions.push(eq(messages.status, status));
  if (cursor) {
    conditions.push(
      or(
        lt(messages.createdAt, cursor.createdAt),
        and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id))
      )!
    );
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);

  const visible = status
    ? rows.filter((row) => row.status !== "deleted")
    : rows.filter((row) => row.status === "pending" || row.status === "delivered");

  const page = paginateResults(visible, limit);
  return c.json({ messages: page.items, next_cursor: page.next_cursor, has_more: page.has_more });
});

// Get inbox stats (unread count + breakdown by type)
app.get("/inbox/stats", async (c) => {
  const agentId = c.get("agentId");

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.toAgent, agentId));

  const unread = rows.filter((row) => row.status === "pending" || row.status === "delivered");
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const row of unread) {
    byType[row.type] = (byType[row.type] || 0) + 1;
  }
  for (const row of rows.filter((r) => r.status !== "deleted")) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  }

  return c.json({
    unread: unread.length,
    total: rows.filter((r) => r.status !== "deleted").length,
    by_type: byType,
    by_status: byStatus,
  });
});

// Get sent messages (outbox)
app.get("/sent", async (c) => {
  const agentId = c.get("agentId");
  const toFilter = c.req.query("to");
  const typeFilter = c.req.query("type");
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const conditions = [eq(messages.fromAgent, agentId)];
  if (toFilter) conditions.push(eq(messages.toAgent, toFilter));
  if (typeFilter) conditions.push(eq(messages.type, typeFilter));
  if (cursor) {
    conditions.push(
      or(
        lt(messages.createdAt, cursor.createdAt),
        and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id))
      )!
    );
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);

  const visible = rows.filter((row) => row.status !== "deleted");
  const page = paginateResults(visible, limit);
  return c.json({ messages: page.items, next_cursor: page.next_cursor, has_more: page.has_more });
});

// Search messages by content, type, contact, and date range
app.get("/search", async (c) => {
  const agentId = c.get("agentId");
  const q = c.req.query("q")?.toLowerCase();
  const type = c.req.query("type");
  const contact = c.req.query("contact");
  const after = c.req.query("after");
  const before = c.req.query("before");
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  // Build DB-level conditions for indexed fields
  const conditions: ReturnType<typeof eq>[] = [
    or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId))!,
  ];
  if (type) {
    conditions.push(eq(messages.type, type));
  }
  if (contact) {
    conditions.push(or(
      and(eq(messages.fromAgent, agentId), eq(messages.toAgent, contact)),
      and(eq(messages.fromAgent, contact), eq(messages.toAgent, agentId)),
    )!);
  }
  if (cursor) {
    conditions.push(
      or(
        lt(messages.createdAt, cursor.createdAt),
        and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id))
      )!
    );
  }

  // Fetch a larger set when JS filtering is needed
  const fetchLimit = (q || after || before) ? 500 : limit + 1;
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
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

  const page = paginateResults(filtered, limit);
  return c.json({ messages: page.items, next_cursor: page.next_cursor, has_more: page.has_more });
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

// Get thread summary (structured digest — no LLM, just metadata)
app.get("/thread/:threadId/summary", async (c) => {
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

  const visible = rows.filter((row) => row.status !== "deleted");
  if (visible.length === 0) {
    return c.json({ error: "Thread not found or empty" }, 404);
  }

  // Participants
  const participantIds = new Set<string>();
  for (const row of visible) {
    participantIds.add(row.fromAgent);
    participantIds.add(row.toAgent);
  }
  const participantRows = await db
    .select({ id: agents.id, name: agents.name, owner: agents.owner })
    .from(agents)
    .where(or(...[...participantIds].map((id) => eq(agents.id, id))));
  const participants = participantRows.map((p) => ({ agent_id: p.id, name: p.name, owner: p.owner }));

  // Message type breakdown
  const byType: Record<string, number> = {};
  for (const row of visible) {
    byType[row.type] = (byType[row.type] || 0) + 1;
  }

  // Status breakdown
  const byStatus: Record<string, number> = {};
  for (const row of visible) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  }

  // Key messages: decisions and handoffs
  const decisions = visible
    .filter((row) => row.type === "decision" || row.type === "handoff")
    .map((row) => ({
      id: row.id,
      type: row.type,
      from: row.fromAgent,
      content: (row.payload as Record<string, unknown>).content ?? null,
      created_at: row.createdAt,
    }));

  // Open questions (questions that haven't been replied to)
  const repliedTo = new Set(visible.map((r) => r.replyTo).filter(Boolean));
  const openQuestions = visible
    .filter((row) => row.type === "question" && !repliedTo.has(row.id))
    .map((row) => ({
      id: row.id,
      from: row.fromAgent,
      content: (row.payload as Record<string, unknown>).content ?? null,
      created_at: row.createdAt,
    }));

  const first = visible[0];
  const last = visible[visible.length - 1];

  return c.json({
    thread_id: threadId,
    message_count: visible.length,
    participants,
    by_type: byType,
    by_status: byStatus,
    decisions,
    open_questions: openQuestions,
    first_message: {
      id: first.id,
      type: first.type,
      from: first.fromAgent,
      created_at: first.createdAt,
    },
    last_message: {
      id: last.id,
      type: last.type,
      from: last.fromAgent,
      content: (last.payload as Record<string, unknown>).content ?? null,
      created_at: last.createdAt,
    },
    started_at: first.createdAt,
    last_activity: last.createdAt,
  });
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

// Forward a message to another contact
app.post("/:id/forward", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");
  const body = await c.req.json<{ to: string; comment?: string }>();
  const idempotencyKey = requireIdempotencyKey(c);
  if (idempotencyKey instanceof Response) return idempotencyKey;

  if (!body.to) {
    return c.json({ error: "to is required" }, 400);
  }

  // Verify original message exists and agent is sender or recipient
  const [original] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId))
      )
    )
    .limit(1);

  if (!original) return c.json({ error: "Message not found" }, 404);

  // Verify forwarder can message the target
  const allowed = await canMessage(agentId, body.to);
  if (!allowed) {
    return c.json({ error: "Not a contact. Pair first." }, 403);
  }

  const existing = await findIdempotentMessage(agentId, idempotencyKey);
  if (existing) {
    return c.json(receipt(existing), 200);
  }

  // Build forwarded payload
  const forwardedPayload: Record<string, unknown> = {
    ...original.payload,
    forwarded_from: original.fromAgent,
    original_message_id: original.id,
  };
  if (body.comment) {
    forwardedPayload.forward_comment = body.comment;
  }

  const [forwarded] = await db
    .insert(messages)
    .values({
      fromAgent: agentId,
      toAgent: body.to,
      idempotencyKey,
      type: original.type,
      payload: forwardedPayload,
    })
    .returning();

  if (!forwarded.threadId) {
    await db
      .update(messages)
      .set({ threadId: forwarded.id })
      .where(eq(messages.id, forwarded.id));
    forwarded.threadId = forwarded.id;
  }

  await audit(agentId, "message.forward", "message", forwarded.id, {
    original_message_id: original.id,
    forwarded_to: body.to,
  });

  // Deliver
  const [recipient] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, body.to))
    .limit(1);

  if (recipient) {
    await notifyRealtime(body.to, forwarded);
    await db
      .update(messages)
      .set({ status: "delivered", deliveredAt: new Date() })
      .where(eq(messages.id, forwarded.id));
    forwarded.status = "delivered";
    deliverWebhook(forwarded, recipient).catch(() => {});
  }

  return c.json(receipt(forwarded), 201);
});

// Add a reaction to a message
app.post("/:id/react", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");
  const body = await c.req.json<{ emoji: string }>();

  if (!body.emoji || typeof body.emoji !== "string") {
    return c.json({ error: "emoji is required" }, 400);
  }
  if (body.emoji.length > 32) {
    return c.json({ error: "emoji too long" }, 400);
  }

  // Verify message exists and agent is sender or recipient
  const [msg] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId))
      )
    )
    .limit(1);

  if (!msg) return c.json({ error: "Message not found" }, 404);

  // Check for existing reaction (idempotent)
  const existing = await db
    .select()
    .from(reactions)
    .where(
      and(
        eq(reactions.messageId, messageId),
        eq(reactions.agentId, agentId),
        eq(reactions.emoji, body.emoji)
      )
    );

  if (existing.length > 0) {
    return c.json({ id: existing[0].id, message_id: messageId, emoji: body.emoji, created_at: existing[0].createdAt }, 200);
  }

  const [reaction] = await db
    .insert(reactions)
    .values({ messageId, agentId, emoji: body.emoji })
    .returning();

  await audit(agentId, "message.react", "message", messageId, { emoji: body.emoji });

  return c.json({
    id: reaction.id,
    message_id: reaction.messageId,
    emoji: reaction.emoji,
    created_at: reaction.createdAt,
  }, 201);
});

// Remove a reaction from a message
app.delete("/:id/react/:emoji", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");
  const emoji = decodeURIComponent(c.req.param("emoji"));

  const existing = await db
    .select()
    .from(reactions)
    .where(
      and(
        eq(reactions.messageId, messageId),
        eq(reactions.agentId, agentId),
        eq(reactions.emoji, emoji)
      )
    );

  if (existing.length === 0) {
    return c.json({ error: "Reaction not found" }, 404);
  }

  await db
    .delete(reactions)
    .where(
      and(
        eq(reactions.messageId, messageId),
        eq(reactions.agentId, agentId),
        eq(reactions.emoji, emoji)
      )
    );

  await audit(agentId, "message.unreact", "message", messageId, { emoji });

  return c.json({ ok: true });
});

// List reactions for a message
app.get("/:id/reactions", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");

  // Verify message exists and agent is sender or recipient
  const [msg] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId))
      )
    )
    .limit(1);

  if (!msg) return c.json({ error: "Message not found" }, 404);

  const rows = await db
    .select()
    .from(reactions)
    .where(eq(reactions.messageId, messageId));

  // Group by emoji for summary
  const summary: Record<string, { count: number; agents: string[] }> = {};
  for (const row of rows) {
    if (!summary[row.emoji]) {
      summary[row.emoji] = { count: 0, agents: [] };
    }
    summary[row.emoji].count++;
    summary[row.emoji].agents.push(row.agentId);
  }

  return c.json({
    message_id: messageId,
    reactions: rows.map((r) => ({
      id: r.id,
      emoji: r.emoji,
      agent_id: r.agentId,
      created_at: r.createdAt,
    })),
    summary,
  });
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
