import { Hono } from "hono";
import { and, eq, desc, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { sharedDocuments, sharedDocumentVersions } from "../db/schema.js";
import { authMiddleware } from "../lib/auth.js";
import { contactScope, roomScope, workspaceScope, verifyContactAccess, verifyRoomAccess } from "../lib/context.js";
import { verifyWorkspaceAccess } from "../lib/workspace.js";
import { audit } from "../lib/audit.js";
import { parsePaginationQuery, paginateResults } from "../lib/pagination.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// --- Room-scoped document endpoints (must be before /:contactId to avoid route conflicts) ---

app.post("/room/:roomId", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  if (!(await verifyRoomAccess(agentId, roomId))) return c.json({ error: "Not a room member", code: "NOT_MEMBER" }, 403);

  const body = await c.req.json<{ name: string; body: string; content_type?: string }>();
  if (!body.name || !body.body) return c.json({ error: "name and body are required", code: "MISSING_FIELD" }, 400);

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

app.get("/room/:roomId", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  if (!(await verifyRoomAccess(agentId, roomId))) return c.json({ error: "Not a room member", code: "NOT_MEMBER" }, 403);

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

app.get("/room/:roomId/:docId", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const docId = c.req.param("docId");

  if (!(await verifyRoomAccess(agentId, roomId))) return c.json({ error: "Not a room member", code: "NOT_MEMBER" }, 403);

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

app.put("/room/:roomId/:docId", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const docId = c.req.param("docId");

  if (!(await verifyRoomAccess(agentId, roomId))) return c.json({ error: "Not a room member", code: "NOT_MEMBER" }, 403);

  const body = await c.req.json<{ body: string; name?: string }>();
  if (!body.body) return c.json({ error: "body is required", code: "MISSING_FIELD" }, 400);

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
app.get("/room/:roomId/:docId/versions", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const docId = c.req.param("docId");

  if (!(await verifyRoomAccess(agentId, roomId))) return c.json({ error: "Not a room member", code: "NOT_MEMBER" }, 403);

  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== roomScope(roomId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const versions = await db
    .select()
    .from(sharedDocumentVersions)
    .where(eq(sharedDocumentVersions.documentId, docId))
    .orderBy(desc(sharedDocumentVersions.version));

  return c.json({
    versions: versions.map(v => ({
      version: v.version,
      edited_by: v.editedBy,
      created_at: v.createdAt,
      body_length: v.body.length,
    })),
  });
});

// Room document specific version
app.get("/room/:roomId/:docId/versions/:version", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const docId = c.req.param("docId");
  const version = parseInt(c.req.param("version"));

  if (!(await verifyRoomAccess(agentId, roomId))) return c.json({ error: "Not a room member", code: "NOT_MEMBER" }, 403);

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

app.delete("/room/:roomId/:docId", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const docId = c.req.param("docId");

  if (!(await verifyRoomAccess(agentId, roomId))) return c.json({ error: "Not a room member", code: "NOT_MEMBER" }, 403);

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

app.post("/workspace/:workspaceId", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");

  if (!(await verifyWorkspaceAccess(agentId, workspaceId))) return c.json({ error: "Not a workspace member", code: "NOT_MEMBER" }, 403);

  const body = await c.req.json<{ name: string; body: string; content_type?: string }>();
  if (!body.name || !body.body) return c.json({ error: "name and body are required", code: "MISSING_FIELD" }, 400);

  const scope = workspaceScope(workspaceId);

  const [doc] = await db
    .insert(sharedDocuments)
    .values({ scope, name: body.name, body: body.body, contentType: body.content_type || "text/markdown", lastEditedBy: agentId })
    .returning();

  await db.insert(sharedDocumentVersions).values({ documentId: doc.id, version: 1, body: body.body, editedBy: agentId });
  await audit(agentId, "document.created", "shared_document", doc.id, { scope, name: body.name });

  return c.json({ id: doc.id, name: doc.name, content_type: doc.contentType, version: doc.version, last_edited_by: doc.lastEditedBy, created_at: doc.createdAt }, 201);
});

app.get("/workspace/:workspaceId", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const { limit, cursor } = parsePaginationQuery({ limit: c.req.query("limit"), cursor: c.req.query("cursor") });

  if (!(await verifyWorkspaceAccess(agentId, workspaceId))) return c.json({ error: "Not a workspace member", code: "NOT_MEMBER" }, 403);

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

app.get("/workspace/:workspaceId/:docId", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const docId = c.req.param("docId");

  if (!(await verifyWorkspaceAccess(agentId, workspaceId))) return c.json({ error: "Not a workspace member", code: "NOT_MEMBER" }, 403);

  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== workspaceScope(workspaceId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  return c.json({ id: doc.id, name: doc.name, content_type: doc.contentType, body: doc.body, version: doc.version, last_edited_by: doc.lastEditedBy, created_at: doc.createdAt, updated_at: doc.updatedAt });
});

app.put("/workspace/:workspaceId/:docId", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const docId = c.req.param("docId");

  if (!(await verifyWorkspaceAccess(agentId, workspaceId))) return c.json({ error: "Not a workspace member", code: "NOT_MEMBER" }, 403);

  const body = await c.req.json<{ body: string; name?: string }>();
  if (!body.body) return c.json({ error: "body is required", code: "MISSING_FIELD" }, 400);

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
app.get("/workspace/:workspaceId/:docId/versions", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const docId = c.req.param("docId");

  if (!(await verifyWorkspaceAccess(agentId, workspaceId))) return c.json({ error: "Not a workspace member", code: "NOT_MEMBER" }, 403);

  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== workspaceScope(workspaceId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  const versions = await db
    .select()
    .from(sharedDocumentVersions)
    .where(eq(sharedDocumentVersions.documentId, docId))
    .orderBy(desc(sharedDocumentVersions.version));

  return c.json({
    versions: versions.map(v => ({
      version: v.version,
      edited_by: v.editedBy,
      created_at: v.createdAt,
      body_length: v.body.length,
    })),
  });
});

// Workspace document specific version
app.get("/workspace/:workspaceId/:docId/versions/:version", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const docId = c.req.param("docId");
  const version = parseInt(c.req.param("version"));

  if (!(await verifyWorkspaceAccess(agentId, workspaceId))) return c.json({ error: "Not a workspace member", code: "NOT_MEMBER" }, 403);

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

app.delete("/workspace/:workspaceId/:docId", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const docId = c.req.param("docId");

  if (!(await verifyWorkspaceAccess(agentId, workspaceId))) return c.json({ error: "Not a workspace member", code: "NOT_MEMBER" }, 403);

  const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, docId)).limit(1);
  if (!doc || doc.scope !== workspaceScope(workspaceId)) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

  await db.delete(sharedDocumentVersions).where(eq(sharedDocumentVersions.documentId, docId));
  await db.delete(sharedDocuments).where(eq(sharedDocuments.id, docId));
  await audit(agentId, "document.deleted", "shared_document", docId, { scope: workspaceScope(workspaceId) });

  return c.json({ ok: true });
});

// --- Contact-scoped document endpoints ---

// Create a document
app.post("/:contactId", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const body = await c.req.json<{ name: string; body: string; content_type?: string }>();
  if (!body.name || !body.body) return c.json({ error: "name and body are required", code: "MISSING_FIELD" }, 400);

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
app.get("/:contactId", async (c) => {
  const agentId = c.get("agentId");
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
app.get("/:contactId/:docId", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const docId = c.req.param("docId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const [doc] = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.id, docId))
    .limit(1);

  if (!doc) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

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
app.put("/:contactId/:docId", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const docId = c.req.param("docId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const body = await c.req.json<{ body: string; name?: string }>();
  if (!body.body) return c.json({ error: "body is required", code: "MISSING_FIELD" }, 400);

  const [existing] = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.id, docId))
    .limit(1);

  if (!existing) return c.json({ error: "Document not found", code: "DOCUMENT_NOT_FOUND" }, 404);

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
app.get("/:contactId/:docId/versions", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const docId = c.req.param("docId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const versions = await db
    .select()
    .from(sharedDocumentVersions)
    .where(eq(sharedDocumentVersions.documentId, docId))
    .orderBy(desc(sharedDocumentVersions.version));

  return c.json({
    versions: versions.map(v => ({
      version: v.version,
      edited_by: v.editedBy,
      created_at: v.createdAt,
      body_length: v.body.length,
    })),
  });
});

// Get a specific version
app.get("/:contactId/:docId/versions/:version", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const docId = c.req.param("docId");
  const version = parseInt(c.req.param("version"));

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

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
app.delete("/:contactId/:docId", async (c) => {
  const agentId = c.get("agentId");
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
