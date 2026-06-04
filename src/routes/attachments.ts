import { Hono } from "hono";
import { db } from "../db/index.js";
import { attachments, messages } from "../db/schema.js";
import { eq, and, desc, lt, or } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { canMessage } from "../lib/workspace.js";
import { parsePaginationQuery, paginateResults } from "../lib/pagination.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { requireValidUUIDs } from "../lib/errors.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

app.use("/*", authMiddleware);

// Upload an attachment (optionally linked to a message)
app.post("/", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`attachments:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{
    filename: string;
    content_type?: string;
    data: string; // base64
    message_id?: string;
  }>();

  if (!body.filename || !body.data) {
    return c.json({ error: "filename and data are required", code: "MISSING_FIELD" }, 400);
  }
  if (body.filename.length > 255) {
    return c.json({ error: "filename must be 255 characters or fewer", code: "INVALID_FIELD" }, 400);
  }
  if (body.content_type && body.content_type.length > 100) {
    return c.json({ error: "content_type must be 100 characters or fewer", code: "INVALID_FIELD" }, 400);
  }

  // Validate base64 and check size
  let sizeBytes: number;
  try {
    // Reject obviously invalid base64: must be groups of 4 chars, only valid chars, padding only at end
    if (body.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) {
      return c.json({ error: "data must be valid base64", code: "INVALID_INPUT" }, 400);
    }
    // Decode to verify and get actual byte length
    const decoded = Buffer.from(body.data, "base64");
    sizeBytes = decoded.length;
    // Roundtrip check: reject corrupted base64 that silently decodes to wrong data
    if (decoded.toString("base64") !== body.data) {
      return c.json({ error: "data must be valid base64", code: "INVALID_INPUT" }, 400);
    }
  } catch {
    return c.json({ error: "data must be valid base64", code: "INVALID_INPUT" }, 400);
  }

  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "Attachment exceeds 10MB limit", code: "VALIDATION_ERROR" }, 413);
  }

  // If linked to a message, verify the agent can access it
  if (body.message_id) {
    const [msg] = await db.select().from(messages).where(eq(messages.id, body.message_id)).limit(1);
    if (!msg) {
      return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
    }
    if (msg.fromAgent !== agentId && msg.toAgent !== agentId) {
      return c.json({ error: "Not authorized to attach to this message", code: "FORBIDDEN" }, 403);
    }
  }

  const [attachment] = await db.insert(attachments).values({
    messageId: body.message_id ?? null,
    agentId,
    filename: body.filename,
    contentType: body.content_type ?? "application/octet-stream",
    sizeBytes,
    data: body.data,
  }).returning();

  return c.json({
    id: attachment.id,
    message_id: attachment.messageId,
    filename: attachment.filename,
    content_type: attachment.contentType,
    size_bytes: attachment.sizeBytes,
    created_at: attachment.createdAt.toISOString(),
  }, 201);
});

// Download an attachment
app.get("/:id", requireValidUUIDs("id"), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const attachmentId = c.req.param("id");

  const [attachment] = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1);
  if (!attachment) {
    return c.json({ error: "Attachment not found", code: "NOT_FOUND" }, 404);
  }

  // Verify access: must be the uploader, or if linked to a message, the sender/recipient
  if (attachment.agentId !== agentId) {
    if (attachment.messageId) {
      const [msg] = await db.select().from(messages).where(eq(messages.id, attachment.messageId)).limit(1);
      if (!msg || (msg.fromAgent !== agentId && msg.toAgent !== agentId)) {
        return c.json({ error: "Not authorized to access this attachment", code: "FORBIDDEN" }, 403);
      }
    } else {
      return c.json({ error: "Not authorized to access this attachment", code: "FORBIDDEN" }, 403);
    }
  }

  return c.json({
    id: attachment.id,
    message_id: attachment.messageId,
    filename: attachment.filename,
    content_type: attachment.contentType,
    size_bytes: attachment.sizeBytes,
    data: attachment.data,
    created_at: attachment.createdAt.toISOString(),
  });
});

// List attachments for a message
app.get("/message/:messageId", requireValidUUIDs("messageId"), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const messageId = c.req.param("messageId");

  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg) {
    return c.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, 404);
  }
  if (msg.fromAgent !== agentId && msg.toAgent !== agentId) {
    return c.json({ error: "Not authorized to view these attachments", code: "FORBIDDEN" }, 403);
  }

  const results = await db.select().from(attachments)
    .where(eq(attachments.messageId, messageId))
    .orderBy(desc(attachments.createdAt))
    .limit(100);

  return c.json({
    message_id: messageId,
    attachments: results.map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.contentType,
      size_bytes: a.sizeBytes,
      created_at: a.createdAt.toISOString(),
    })),
  });
});

// Delete an attachment (only uploader can delete)
app.delete("/:id", requireValidUUIDs("id"), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`write:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const attachmentId = c.req.param("id");

  const [attachment] = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1);
  if (!attachment) {
    return c.json({ error: "Attachment not found", code: "NOT_FOUND" }, 404);
  }
  if (attachment.agentId !== agentId) {
    return c.json({ error: "Only the uploader can delete an attachment", code: "NOT_OWNER" }, 403);
  }

  await db.delete(attachments).where(eq(attachments.id, attachmentId));
  return c.json({ ok: true });
});

// List my attachments
app.get("/", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const { limit, cursor } = parsePaginationQuery({ limit: c.req.query("limit"), cursor: c.req.query("cursor") });
  const conditions = [eq(attachments.agentId, agentId)];
  if (cursor) {
    conditions.push(
      or(
        lt(attachments.createdAt, cursor.createdAt),
        and(eq(attachments.createdAt, cursor.createdAt), lt(attachments.id, cursor.id))
      )!
    );
  }

  const results = await db.select().from(attachments)
    .where(and(...conditions))
    .orderBy(desc(attachments.createdAt), desc(attachments.id))
    .limit(limit + 1);

  const page = paginateResults(results, limit);
  return c.json({
    attachments: page.items.map((a) => ({
      id: a.id,
      message_id: a.messageId,
      filename: a.filename,
      content_type: a.contentType,
      size_bytes: a.sizeBytes,
      created_at: a.createdAt.toISOString(),
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

export default app;
