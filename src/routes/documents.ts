import { Hono } from "hono";
import { and, eq, desc, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { sharedDocuments, sharedDocumentVersions } from "../db/schema.js";
import { authMiddleware } from "../lib/auth.js";
import { contactScope, roomScope, workspaceScope, verifyContactAccess } from "../lib/context.js";
import { requireWorkspaceMember, requireRoomMember } from "../lib/scope-middleware.js";
import { audit } from "../lib/audit.js";
import { parsePaginationQuery, paginateResults } from "../lib/pagination.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { requireValidUUIDs } from "../lib/errors.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();
const MAX_DOC_NAME_LENGTH = 255;
const MAX_DOC_BODY_BYTES = 1024 * 1024; // 1MB
const MAX_CONTENT_TYPE_LENGTH = 100;

app.use("/*", authMiddleware);

// --- Room-scoped document endpoints (must be before /:contactId to avoid route conflicts) ---

app.post("/room/:roomId", requireValidUUIDs("roomId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  const rateLimit = await checkRateLimit(`docs:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{ name: string; body: string; content_type?: string }>();
  if (!body.name || !body.body) return c.json({ error: "name and body are required", code: "MISSING_FIELD" }, 400);
  if (body.name.length > MAX_DOC_NAME_LENGTH) return c.json({ error: `name must be ${MAX_DOC_NAME_LENGTH} characters or fewer`, code: "INVALID_FIELD" }, 400);
  if (body.body.length > MAX_DOC_BODY_BYTES) return c.json({ error: "body exceeds 1MB limit", code: "VALIDATION_ERROR" }, 413);
  if (body.content_type && body.content_type.length > MAX_CONTENT_TYPE_LENGTH) return c.json({ error: `content_type must be ${MAX_CONTENT_TYPE_LENGTH} characters or fewer`, code: "INVALID_FIELD" }, 400);

  const scope = roomScope(roomId);

  const [doc] = await db
    .insert(sharedDocuments)
    .values({
      scope,
      name: body.name,
      body: body.body,
      contentType: body.content_type || "text/markdown",
      lastEditedBy: agentId,
    })
    .returning();

  await db.insert(sharedDocumentVersions).values({
    documentId: doc.id,
    version: 1,
    body: body.body,
    editedBy: agentId,
  });

  await audit(agentId, "document.created", "shared_document", doc.id, { scope, name: body.name });

  return c.json({
    id: doc.id,
    name: doc.name,
    content_type: doc.contentType,
    version: doc.version,
    last_edited_by: doc.lastEditedBy,
    created_at: doc.createdAt,
  }, 201);
});

app.get("/room/:roomId", requireValidUUIDs("roomId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const roomId = c.req.param("roomId");
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const scope = roomScope(roomId);
  const conditions = [eq(sharedDocuments.scope, scope)];
  if (cursor) {
    conditions.push(
      or(
        lt(sharedDocuments.createdAt, cursor.createdAt),
        and(eq(sharedDocuments.createdAt, cursor.createdAt), lt(sharedDocuments.id, cursor.id))
      )!
    );
  }

  const docs = await db
    .select()
    .from(sharedDocuments)
    .where(and(...conditions))
    .orderBy(desc(sharedDocuments.createdAt), desc(sharedDocuments.id))
    .limit(limit + 1);

  const page = paginateResults(docs, limit);
  return c.json({
    documents: page.items.map(d => ({
      id: d.id,
      name: d.name,
      content_type: d.contentType,
      version: d.version,
      last_edited_by: d.lastEditedBy,
      updated_at: d.updatedAt,
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

app.get("/room/:roomId/:docId", requireValidUUIDs("roomId", "docId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const roomId = c.req.param("roomId");
  const docId = c.req.param("docId");

  const [doc] = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.id, docId))
    .limit(1);

  if (!doc || doc.scope !== roomScope(roomId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  return c.json({
    id: doc.id,
    name: doc.name,
    content_type: doc.contentType,
    body: doc.body,
    version: doc.version,
    last_edited_by: doc.lastEditedBy,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  });
});

app.put("/room/:roomId/:docId", requireValidUUIDs("roomId", "docId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`docs:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const roomId = c.req.param("roomId");
  const docId = c.req.param("docId");

  const body = await c.req.json<{ body: string; name?: string }>();
  if (!body.body) return c.json({ error: "body is required", code: "MISSING_FIELD" }, 400);
  if (body.body.length > MAX_DOC_BODY_BYTES) return c.json({ error: "body exceeds 1MB limit", code: "VALIDATION_ERROR" }, 413);
  if (body.name && body.name.length > MAX_DOC_NAME_LENGTH) return c.json({ error: `name must be ${MAX_DOC_NAME_LENGTH} characters or fewer`, code: "INVALID_FIELD" }, 400);

  const [existing] = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.id, docId))
    .limit(1);

  if (!existing || existing.scope !== roomScope(roomId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const newVersion = existing.version + 1;

  await db.insert(sharedDocumentVersions).values({
    documentId: docId,
    version: newVersion,
    body: body.body,
    editedBy: agentId,
  });

  const updates: Record<string, unknown> = {
    body: body.body,
    version: newVersion,
    lastEditedBy: agentId,
    updatedAt: new Date(),
  };
  if (body.name) updates.name = body.name;

  const [updated] = await db
    .update(sharedDocuments)
    .set(updates)
    .where(eq(sharedDocuments.id, docId))
    .returning();

  await audit(agentId, "document.updated", "shared_document", docId, { version: newVersion });

  return c.json({
    id: updated.id,
    name: updated.name,
    version: updated.version,
    last_edited_by: updated.lastEditedBy,
    updated_at: updated.updatedAt,
  });
});

// Room document version history
app.get("/room/:roomId/:docId/versions", requireValidUUIDs("roomId", "docId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const roomId = c.req.param("roomId");
  const docId = c.req.param("docId");

  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== roomScope(roomId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const { limit, cursor } = parsePaginationQuery({ limit: c.req.query("limit"), cursor: c.req.query("cursor") });
  const conditions = [eq(sharedDocumentVersions.documentId, docId)];
  if (cursor) {
    conditions.push(
      or(
        lt(sharedDocumentVersions.createdAt, cursor.createdAt),
        and(eq(sharedDocumentVersions.createdAt, cursor.createdAt), lt(sharedDocumentVersions.id, cursor.id))
      )!
    );
  }

  const versions = await db
    .select()
    .from(sharedDocumentVersions)
    .where(and(...conditions))
    .orderBy(desc(sharedDocumentVersions.createdAt), desc(sharedDocumentVersions.id))
    .limit(limit + 1);

  const page = paginateResults(versions, limit);
  return c.json({
    versions: page.items.map(v => ({
      version: v.version,
      edited_by: v.editedBy,
      created_at: v.createdAt,
      body_length: v.body.length,
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

// Room document specific version
app.get("/room/:roomId/:docId/versions/:version", requireValidUUIDs("roomId", "docId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const roomId = c.req.param("roomId");
  const docId = c.req.param("docId");
  const version = parseInt(c.req.param("version"));
  if (isNaN(version) || version < 1) return c.json({ error: "Invalid version", code: "INVALID_INPUT" }, 400);

  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== roomScope(roomId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const [v] = await db
    .select()
    .from(sharedDocumentVersions)
    .where(and(
      eq(sharedDocumentVersions.documentId, docId),
      eq(sharedDocumentVersions.version, version)
    ))
    .limit(1);

  if (!v) return c.json({ error: "Version not found", code: "NOT_FOUND" }, 404);

  return c.json({
    version: v.version,
    body: v.body,
    edited_by: v.editedBy,
    created_at: v.createdAt,
  });
});

app.delete("/room/:roomId/:docId", requireValidUUIDs("roomId", "docId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`docs:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const roomId = c.req.param("roomId");
  const docId = c.req.param("docId");

  const [doc] = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.id, docId))
    .limit(1);

  if (!doc || doc.scope !== roomScope(roomId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  await db.delete(sharedDocumentVersions).where(eq(sharedDocumentVersions.documentId, docId));
  await db.delete(sharedDocuments).where(eq(sharedDocuments.id, docId));

  await audit(agentId, "document.deleted", "shared_document", docId, { scope: roomScope(roomId) });

  return c.json({ ok: true });
});

// --- Workspace-scoped document endpoints ---

app.post("/workspace/:workspaceId", requireValidUUIDs("workspaceId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");

  const rateLimit = await checkRateLimit(`docs:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{ name: string; body: string; content_type?: string }>();
  if (!body.name || !body.body) return c.json({ error: "name and body are required", code: "MISSING_FIELD" }, 400);
  if (body.name.length > MAX_DOC_NAME_LENGTH) return c.json({ error: `name must be ${MAX_DOC_NAME_LENGTH} characters or fewer`, code: "INVALID_FIELD" }, 400);
  if (body.body.length > MAX_DOC_BODY_BYTES) return c.json({ error: "body exceeds 1MB limit", code: "VALIDATION_ERROR" }, 413);
  if (body.content_type && body.content_type.length > MAX_CONTENT_TYPE_LENGTH) return c.json({ error: `content_type must be ${MAX_CONTENT_TYPE_LENGTH} characters or fewer`, code: "INVALID_FIELD" }, 400);

  const scope = workspaceScope(workspaceId);

  const [doc] = await db
    .insert(sharedDocuments)
    .values({ scope, name: body.name, body: body.body, contentType: body.content_type || "text/markdown", lastEditedBy: agentId })
    .returning();

  await db.insert(sharedDocumentVersions).values({ documentId: doc.id, version: 1, body: body.body, editedBy: agentId });
  await audit(agentId, "document.created", "shared_document", doc.id, { scope, name: body.name });

  return c.json({ id: doc.id, name: doc.name, content_type: doc.contentType, version: doc.version, last_edited_by: doc.lastEditedBy, created_at: doc.createdAt }, 201);
});

app.get("/workspace/:workspaceId", requireValidUUIDs("workspaceId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const workspaceId = c.req.param("workspaceId");
  const { limit, cursor } = parsePaginationQuery({ limit: c.req.query("limit"), cursor: c.req.query("cursor") });

  const scope = workspaceScope(workspaceId);
  const conditions = [eq(sharedDocuments.scope, scope)];
  if (cursor) {
    conditions.push(or(lt(sharedDocuments.createdAt, cursor.createdAt), and(eq(sharedDocuments.createdAt, cursor.createdAt), lt(sharedDocuments.id, cursor.id)))!);
  }

  const docs = await db.select().from(sharedDocuments).where(and(...conditions)).orderBy(desc(sharedDocuments.createdAt), desc(sharedDocuments.id)).limit(limit + 1);
  const page = paginateResults(docs, limit);
  return c.json({
    documents: page.items.map(d => ({ id: d.id, name: d.name, content_type: d.contentType, version: d.version, last_edited_by: d.lastEditedBy, updated_at: d.updatedAt })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

app.get("/workspace/:workspaceId/:docId", requireValidUUIDs("workspaceId", "docId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const workspaceId = c.req.param("workspaceId");
  const docId = c.req.param("docId");

  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== workspaceScope(workspaceId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  return c.json({ id: doc.id, name: doc.name, content_type: doc.contentType, body: doc.body, version: doc.version, last_edited_by: doc.lastEditedBy, created_at: doc.createdAt, updated_at: doc.updatedAt });
});

app.put("/workspace/:workspaceId/:docId", requireValidUUIDs("workspaceId", "docId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`docs:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const workspaceId = c.req.param("workspaceId");
  const docId = c.req.param("docId");

  const body = await c.req.json<{ body: string; name?: string }>();
  if (!body.body) return c.json({ error: "body is required", code: "MISSING_FIELD" }, 400);
  if (body.body.length > MAX_DOC_BODY_BYTES) return c.json({ error: "body exceeds 1MB limit", code: "VALIDATION_ERROR" }, 413);
  if (body.name && body.name.length > MAX_DOC_NAME_LENGTH) return c.json({ error: `name must be ${MAX_DOC_NAME_LENGTH} characters or fewer`, code: "INVALID_FIELD" }, 400);

  const [existing] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!existing || existing.scope !== workspaceScope(workspaceId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const newVersion = existing.version + 1;
  await db.insert(sharedDocumentVersions).values({ documentId: docId, version: newVersion, body: body.body, editedBy: agentId });
  const updates: Record<string, unknown> = { body: body.body, version: newVersion, lastEditedBy: agentId, updatedAt: new Date() };
  if (body.name) updates.name = body.name;
  const [updated] = await db.update(sharedDocuments).set(updates).where(eq(sharedDocuments.id, docId)).returning();
  await audit(agentId, "document.updated", "shared_document", docId, { version: newVersion });

  return c.json({ id: updated.id, name: updated.name, version: updated.version, last_edited_by: updated.lastEditedBy, updated_at: updated.updatedAt });
});

// Workspace document version history
app.get("/workspace/:workspaceId/:docId/versions", requireValidUUIDs("workspaceId", "docId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const workspaceId = c.req.param("workspaceId");
  const docId = c.req.param("docId");

  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== workspaceScope(workspaceId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const { limit, cursor } = parsePaginationQuery({ limit: c.req.query("limit"), cursor: c.req.query("cursor") });
  const conditions = [eq(sharedDocumentVersions.documentId, docId)];
  if (cursor) {
    conditions.push(
      or(
        lt(sharedDocumentVersions.createdAt, cursor.createdAt),
        and(eq(sharedDocumentVersions.createdAt, cursor.createdAt), lt(sharedDocumentVersions.id, cursor.id))
      )!
    );
  }

  const versions = await db
    .select()
    .from(sharedDocumentVersions)
    .where(and(...conditions))
    .orderBy(desc(sharedDocumentVersions.createdAt), desc(sharedDocumentVersions.id))
    .limit(limit + 1);

  const page = paginateResults(versions, limit);
  return c.json({
    versions: page.items.map(v => ({
      version: v.version,
      edited_by: v.editedBy,
      created_at: v.createdAt,
      body_length: v.body.length,
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

// Workspace document specific version
app.get("/workspace/:workspaceId/:docId/versions/:version", requireValidUUIDs("workspaceId", "docId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const workspaceId = c.req.param("workspaceId");
  const docId = c.req.param("docId");
  const version = parseInt(c.req.param("version"));
  if (isNaN(version) || version < 1) return c.json({ error: "Invalid version", code: "INVALID_INPUT" }, 400);

  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== workspaceScope(workspaceId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const [v] = await db
    .select()
    .from(sharedDocumentVersions)
    .where(and(
      eq(sharedDocumentVersions.documentId, docId),
      eq(sharedDocumentVersions.version, version)
    ))
    .limit(1);

  if (!v) return c.json({ error: "Version not found", code: "NOT_FOUND" }, 404);

  return c.json({
    version: v.version,
    body: v.body,
    edited_by: v.editedBy,
    created_at: v.createdAt,
  });
});

app.delete("/workspace/:workspaceId/:docId", requireValidUUIDs("workspaceId", "docId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`docs:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const workspaceId = c.req.param("workspaceId");
  const docId = c.req.param("docId");

  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== workspaceScope(workspaceId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  await db.delete(sharedDocumentVersions).where(eq(sharedDocumentVersions.documentId, docId));
  await db.delete(sharedDocuments).where(eq(sharedDocuments.id, docId));
  await audit(agentId, "document.deleted", "shared_document", docId, { scope: workspaceScope(workspaceId) });

  return c.json({ ok: true });
});

// --- Contact-scoped document endpoints ---

// Create a document
app.post("/:contactId", requireValidUUIDs("contactId"), async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");

  const rateLimit = await checkRateLimit(`docs:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const body = await c.req.json<{ name: string; body: string; content_type?: string }>();
  if (!body.name || !body.body) return c.json({ error: "name and body are required", code: "MISSING_FIELD" }, 400);
  if (body.name.length > MAX_DOC_NAME_LENGTH) return c.json({ error: `name must be ${MAX_DOC_NAME_LENGTH} characters or fewer`, code: "INVALID_FIELD" }, 400);
  if (body.body.length > MAX_DOC_BODY_BYTES) return c.json({ error: "body exceeds 1MB limit", code: "VALIDATION_ERROR" }, 413);
  if (body.content_type && body.content_type.length > MAX_CONTENT_TYPE_LENGTH) return c.json({ error: `content_type must be ${MAX_CONTENT_TYPE_LENGTH} characters or fewer`, code: "INVALID_FIELD" }, 400);

  const scope = contactScope(agentId, contactId);

  const [doc] = await db
    .insert(sharedDocuments)
    .values({
      scope,
      name: body.name,
      body: body.body,
      contentType: body.content_type || "text/markdown",
      lastEditedBy: agentId,
    })
    .returning();

  // Save first version
  await db.insert(sharedDocumentVersions).values({
    documentId: doc.id,
    version: 1,
    body: body.body,
    editedBy: agentId,
  });

  await audit(agentId, "document.created", "shared_document", doc.id, { scope, name: body.name });

  return c.json({
    id: doc.id,
    name: doc.name,
    content_type: doc.contentType,
    version: doc.version,
    last_edited_by: doc.lastEditedBy,
    created_at: doc.createdAt,
  }, 201);
});

// List documents for a contact pair
app.get("/:contactId", requireValidUUIDs("contactId"), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const contactId = c.req.param("contactId");
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const scope = contactScope(agentId, contactId);
  const conditions = [eq(sharedDocuments.scope, scope)];
  if (cursor) {
    conditions.push(
      or(
        lt(sharedDocuments.createdAt, cursor.createdAt),
        and(eq(sharedDocuments.createdAt, cursor.createdAt), lt(sharedDocuments.id, cursor.id))
      )!
    );
  }

  const docs = await db
    .select()
    .from(sharedDocuments)
    .where(and(...conditions))
    .orderBy(desc(sharedDocuments.createdAt), desc(sharedDocuments.id))
    .limit(limit + 1);

  const page = paginateResults(docs, limit);
  return c.json({
    documents: page.items.map(d => ({
      id: d.id,
      name: d.name,
      content_type: d.contentType,
      version: d.version,
      last_edited_by: d.lastEditedBy,
      updated_at: d.updatedAt,
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

// Get a document (latest version)
app.get("/:contactId/:docId", requireValidUUIDs("contactId", "docId"), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const contactId = c.req.param("contactId");
  const docId = c.req.param("docId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const scope = contactScope(agentId, contactId);
  const [doc] = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.id, docId))
    .limit(1);

  if (!doc || doc.scope !== scope) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  return c.json({
    id: doc.id,
    name: doc.name,
    content_type: doc.contentType,
    body: doc.body,
    version: doc.version,
    last_edited_by: doc.lastEditedBy,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  });
});

// Update a document (creates new version)
app.put("/:contactId/:docId", requireValidUUIDs("contactId", "docId"), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`docs:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const contactId = c.req.param("contactId");
  const docId = c.req.param("docId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const body = await c.req.json<{ body: string; name?: string }>();
  if (!body.body) return c.json({ error: "body is required", code: "MISSING_FIELD" }, 400);
  if (body.body.length > MAX_DOC_BODY_BYTES) return c.json({ error: "body exceeds 1MB limit", code: "VALIDATION_ERROR" }, 413);
  if (body.name && body.name.length > MAX_DOC_NAME_LENGTH) return c.json({ error: `name must be ${MAX_DOC_NAME_LENGTH} characters or fewer`, code: "INVALID_FIELD" }, 400);

  const scope = contactScope(agentId, contactId);
  const [existing] = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.id, docId))
    .limit(1);

  if (!existing || existing.scope !== scope) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const newVersion = existing.version + 1;

  // Save version history
  await db.insert(sharedDocumentVersions).values({
    documentId: docId,
    version: newVersion,
    body: body.body,
    editedBy: agentId,
  });

  // Update current document
  const updates: Record<string, unknown> = {
    body: body.body,
    version: newVersion,
    lastEditedBy: agentId,
    updatedAt: new Date(),
  };
  if (body.name) updates.name = body.name;

  const [updated] = await db
    .update(sharedDocuments)
    .set(updates)
    .where(eq(sharedDocuments.id, docId))
    .returning();

  await audit(agentId, "document.updated", "shared_document", docId, { version: newVersion });

  return c.json({
    id: updated.id,
    name: updated.name,
    version: updated.version,
    last_edited_by: updated.lastEditedBy,
    updated_at: updated.updatedAt,
  });
});

// Get version history
app.get("/:contactId/:docId/versions", requireValidUUIDs("contactId", "docId"), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const contactId = c.req.param("contactId");
  const docId = c.req.param("docId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const scope = contactScope(agentId, contactId);
  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== scope) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const { limit, cursor } = parsePaginationQuery({ limit: c.req.query("limit"), cursor: c.req.query("cursor") });
  const conditions = [eq(sharedDocumentVersions.documentId, docId)];
  if (cursor) {
    conditions.push(
      or(
        lt(sharedDocumentVersions.createdAt, cursor.createdAt),
        and(eq(sharedDocumentVersions.createdAt, cursor.createdAt), lt(sharedDocumentVersions.id, cursor.id))
      )!
    );
  }

  const versions = await db
    .select()
    .from(sharedDocumentVersions)
    .where(and(...conditions))
    .orderBy(desc(sharedDocumentVersions.createdAt), desc(sharedDocumentVersions.id))
    .limit(limit + 1);

  const page = paginateResults(versions, limit);
  return c.json({
    versions: page.items.map(v => ({
      version: v.version,
      edited_by: v.editedBy,
      created_at: v.createdAt,
      body_length: v.body.length,
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

// Get a specific version
app.get("/:contactId/:docId/versions/:version", requireValidUUIDs("contactId", "docId"), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const contactId = c.req.param("contactId");
  const docId = c.req.param("docId");
  const version = parseInt(c.req.param("version"));
  if (isNaN(version) || version < 1) return c.json({ error: "Invalid version", code: "INVALID_INPUT" }, 400);

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const scope = contactScope(agentId, contactId);
  const [docCheck] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!docCheck || docCheck.scope !== scope) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const [v] = await db
    .select()
    .from(sharedDocumentVersions)
    .where(and(
      eq(sharedDocumentVersions.documentId, docId),
      eq(sharedDocumentVersions.version, version)
    ))
    .limit(1);

  if (!v) return c.json({ error: "Version not found", code: "NOT_FOUND" }, 404);

  return c.json({
    version: v.version,
    body: v.body,
    edited_by: v.editedBy,
    created_at: v.createdAt,
  });
});

// Delete a document and all its versions
app.delete("/:contactId/:docId", requireValidUUIDs("contactId", "docId"), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`docs:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const contactId = c.req.param("contactId");
  const docId = c.req.param("docId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const [doc] = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.id, docId))
    .limit(1);

  if (!doc) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  // Verify document belongs to this contact scope
  const scope = contactScope(agentId, contactId);
  if (doc.scope !== scope) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  // Delete versions first, then document
  await db.delete(sharedDocumentVersions).where(eq(sharedDocumentVersions.documentId, docId));
  await db.delete(sharedDocuments).where(eq(sharedDocuments.id, docId));

  await audit(agentId, "document.deleted", "shared_document", docId, { scope });

  return c.json({ ok: true });
});

export default app;
