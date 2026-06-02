import { Hono } from "hono";
import { db } from "../db/index.js";
import { messageTemplates } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// List all templates for the authenticated agent
app.get("/", async (c) => {
  const agentId = c.get("agentId");

  const rows = await db
    .select()
    .from(messageTemplates)
    .where(eq(messageTemplates.agentId, agentId));

  return c.json({
    templates: rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      payload: r.payload,
      description: r.description,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    })),
  });
});

// Create a new template
app.post("/", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{
    name: string;
    type: string;
    payload: Record<string, unknown>;
    description?: string;
  }>();

  if (!body.name || !body.type || !body.payload) {
    return c.json({ error: "name, type, and payload are required" }, 400);
  }

  // Check for duplicate name
  const [existing] = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.agentId, agentId), eq(messageTemplates.name, body.name)))
    .limit(1);

  if (existing) {
    return c.json({ error: "Template with this name already exists" }, 409);
  }

  const [template] = await db
    .insert(messageTemplates)
    .values({
      agentId,
      name: body.name,
      type: body.type,
      payload: body.payload,
      description: body.description ?? null,
    })
    .returning();

  await audit(agentId, "template.create", "template", template.id, { name: body.name });

  return c.json({
    id: template.id,
    name: template.name,
    type: template.type,
    payload: template.payload,
    description: template.description,
    created_at: template.createdAt,
    updated_at: template.updatedAt,
  }, 201);
});

// Get a specific template
app.get("/:id", async (c) => {
  const agentId = c.get("agentId");
  const templateId = c.req.param("id");

  const [template] = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.agentId, agentId)))
    .limit(1);

  if (!template) return c.json({ error: "Template not found" }, 404);

  return c.json({
    id: template.id,
    name: template.name,
    type: template.type,
    payload: template.payload,
    description: template.description,
    created_at: template.createdAt,
    updated_at: template.updatedAt,
  });
});

// Update a template
app.patch("/:id", async (c) => {
  const agentId = c.get("agentId");
  const templateId = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    type?: string;
    payload?: Record<string, unknown>;
    description?: string;
  }>();

  const [template] = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.agentId, agentId)))
    .limit(1);

  if (!template) return c.json({ error: "Template not found" }, 404);

  // If renaming, check for name conflict
  if (body.name && body.name !== template.name) {
    const [conflict] = await db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.agentId, agentId), eq(messageTemplates.name, body.name)))
      .limit(1);

    if (conflict) {
      return c.json({ error: "Template with this name already exists" }, 409);
    }
  }

  const updates: Partial<typeof template> = { updatedAt: new Date() };
  if (body.name) updates.name = body.name;
  if (body.type) updates.type = body.type;
  if (body.payload) updates.payload = body.payload;
  if (body.description !== undefined) updates.description = body.description;

  await db
    .update(messageTemplates)
    .set(updates)
    .where(eq(messageTemplates.id, templateId));

  await audit(agentId, "template.update", "template", templateId);

  return c.json({
    id: template.id,
    name: updates.name ?? template.name,
    type: updates.type ?? template.type,
    payload: updates.payload ?? template.payload,
    description: updates.description !== undefined ? updates.description : template.description,
    created_at: template.createdAt,
    updated_at: updates.updatedAt,
  });
});

// Delete a template
app.delete("/:id", async (c) => {
  const agentId = c.get("agentId");
  const templateId = c.req.param("id");

  const [template] = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.agentId, agentId)))
    .limit(1);

  if (!template) return c.json({ error: "Template not found" }, 404);

  await db
    .delete(messageTemplates)
    .where(eq(messageTemplates.id, templateId));

  await audit(agentId, "template.delete", "template", templateId, { name: template.name });

  return c.json({ ok: true });
});

export default app;
