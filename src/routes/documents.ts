import { Hono } from "hono";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { sharedDocuments, sharedDocumentVersions } from "../db/schema.js";
import { authMiddleware } from "../lib/auth.js";
import { contactScope, verifyContactAccess } from "../lib/context.js";
import { audit } from "../lib/audit.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// Create a document
app.post("/:contactId", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact" }, 403);

  const body = await c.req.json<{ name: string; body: string; content_type?: string }>();
  if (!body.name || !body.body) return c.json({ error: "name and body are required" }, 400);

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

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact" }, 403);

  const scope = contactScope(agentId, contactId);
  const docs = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.scope, scope))
    .orderBy(desc(sharedDocuments.updatedAt));

  return c.json({
    documents: docs.map(d => ({
      id: d.id,
      name: d.name,
      content_type: d.contentType,
      version: d.version,
      last_edited_by: d.lastEditedBy,
      updated_at: d.updatedAt,
    })),
  });
});

// Get a document (latest version)
app.get("/:contactId/:docId", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const docId = c.req.param("docId");

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact" }, 403);

  const [doc] = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.id, docId))
    .limit(1);

  if (!doc) return c.json({ error: "Document not found" }, 404);

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

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact" }, 403);

  const body = await c.req.json<{ body: string; name?: string }>();
  if (!body.body) return c.json({ error: "body is required" }, 400);

  const [existing] = await db
    .select()
    .from(sharedDocuments)
    .where(eq(sharedDocuments.id, docId))
    .limit(1);

  if (!existing) return c.json({ error: "Document not found" }, 404);

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

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact" }, 403);

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

  if (!(await verifyContactAccess(agentId, contactId))) return c.json({ error: "Not a contact" }, 403);

  const [v] = await db
    .select()
    .from(sharedDocumentVersions)
    .where(and(
      eq(sharedDocumentVersions.documentId, docId),
      eq(sharedDocumentVersions.version, version)
    ))
    .limit(1);

  if (!v) return c.json({ error: "Version not found" }, 404);

  return c.json({
    version: v.version,
    body: v.body,
    edited_by: v.editedBy,
    created_at: v.createdAt,
  });
});

export default app;
