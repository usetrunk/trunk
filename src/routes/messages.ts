import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, contacts, messages, workspaces, rooms, roomMembers, reactions, messageLabels, savedSearches, messageEdits } from "../db/schema.js";
import { eq, or, and, desc, lt } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { parsePaginationQuery, paginateResults, type PaginationParams } from "../lib/pagination.js";
import { applyFactUpdates } from "../lib/context.js";
import { requireIdempotencyKey } from "../lib/idempotency.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { deliverWebhook, notifyPushWorker } from "../lib/webhook.js";
import { canMessage, getWorkspaceMembers, isBlocked } from "../lib/workspace.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 90;
const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

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
    scheduled_at?: string;
    expires_at?: string;
    ttl_seconds?: number;
  }>();
  const idempotencyKey = requireIdempotencyKey(c);
  if (idempotencyKey instanceof Response) return idempotencyKey;

  if (!body.to || !body.type || !body.payload) {
    return c.json({ error: "to, type, and payload are required", code: "MISSING_FIELD" }, 400);
  }
  if (payloadSizeBytes(body.payload) > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "payload exceeds 1MB limit", code: "VALIDATION_ERROR" }, 413);
  }

  // Validate scheduled_at if provided
  let scheduledAt: Date | undefined;
  if (body.scheduled_at) {
    scheduledAt = new Date(body.scheduled_at);
    if (isNaN(scheduledAt.getTime())) {
      return c.json({ error: "scheduled_at must be a valid ISO 8601 date", code: "INVALID_INPUT" }, 400);
    }
    if (scheduledAt.getTime() <= Date.now()) {
      return c.json({ error: "scheduled_at must be in the future", code: "INVALID_INPUT" }, 400);
    }
  }

  // Validate expiry (expires_at or ttl_seconds)
  let expiresAt: Date | undefined;
  if (body.expires_at) {
    expiresAt = new Date(body.expires_at);
    if (isNaN(expiresAt.getTime())) {
      return c.json({ error: "expires_at must be a valid ISO 8601 date", code: "INVALID_INPUT" }, 400);
    }
    if (expiresAt.getTime() <= Date.now()) {
      return c.json({ error: "expires_at must be in the future", code: "INVALID_INPUT" }, 400);
    }
  } else if (body.ttl_seconds && body.ttl_seconds > 0) {
    expiresAt = new Date(Date.now() + body.ttl_seconds * 1000);
  }
  const rateLimit = await checkRateLimit(`messages:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
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
      return c.json({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" }, 404);
    }

    // Get all workspace members
    const memberIds = await getWorkspaceMembers(workspaceId);
    if (memberIds.length === 0) {
      return c.json({ error: "Workspace has no members", code: "VALIDATION_ERROR" }, 400);
    }

    // Filter out the sender from fan-out recipients
    const recipients = memberIds.filter((id) => id !== agentId);
    if (recipients.length === 0) {
      return c.json({ error: "No other members in workspace", code: "VALIDATION_ERROR" }, 400);
    }

    // Verify sender can message the workspace (member or workspace_contact)
    const senderCanMessage = await canMessage(agentId, recipients[0]);
    if (!senderCanMessage) {
      return c.json({ error: "Not a contact. Pair first.", code: "NOT_MEMBER" }, 403);
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
          ...(expiresAt ? { expiresAt } : {}),
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

  // Handle room addressing: "room:<id>"
  if (body.to.startsWith("room:")) {
    const roomId = body.to.slice("room:".length);

    // Verify room exists
    const [room] = await db
      .select()
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!room) {
      return c.json({ error: "Room not found", code: "ROOM_NOT_FOUND" }, 404);
    }

    // Get all room members
    const members = await db
      .select({ agentId: roomMembers.agentId })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId));
    if (members.length === 0) {
      return c.json({ error: "Room has no members", code: "VALIDATION_ERROR" }, 400);
    }

    // Verify sender is a room member
    if (!members.some((m) => m.agentId === agentId)) {
      return c.json({ error: "Not a member of this room", code: "NOT_MEMBER" }, 403);
    }

    // Filter out the sender from fan-out recipients
    const recipients = members.filter((m) => m.agentId !== agentId).map((m) => m.agentId);
    if (recipients.length === 0) {
      return c.json({ error: "No other members in room", code: "VALIDATION_ERROR" }, 400);
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
          toRoom: roomId,
          threadId,
          replyTo: body.reply_to,
          idempotencyKey: `${idempotencyKey}:${recipientId}`,
          type: body.type,
          payload: body.payload,
          ...(expiresAt ? { expiresAt } : {}),
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

    await audit(agentId, "message.send_room", "room", roomId, {
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
    return c.json({ error: "Not a contact. Pair first.", code: "NOT_MEMBER" }, 403);
  }
  if (await isBlocked(agentId, body.to)) {
    return c.json({ error: "You have been blocked by this agent", code: "BLOCKED" }, 403);
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
      ...(scheduledAt ? { status: "scheduled", scheduledAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
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
  await audit(agentId, scheduledAt ? "message.schedule" : "message.send", "message", message.id, {
    to: body.to,
    thread_id: message.threadId,
    reply_to: body.reply_to,
    ...(scheduledAt ? { scheduled_at: scheduledAt.toISOString() } : {}),
  });

  // Scheduled messages skip immediate delivery
  if (scheduledAt) {
    return c.json({ ...receipt(message), scheduled_at: scheduledAt.toISOString() }, 201);
  }

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

  const now = new Date();
  const visible = (status
    ? rows.filter((row) => row.status !== "deleted")
    : rows.filter((row) => row.status === "pending" || row.status === "delivered")
  ).filter((row) => !row.expiresAt || row.expiresAt > now);

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

// List threads the agent participates in (as sender or recipient)
app.get("/threads", async (c) => {
  const agentId = c.get("agentId");
  const limitParam = parseInt(c.req.query("limit") || "20", 10);
  const limit = Math.min(Math.max(1, limitParam), 50);
  const cursorParam = c.req.query("cursor");

  // Get all non-deleted messages where agent is sender or recipient
  const rows = await db
    .select()
    .from(messages)
    .where(
      or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId))
    )
    .orderBy(desc(messages.createdAt));

  const visible = rows.filter((r) => r.status !== "deleted" && r.threadId);

  // Group by thread
  const threadMap = new Map<string, typeof visible>();
  for (const msg of visible) {
    const tid = msg.threadId!;
    if (!threadMap.has(tid)) threadMap.set(tid, []);
    threadMap.get(tid)!.push(msg);
  }

  // Build thread summaries sorted by latest activity (newest first)
  const threadSummaries = Array.from(threadMap.entries())
    .map(([threadId, msgs]) => {
      msgs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const latest = msgs[0];
      const unread = msgs.filter((m) => m.toAgent === agentId && (m.status === "pending" || m.status === "delivered")).length;
      const participantIds = new Set<string>();
      for (const m of msgs) {
        participantIds.add(m.fromAgent);
        participantIds.add(m.toAgent);
      }
      return {
        thread_id: threadId,
        message_count: msgs.length,
        unread_count: unread,
        participants: Array.from(participantIds),
        last_message: {
          id: latest.id,
          from: latest.fromAgent,
          type: latest.type,
          preview: typeof latest.payload?.content === "string"
            ? latest.payload.content.slice(0, 120)
            : null,
          created_at: latest.createdAt,
        },
        last_activity: latest.createdAt,
      };
    })
    .sort((a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime());

  // Apply cursor pagination
  let startIdx = 0;
  if (cursorParam) {
    const idx = threadSummaries.findIndex((t) => t.thread_id === cursorParam);
    if (idx !== -1) startIdx = idx + 1;
  }

  const page = threadSummaries.slice(startIdx, startIdx + limit + 1);
  const has_more = page.length > limit;
  const items = has_more ? page.slice(0, limit) : page;
  const next_cursor = has_more && items.length > 0 ? items[items.length - 1].thread_id : null;

  return c.json({ threads: items, next_cursor, has_more });
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

// --- Saved searches ---

// List saved searches
app.get("/searches", async (c) => {
  const agentId = c.get("agentId");
  const rows = await db.select().from(savedSearches).where(eq(savedSearches.agentId, agentId));
  return c.json({
    searches: rows.map((r) => ({
      id: r.id,
      name: r.name,
      query: r.query,
      created_at: r.createdAt,
    })),
  });
});

// Save a search
app.post("/searches", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ name: string; query: Record<string, string> }>();

  if (!body.name || !body.query) {
    return c.json({ error: "name and query are required", code: "MISSING_FIELD" }, 400);
  }

  const [existing] = await db
    .select()
    .from(savedSearches)
    .where(and(eq(savedSearches.agentId, agentId), eq(savedSearches.name, body.name)))
    .limit(1);

  if (existing) {
    return c.json({ error: "Search with this name already exists", code: "ALREADY_EXISTS" }, 409);
  }

  const [row] = await db
    .insert(savedSearches)
    .values({ agentId, name: body.name, query: body.query })
    .returning();

  await audit(agentId, "search.save", "search", row.id, { name: body.name });
  return c.json({ id: row.id, name: row.name, query: row.query, created_at: row.createdAt }, 201);
});

// Delete a saved search
app.delete("/searches/:id", async (c) => {
  const agentId = c.get("agentId");
  const searchId = c.req.param("id");

  const [search] = await db
    .select()
    .from(savedSearches)
    .where(and(eq(savedSearches.id, searchId), eq(savedSearches.agentId, agentId)))
    .limit(1);

  if (!search) return c.json({ error: "Saved search not found", code: "NOT_FOUND" }, 404);

  await db.delete(savedSearches).where(eq(savedSearches.id, searchId));
  await audit(agentId, "search.delete", "search", searchId);
  return c.json({ ok: true });
});

// List scheduled messages (pending future delivery)
app.get("/scheduled", async (c) => {
  const agentId = c.get("agentId");
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const conditions = [eq(messages.fromAgent, agentId), eq(messages.status, "scheduled")];
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

  const page = paginateResults(rows, limit);
  return c.json({ messages: page.items, next_cursor: page.next_cursor, has_more: page.has_more });
});

// List all messages with a specific label
app.get("/by-label/:label", async (c) => {
  const agentId = c.get("agentId");
  const label = c.req.param("label").trim().toLowerCase();
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const labelRows = await db
    .select()
    .from(messageLabels)
    .where(and(eq(messageLabels.agentId, agentId), eq(messageLabels.label, label)));

  const messageIds = labelRows.map((r) => r.messageId);
  if (messageIds.length === 0) {
    return c.json({ messages: [], next_cursor: null, has_more: false });
  }

  const conditions = [or(...messageIds.map((id) => eq(messages.id, id)))!];
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

  const visible = rows.filter((r) => r.status !== "deleted");
  const page = paginateResults(visible, limit);
  return c.json({ messages: page.items, next_cursor: page.next_cursor, has_more: page.has_more });
});

// List all labels used by the agent
app.get("/labels/all", async (c) => {
  const agentId = c.get("agentId");

  const rows = await db
    .select()
    .from(messageLabels)
    .where(eq(messageLabels.agentId, agentId));

  const labelCounts: Record<string, number> = {};
  for (const r of rows) {
    labelCounts[r.label] = (labelCounts[r.label] || 0) + 1;
  }

  return c.json({
    labels: Object.entries(labelCounts).map(([label, count]) => ({ label, count })),
  });
});

// Cancel a scheduled message (only sender, only if still scheduled)
app.post("/:id/cancel", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");

  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.fromAgent, agentId)))
    .limit(1);

  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
  if (msg.status !== "scheduled") {
    return c.json({ error: "Only scheduled messages can be cancelled", code: "VALIDATION_ERROR" }, 400);
  }

  await db
    .update(messages)
    .set({ status: "cancelled", deletedAt: new Date() })
    .where(eq(messages.id, messageId));
  await audit(agentId, "message.cancel_scheduled", "message", messageId);

  return c.json({ ok: true, message_id: messageId });
});

// Process due scheduled messages (delivers all messages past their scheduled_at)
app.post("/deliver-scheduled", async (c) => {
  const now = new Date();

  // Find all scheduled messages that are due
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.status, "scheduled"));

  const due = rows.filter((row) => row.scheduledAt && row.scheduledAt.getTime() <= now.getTime());

  let delivered = 0;
  for (const msg of due) {
    await notifyRealtime(msg.toAgent, msg);
    await db
      .update(messages)
      .set({ status: "delivered", deliveredAt: now })
      .where(eq(messages.id, msg.id));

    const [recipient] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, msg.toAgent))
      .limit(1);
    if (recipient?.webhookUrl) {
      deliverWebhook(msg, recipient).catch(() => {});
    }
    delivered++;
  }

  return c.json({ delivered, checked_at: now.toISOString() });
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
    return c.json({ error: "Thread not found or empty", code: "NOT_FOUND" }, 404);
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

  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);

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
    return c.json({ error: "payload is required", code: "MISSING_FIELD" }, 400);
  }
  if (payloadSizeBytes(body.payload) > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "payload exceeds 1MB limit", code: "VALIDATION_ERROR" }, 413);
  }

  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.fromAgent, agentId)))
    .limit(1);

  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
  if (msg.status === "deleted") return c.json({ error: "Cannot edit a deleted message", code: "VALIDATION_ERROR" }, 400);

  const ageMs = Date.now() - msg.createdAt.getTime();
  if (ageMs > EDIT_WINDOW_MS) {
    return c.json({ error: "Edit window expired (15 minutes)", code: "EDIT_WINDOW_EXPIRED" }, 403);
  }

  // Determine version number for this edit
  const existingEdits = await db
    .select()
    .from(messageEdits)
    .where(eq(messageEdits.messageId, messageId));
  const version = existingEdits.length + 1;

  // Store previous payload in edit history
  await db.insert(messageEdits).values({
    messageId,
    version,
    previousPayload: msg.payload as Record<string, unknown>,
    editedBy: agentId,
  });

  const [updated] = await db
    .update(messages)
    .set({ payload: body.payload, editedAt: new Date() })
    .where(eq(messages.id, messageId))
    .returning();

  await audit(agentId, "message.edit", "message", messageId, { version });

  return c.json({
    id: updated.id,
    thread_id: updated.threadId,
    payload: updated.payload,
    edited_at: updated.editedAt,
    status: updated.status,
    version: version + 1,
  });
});

// Get edit history for a message
app.get("/:id/edits", async (c) => {
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

  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);

  const edits = await db
    .select()
    .from(messageEdits)
    .where(eq(messageEdits.messageId, messageId))
    .orderBy(messageEdits.version);

  return c.json({
    message_id: messageId,
    current_payload: msg.payload,
    edited_at: msg.editedAt,
    edits: edits.map((e) => ({
      version: e.version,
      previous_payload: e.previousPayload,
      edited_by: e.editedBy,
      created_at: e.createdAt,
    })),
    edit_count: edits.length,
  });
});

// Bulk acknowledge messages (mark multiple as read)
app.post("/ack-bulk", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ message_ids: string[] }>();

  if (!Array.isArray(body.message_ids) || body.message_ids.length === 0) {
    return c.json({ error: "message_ids array is required", code: "MISSING_FIELD" }, 400);
  }
  if (body.message_ids.length > 100) {
    return c.json({ error: "Cannot ack more than 100 messages at once", code: "VALIDATION_ERROR" }, 400);
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

// Bulk mark messages as read (without processing/acking)
app.post("/read-bulk", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ message_ids: string[] }>();

  if (!Array.isArray(body.message_ids) || body.message_ids.length === 0) {
    return c.json({ error: "message_ids array is required", code: "MISSING_FIELD" }, 400);
  }
  if (body.message_ids.length > 100) {
    return c.json({ error: "Cannot mark more than 100 messages at once", code: "VALIDATION_ERROR" }, 400);
  }

  let marked = 0;
  for (const messageId of body.message_ids) {
    const [msg] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.toAgent, agentId)))
      .limit(1);

    if (msg && !msg.readAt) {
      await db
        .update(messages)
        .set({ readAt: new Date() })
        .where(eq(messages.id, messageId));
      marked++;
    }
  }

  await audit(agentId, "message.read_bulk", "message", null, { count: marked });
  return c.json({ ok: true, marked });
});

// Bulk delete messages (soft-delete, sender only)
app.post("/delete-bulk", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ message_ids: string[] }>();

  if (!Array.isArray(body.message_ids) || body.message_ids.length === 0) {
    return c.json({ error: "message_ids array is required", code: "MISSING_FIELD" }, 400);
  }
  if (body.message_ids.length > 100) {
    return c.json({ error: "Cannot delete more than 100 messages at once", code: "VALIDATION_ERROR" }, 400);
  }

  let deleted = 0;
  for (const messageId of body.message_ids) {
    const [msg] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.fromAgent, agentId)))
      .limit(1);

    if (msg && msg.status !== "deleted") {
      await db
        .update(messages)
        .set({ status: "deleted", deletedAt: new Date() })
        .where(eq(messages.id, messageId));
      deleted++;
    }
  }

  await audit(agentId, "message.delete_bulk", "message", null, { count: deleted });
  return c.json({ ok: true, deleted });
});

// Bulk add label to messages
app.post("/label-bulk", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ message_ids: string[]; label: string }>();

  if (!Array.isArray(body.message_ids) || body.message_ids.length === 0) {
    return c.json({ error: "message_ids array is required", code: "MISSING_FIELD" }, 400);
  }
  if (!body.label || typeof body.label !== "string") {
    return c.json({ error: "label is required", code: "MISSING_FIELD" }, 400);
  }
  if (body.message_ids.length > 100) {
    return c.json({ error: "Cannot label more than 100 messages at once", code: "VALIDATION_ERROR" }, 400);
  }

  let labeled = 0;
  for (const messageId of body.message_ids) {
    const [msg] = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.id, messageId),
        or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId))
      ))
      .limit(1);

    if (msg) {
      const existing = await db
        .select()
        .from(messageLabels)
        .where(and(
          eq(messageLabels.messageId, messageId),
          eq(messageLabels.agentId, agentId),
          eq(messageLabels.label, body.label)
        ))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(messageLabels).values({
          messageId,
          agentId,
          label: body.label,
        });
        labeled++;
      }
    }
  }

  await audit(agentId, "message.label_bulk", "message", null, { count: labeled, label: body.label });
  return c.json({ ok: true, labeled });
});

// Mark a message as read (without processing/acking)
app.post("/:id/read", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");

  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.toAgent, agentId)))
    .limit(1);

  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
  if (msg.readAt) return c.json({ ok: true, already_read: true, read_at: msg.readAt });

  await db
    .update(messages)
    .set({ readAt: new Date() })
    .where(eq(messages.id, messageId));
  await audit(agentId, "message.read", "message", messageId);
  return c.json({ ok: true, read_at: new Date().toISOString() });
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
    return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
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
    return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
  }
  if (payloadSizeBytes(body.payload) > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "payload exceeds 1MB limit", code: "VALIDATION_ERROR" }, 413);
  }
  const rateLimit = await checkRateLimit(`messages:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
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
    return c.json({ error: "to is required", code: "MISSING_FIELD" }, 400);
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

  if (!original) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);

  // Verify forwarder can message the target
  const allowed = await canMessage(agentId, body.to);
  if (!allowed) {
    return c.json({ error: "Not a contact. Pair first.", code: "NOT_MEMBER" }, 403);
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
    return c.json({ error: "emoji is required", code: "MISSING_FIELD" }, 400);
  }
  if (body.emoji.length > 32) {
    return c.json({ error: "emoji too long", code: "VALIDATION_ERROR" }, 400);
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

  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);

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
    return c.json({ error: "Reaction not found", code: "NOT_FOUND" }, 404);
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

  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);

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

// Pin a message in a thread — either sender or recipient can pin
app.post("/:id/pin", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");

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

  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
  if (msg.pinnedAt) return c.json({ ok: true, already_pinned: true, pinned_at: msg.pinnedAt, pinned_by: msg.pinnedBy });

  const [updated] = await db
    .update(messages)
    .set({ pinnedAt: new Date(), pinnedBy: agentId })
    .where(eq(messages.id, messageId))
    .returning();

  return c.json({ ok: true, pinned_at: updated.pinnedAt, pinned_by: updated.pinnedBy });
});

// Unpin a message
app.post("/:id/unpin", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");

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

  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
  if (!msg.pinnedAt) return c.json({ ok: true, already_unpinned: true });

  await db
    .update(messages)
    .set({ pinnedAt: null, pinnedBy: null })
    .where(eq(messages.id, messageId));

  return c.json({ ok: true });
});

// List pinned messages in a thread
app.get("/thread/:threadId/pins", async (c) => {
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

  const pinned = rows.filter((r) => r.pinnedAt && r.status !== "deleted");
  if (pinned.length === 0) {
    return c.json({ thread_id: threadId, pinned: [], count: 0 });
  }

  const agentIds = [...new Set(pinned.flatMap((m) => [m.fromAgent, m.toAgent, m.pinnedBy].filter((x): x is string => !!x)))];
  const agentList = agentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(or(...agentIds.map((id) => eq(agents.id, id))))
    : [];
  const nameMap = Object.fromEntries(agentList.map((a) => [a.id, a.name]));

  return c.json({
    thread_id: threadId,
    pinned: pinned.map((m) => ({
      id: m.id,
      from: nameMap[m.fromAgent] || m.fromAgent,
      type: m.type,
      payload: m.payload,
      pinned_at: m.pinnedAt,
      pinned_by: m.pinnedBy ? nameMap[m.pinnedBy] || m.pinnedBy : null,
      created_at: m.createdAt,
    })),
    count: pinned.length,
  });
});

// Add a label to a message
app.post("/:id/labels", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");
  const body = await c.req.json<{ label: string }>();
  if (!body.label || typeof body.label !== "string" || body.label.trim().length === 0) {
    return c.json({ error: "label is required", code: "MISSING_FIELD" }, 400);
  }
  const label = body.label.trim().toLowerCase();
  if (label.length > 50) {
    return c.json({ error: "label must be 50 characters or fewer", code: "VALIDATION_ERROR" }, 400);
  }

  // Verify the message exists and the agent is sender or recipient
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
  if (msg.fromAgent !== agentId && msg.toAgent !== agentId) {
    return c.json({ error: "Not authorized", code: "FORBIDDEN" }, 403);
  }

  // Check for duplicate
  const existing = await db
    .select()
    .from(messageLabels)
    .where(and(eq(messageLabels.messageId, messageId), eq(messageLabels.agentId, agentId), eq(messageLabels.label, label)));
  if (existing.length > 0) {
    return c.json({ id: existing[0].id, message_id: messageId, label, created_at: existing[0].createdAt });
  }

  const [row] = await db.insert(messageLabels).values({ messageId, agentId, label }).returning();
  await audit(agentId, "message.label_add", "message", messageId, { label });
  return c.json({ id: row.id, message_id: messageId, label: row.label, created_at: row.createdAt }, 201);
});

// Remove a label from a message
app.delete("/:id/labels/:label", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");
  const label = c.req.param("label").trim().toLowerCase();

  const deleted = await db
    .delete(messageLabels)
    .where(and(eq(messageLabels.messageId, messageId), eq(messageLabels.agentId, agentId), eq(messageLabels.label, label)))
    .returning();

  if (deleted.length === 0) return c.json({ error: "Label not found", code: "NOT_FOUND" }, 404);
  await audit(agentId, "message.label_remove", "message", messageId, { label });
  return c.json({ ok: true });
});

// List labels on a message (only the requesting agent's labels)
app.get("/:id/labels", async (c) => {
  const agentId = c.get("agentId");
  const messageId = c.req.param("id");

  // Verify access
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg) return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
  if (msg.fromAgent !== agentId && msg.toAgent !== agentId) {
    return c.json({ error: "Not authorized", code: "FORBIDDEN" }, 403);
  }

  const rows = await db
    .select()
    .from(messageLabels)
    .where(and(eq(messageLabels.messageId, messageId), eq(messageLabels.agentId, agentId)));

  return c.json({
    message_id: messageId,
    labels: rows.map((r) => ({ id: r.id, label: r.label, created_at: r.createdAt })),
    count: rows.length,
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
    ...(message.expiresAt ? { expires_at: message.expiresAt } : {}),
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
