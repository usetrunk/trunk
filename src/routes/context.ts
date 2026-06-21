import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { sharedFacts } from "../db/schema.js";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { contactScope, roomScope, workspaceScope, isValidFactKey, isValidFactValue, verifyContactAccess } from "../lib/context.js";
import { requireWorkspaceMember, requireRoomMember } from "../lib/scope-middleware.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { requireValidUUIDs, isValidUUID } from "../lib/errors.js";
import { recordFactWrite, getFactHistory, FactHistoryError } from "../lib/fact-history.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// --- Room-scoped fact endpoints (must be before /:contactId to avoid route conflicts) ---

app.get("/room/:roomId/facts", requireValidUUIDs("roomId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const roomId = c.req.param("roomId");

  const scope = roomScope(roomId);
  const facts = await db
    .select()
    .from(sharedFacts)
    .where(eq(sharedFacts.scope, scope))
    .limit(200);

  return c.json({
    facts: facts.map((f) => ({
      key: f.key,
      value: f.value,
      version: f.version,
      updated_by: f.updatedBy,
      updated_at: f.updatedAt,
    })),
  });
});

app.get("/room/:roomId/facts/:key", requireValidUUIDs("roomId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  const roomId = c.req.param("roomId");
  const key = c.req.param("key");

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);

  const [fact] = await db
    .select()
    .from(sharedFacts)
    .where(and(eq(sharedFacts.scope, roomScope(roomId)), eq(sharedFacts.key, key)))
    .limit(1);

  if (!fact) return c.json({ error: "Fact not found", code: "NOT_FOUND" }, 404);
  return c.json({ key: fact.key, value: fact.value, version: fact.version, updated_by: fact.updatedBy, updated_at: fact.updatedAt });
});

app.put("/room/:roomId/facts/:key", requireValidUUIDs("roomId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const key = c.req.param("key");

  const rateLimit = await checkRateLimit(`facts:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  const body = await c.req.json<{ value: unknown; reason?: string; source_message_id?: string; source_thread_id?: string }>();

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  if (!("value" in body)) return c.json({ error: "value is required", code: "MISSING_FIELD" }, 400);
  if (!isValidFactValue(body.value)) return c.json({ error: "Fact value too large (max 10KB serialized)", code: "PAYLOAD_TOO_LARGE" }, 400);
  if (body.source_message_id && !isValidUUID(body.source_message_id)) {
    return c.json({ error: "source_message_id must be a valid UUID", code: "INVALID_INPUT" }, 400);
  }

  const scope = roomScope(roomId);
  const ifMatch = c.req.header("If-Match");

  const [existing] = await db.select().from(sharedFacts).where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key))).limit(1);
  if (ifMatch) {
    if (existing) {
      if (ifMatch !== String(existing.version)) {
        return c.json({ error: "Version mismatch", code: "VALIDATION_ERROR", current_version: existing.version }, 412);
      }
    } else if (ifMatch !== "*") {
      return c.json({ error: "Fact not found for If-Match", code: "NOT_FOUND" }, 412);
    }
  }

  try {
    const { version } = await recordFactWrite(scope, key, body.value, agentId, {
      reason: body.reason ?? null,
      source_message_id: body.source_message_id ?? null,
      source_thread_id: body.source_thread_id ?? null,
    });
    await audit(agentId, "fact.upsert", "shared_fact", `${scope}:${key}`, { room_id: roomId, key, version, reason: body.reason });
    return c.json({ key, value: body.value, version, updated_by: agentId });
  } catch (err) {
    if (err instanceof FactHistoryError) {
      return c.json({ error: err.message, code: "VALIDATION_ERROR" }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
});

app.delete("/room/:roomId/facts/:key", requireValidUUIDs("roomId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const key = c.req.param("key");

  const rateLimit = await checkRateLimit(`facts:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);

  await db
    .delete(sharedFacts)
    .where(and(eq(sharedFacts.scope, roomScope(roomId)), eq(sharedFacts.key, key)));
  await audit(agentId, "fact.delete", "shared_fact", `${roomScope(roomId)}:${key}`, { room_id: roomId, key });
  return c.json({ ok: true });
});

// --- Workspace-scoped fact endpoints ---

app.get("/workspace/:workspaceId/facts", requireValidUUIDs("workspaceId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const workspaceId = c.req.param("workspaceId");

  const scope = workspaceScope(workspaceId);
  const facts = await db.select().from(sharedFacts).where(eq(sharedFacts.scope, scope)).limit(200);

  return c.json({
    facts: facts.map((f) => ({ key: f.key, value: f.value, version: f.version, updated_by: f.updatedBy, updated_at: f.updatedAt })),
  });
});

app.get("/workspace/:workspaceId/facts/:key", requireValidUUIDs("workspaceId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  const workspaceId = c.req.param("workspaceId");
  const key = c.req.param("key");

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);

  const [fact] = await db.select().from(sharedFacts).where(and(eq(sharedFacts.scope, workspaceScope(workspaceId)), eq(sharedFacts.key, key))).limit(1);
  if (!fact) return c.json({ error: "Fact not found", code: "NOT_FOUND" }, 404);
  return c.json({ key: fact.key, value: fact.value, version: fact.version, updated_by: fact.updatedBy, updated_at: fact.updatedAt });
});

app.put("/workspace/:workspaceId/facts/:key", requireValidUUIDs("workspaceId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const key = c.req.param("key");

  const rateLimit = await checkRateLimit(`facts:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  const body = await c.req.json<{ value: unknown; reason?: string; source_message_id?: string; source_thread_id?: string }>();

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  if (!("value" in body)) return c.json({ error: "value is required", code: "MISSING_FIELD" }, 400);
  if (!isValidFactValue(body.value)) return c.json({ error: "Fact value too large (max 10KB serialized)", code: "PAYLOAD_TOO_LARGE" }, 400);
  if (body.source_message_id && !isValidUUID(body.source_message_id)) {
    return c.json({ error: "source_message_id must be a valid UUID", code: "INVALID_INPUT" }, 400);
  }

  const scope = workspaceScope(workspaceId);
  const ifMatch = c.req.header("If-Match");

  const [existing] = await db.select().from(sharedFacts).where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key))).limit(1);
  if (ifMatch) {
    if (existing) {
      if (ifMatch !== String(existing.version)) {
        return c.json({ error: "Version mismatch", code: "VALIDATION_ERROR", current_version: existing.version }, 412);
      }
    } else if (ifMatch !== "*") {
      return c.json({ error: "Fact not found for If-Match", code: "NOT_FOUND" }, 412);
    }
  }

  try {
    const { version } = await recordFactWrite(scope, key, body.value, agentId, {
      reason: body.reason ?? null,
      source_message_id: body.source_message_id ?? null,
      source_thread_id: body.source_thread_id ?? null,
    });
    await audit(agentId, "fact.upsert", "shared_fact", `${scope}:${key}`, { workspace_id: workspaceId, key, version, reason: body.reason });
    return c.json({ key, value: body.value, version, updated_by: agentId });
  } catch (err) {
    if (err instanceof FactHistoryError) {
      return c.json({ error: err.message, code: "VALIDATION_ERROR" }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
});

app.delete("/workspace/:workspaceId/facts/:key", requireValidUUIDs("workspaceId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const key = c.req.param("key");

  const rateLimit = await checkRateLimit(`facts:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);

  await db.delete(sharedFacts).where(and(eq(sharedFacts.scope, workspaceScope(workspaceId)), eq(sharedFacts.key, key)));
  await audit(agentId, "fact.delete", "shared_fact", `${workspaceScope(workspaceId)}:${key}`, { workspace_id: workspaceId, key });
  return c.json({ ok: true });
});

// --- Contact-scoped fact endpoints ---

app.get("/:contactId/facts", requireValidUUIDs("contactId"), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const contactId = c.req.param("contactId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const scope = contactScope(agentId, contactId);
  const facts = await db
    .select()
    .from(sharedFacts)
    .where(eq(sharedFacts.scope, scope))
    .limit(200);

  return c.json({
    facts: facts.map((f) => ({
      key: f.key,
      value: f.value,
      version: f.version,
      updated_by: f.updatedBy,
      updated_at: f.updatedAt,
    })),
  });
});

app.get("/:contactId/facts/:key", requireValidUUIDs("contactId"), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  const contactId = c.req.param("contactId");
  const key = c.req.param("key");

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const [fact] = await db
    .select()
    .from(sharedFacts)
    .where(and(eq(sharedFacts.scope, contactScope(agentId, contactId)), eq(sharedFacts.key, key)))
    .limit(1);

  if (!fact) return c.json({ error: "Fact not found", code: "NOT_FOUND" }, 404);
  return c.json({ key: fact.key, value: fact.value, version: fact.version, updated_by: fact.updatedBy, updated_at: fact.updatedAt });
});

app.put("/:contactId/facts/:key", requireValidUUIDs("contactId"), async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const key = c.req.param("key");

  const rateLimit = await checkRateLimit(`facts:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  const body = await c.req.json<{ value: unknown; reason?: string; source_message_id?: string; source_thread_id?: string }>();

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  if (!("value" in body)) return c.json({ error: "value is required", code: "MISSING_FIELD" }, 400);
  if (!isValidFactValue(body.value)) return c.json({ error: "Fact value too large (max 10KB serialized)", code: "PAYLOAD_TOO_LARGE" }, 400);
  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);
  if (body.source_message_id && !isValidUUID(body.source_message_id)) {
    return c.json({ error: "source_message_id must be a valid UUID", code: "INVALID_INPUT" }, 400);
  }

  const scope = contactScope(agentId, contactId);
  const ifMatch = c.req.header("If-Match");

  const [existing] = await db.select().from(sharedFacts).where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key))).limit(1);
  if (ifMatch) {
    if (existing) {
      if (ifMatch !== String(existing.version)) {
        return c.json({ error: "Version mismatch", code: "VALIDATION_ERROR", current_version: existing.version }, 412);
      }
    } else if (ifMatch !== "*") {
      return c.json({ error: "Fact not found for If-Match", code: "NOT_FOUND" }, 412);
    }
  }

  try {
    const { version } = await recordFactWrite(scope, key, body.value, agentId, {
      reason: body.reason ?? null,
      source_message_id: body.source_message_id ?? null,
      source_thread_id: body.source_thread_id ?? null,
    });
    await audit(agentId, "fact.upsert", "shared_fact", `${scope}:${key}`, { contact_id: contactId, key, version, reason: body.reason });
    return c.json({ key, value: body.value, version, updated_by: agentId });
  } catch (err) {
    if (err instanceof FactHistoryError) {
      return c.json({ error: err.message, code: "VALIDATION_ERROR" }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
});

// --- Fact history (provenance) ---

app.get("/room/:roomId/facts/:key/history", requireValidUUIDs("roomId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429);

  const roomId = c.req.param("roomId");
  const key = c.req.param("key");
  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  const result = await getFactHistory(roomScope(roomId), key);
  return c.json(result);
});

app.get("/workspace/:workspaceId/facts/:key/history", requireValidUUIDs("workspaceId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429);

  const workspaceId = c.req.param("workspaceId");
  const key = c.req.param("key");
  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  const result = await getFactHistory(workspaceScope(workspaceId), key);
  return c.json(result);
});

app.get("/:contactId/facts/:key/history", requireValidUUIDs("contactId"), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429);

  const contactId = c.req.param("contactId");
  const key = c.req.param("key");
  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  if (!(await verifyContactAccess(agentId, contactId))) {
    return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);
  }
  const result = await getFactHistory(contactScope(agentId, contactId), key);
  return c.json(result);
});

app.delete("/:contactId/facts/:key", requireValidUUIDs("contactId"), async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const key = c.req.param("key");

  const rateLimit = await checkRateLimit(`facts:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  await db
    .delete(sharedFacts)
    .where(and(eq(sharedFacts.scope, contactScope(agentId, contactId)), eq(sharedFacts.key, key)));
  await audit(agentId, "fact.delete", "shared_fact", `${contactScope(agentId, contactId)}:${key}`, { contact_id: contactId, key });
  return c.json({ ok: true });
});

export default app;
