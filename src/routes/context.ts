import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { sharedFacts } from "../db/schema.js";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { contactScope, roomScope, workspaceScope, isValidFactKey, verifyContactAccess } from "../lib/context.js";
import { requireWorkspaceMember, requireRoomMember } from "../lib/scope-middleware.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// --- Room-scoped fact endpoints (must be before /:contactId to avoid route conflicts) ---

app.get("/room/:roomId/facts", requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  const scope = roomScope(roomId);
  const facts = await db
    .select()
    .from(sharedFacts)
    .where(eq(sharedFacts.scope, scope));

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

app.get("/room/:roomId/facts/:key", requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
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

app.put("/room/:roomId/facts/:key", requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const key = c.req.param("key");
  const body = await c.req.json<{ value: unknown }>();

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  if (!("value" in body)) return c.json({ error: "value is required", code: "MISSING_FIELD" }, 400);

  const scope = roomScope(roomId);
  const ifMatch = c.req.header("If-Match");
  const existing = await db
    .select()
    .from(sharedFacts)
    .where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)))
    .limit(1);

  if (existing.length > 0) {
    if (ifMatch && ifMatch !== String(existing[0].version)) {
      return c.json({ error: "Version mismatch", code: "VALIDATION_ERROR", current_version: existing[0].version }, 412);
    }
    const nextVersion = existing[0].version + 1;
    await db
      .update(sharedFacts)
      .set({ value: body.value, version: nextVersion, updatedBy: agentId, updatedAt: new Date() })
      .where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)));
    await audit(agentId, "fact.upsert", "shared_fact", `${scope}:${key}`, { room_id: roomId, key, version: nextVersion });
    return c.json({ key, value: body.value, version: nextVersion, updated_by: agentId });
  } else {
    if (ifMatch && ifMatch !== "*") {
      return c.json({ error: "Fact not found for If-Match", code: "NOT_FOUND" }, 412);
    }
    await db.insert(sharedFacts).values({ scope, key, value: body.value, updatedBy: agentId });
  }
  await audit(agentId, "fact.upsert", "shared_fact", `${scope}:${key}`, { room_id: roomId, key, version: 1 });
  return c.json({ key, value: body.value, version: 1, updated_by: agentId });
});

app.delete("/room/:roomId/facts/:key", requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const key = c.req.param("key");

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);

  await db
    .delete(sharedFacts)
    .where(and(eq(sharedFacts.scope, roomScope(roomId)), eq(sharedFacts.key, key)));
  await audit(agentId, "fact.delete", "shared_fact", `${roomScope(roomId)}:${key}`, { room_id: roomId, key });
  return c.json({ ok: true });
});

// --- Workspace-scoped fact endpoints ---

app.get("/workspace/:workspaceId/facts", requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");

  const scope = workspaceScope(workspaceId);
  const facts = await db.select().from(sharedFacts).where(eq(sharedFacts.scope, scope));

  return c.json({
    facts: facts.map((f) => ({ key: f.key, value: f.value, version: f.version, updated_by: f.updatedBy, updated_at: f.updatedAt })),
  });
});

app.get("/workspace/:workspaceId/facts/:key", requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const key = c.req.param("key");

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);

  const [fact] = await db.select().from(sharedFacts).where(and(eq(sharedFacts.scope, workspaceScope(workspaceId)), eq(sharedFacts.key, key))).limit(1);
  if (!fact) return c.json({ error: "Fact not found", code: "NOT_FOUND" }, 404);
  return c.json({ key: fact.key, value: fact.value, version: fact.version, updated_by: fact.updatedBy, updated_at: fact.updatedAt });
});

app.put("/workspace/:workspaceId/facts/:key", requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const key = c.req.param("key");
  const body = await c.req.json<{ value: unknown }>();

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  if (!("value" in body)) return c.json({ error: "value is required", code: "MISSING_FIELD" }, 400);

  const scope = workspaceScope(workspaceId);
  const ifMatch = c.req.header("If-Match");
  const existing = await db.select().from(sharedFacts).where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key))).limit(1);

  if (existing.length > 0) {
    if (ifMatch && ifMatch !== String(existing[0].version)) {
      return c.json({ error: "Version mismatch", code: "VALIDATION_ERROR", current_version: existing[0].version }, 412);
    }
    const nextVersion = existing[0].version + 1;
    await db.update(sharedFacts).set({ value: body.value, version: nextVersion, updatedBy: agentId, updatedAt: new Date() }).where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)));
    await audit(agentId, "fact.upsert", "shared_fact", `${scope}:${key}`, { workspace_id: workspaceId, key, version: nextVersion });
    return c.json({ key, value: body.value, version: nextVersion, updated_by: agentId });
  } else {
    if (ifMatch && ifMatch !== "*") {
      return c.json({ error: "Fact not found for If-Match", code: "NOT_FOUND" }, 412);
    }
    await db.insert(sharedFacts).values({ scope, key, value: body.value, updatedBy: agentId });
  }
  await audit(agentId, "fact.upsert", "shared_fact", `${scope}:${key}`, { workspace_id: workspaceId, key, version: 1 });
  return c.json({ key, value: body.value, version: 1, updated_by: agentId });
});

app.delete("/workspace/:workspaceId/facts/:key", requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const key = c.req.param("key");

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);

  await db.delete(sharedFacts).where(and(eq(sharedFacts.scope, workspaceScope(workspaceId)), eq(sharedFacts.key, key)));
  await audit(agentId, "fact.delete", "shared_fact", `${workspaceScope(workspaceId)}:${key}`, { workspace_id: workspaceId, key });
  return c.json({ ok: true });
});

// --- Contact-scoped fact endpoints ---

app.get("/:contactId/facts", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const scope = contactScope(agentId, contactId);
  const facts = await db
    .select()
    .from(sharedFacts)
    .where(eq(sharedFacts.scope, scope));

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

app.get("/:contactId/facts/:key", async (c) => {
  const agentId = c.get("agentId");
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

app.put("/:contactId/facts/:key", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const key = c.req.param("key");
  const body = await c.req.json<{ value: unknown }>();

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  if (!("value" in body)) return c.json({ error: "value is required", code: "MISSING_FIELD" }, 400);
  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const scope = contactScope(agentId, contactId);
  const ifMatch = c.req.header("If-Match");
  const existing = await db
    .select()
    .from(sharedFacts)
    .where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)))
    .limit(1);

  if (existing.length > 0) {
    if (ifMatch && ifMatch !== String(existing[0].version)) {
      return c.json({ error: "Version mismatch", code: "VALIDATION_ERROR", current_version: existing[0].version }, 412);
    }
    const nextVersion = existing[0].version + 1;
    await db
      .update(sharedFacts)
      .set({ value: body.value, version: nextVersion, updatedBy: agentId, updatedAt: new Date() })
      .where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)));
    await audit(agentId, "fact.upsert", "shared_fact", `${scope}:${key}`, { contact_id: contactId, key, version: nextVersion });
    return c.json({ key, value: body.value, version: nextVersion, updated_by: agentId });
  } else {
    if (ifMatch && ifMatch !== "*") {
      return c.json({ error: "Fact not found for If-Match", code: "NOT_FOUND" }, 412);
    }
    await db.insert(sharedFacts).values({ scope, key, value: body.value, updatedBy: agentId });
  }
  await audit(agentId, "fact.upsert", "shared_fact", `${scope}:${key}`, { contact_id: contactId, key, version: 1 });
  return c.json({ key, value: body.value, version: 1, updated_by: agentId });
});

app.delete("/:contactId/facts/:key", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const key = c.req.param("key");

  if (!isValidFactKey(key)) return c.json({ error: "Invalid fact key", code: "INVALID_INPUT" }, 400);
  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  await db
    .delete(sharedFacts)
    .where(and(eq(sharedFacts.scope, contactScope(agentId, contactId)), eq(sharedFacts.key, key)));
  await audit(agentId, "fact.delete", "shared_fact", `${contactScope(agentId, contactId)}:${key}`, { contact_id: contactId, key });
  return c.json({ ok: true });
});

export default app;
