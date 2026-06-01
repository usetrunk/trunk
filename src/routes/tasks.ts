import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, contacts, tasks, roomMembers } from "../db/schema.js";
import { eq, or, and, desc } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// Helper: build scope string for a contact pair (sorted for consistency)
function contactScope(a: string, b: string): string {
  return `contact:${[a, b].sort().join("-")}`;
}

// Helper: verify two agents are contacts (or same agent)
async function verifyAccess(agentId: string, otherId: string): Promise<boolean> {
  if (agentId === otherId) return true;
  const contact = await db
    .select()
    .from(contacts)
    .where(or(
      and(eq(contacts.agentA, agentId), eq(contacts.agentB, otherId)),
      and(eq(contacts.agentA, otherId), eq(contacts.agentB, agentId))
    ))
    .limit(1);
  return contact.length > 0;
}

// Helper: verify agent is a room member
async function verifyRoomAccess(agentId: string, roomId: string): Promise<boolean> {
  const members = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);
  return members.length > 0;
}

// Create a task (contact-scoped or room-scoped)
app.post("/", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{
    contact_id?: string;
    room_id?: string;
    title: string;
    description?: string;
    priority?: string;
    owner?: string;
    due?: string;
    context_ref?: string;
    metadata?: Record<string, unknown>;
  }>();

  if (!body.title) return c.json({ error: "title is required" }, 400);
  if (!body.contact_id && !body.room_id) return c.json({ error: "contact_id or room_id is required" }, 400);

  let scope: string;

  if (body.room_id) {
    const hasAccess = await verifyRoomAccess(agentId, body.room_id);
    if (!hasAccess) return c.json({ error: "Not a room member" }, 403);
    scope = `room:${body.room_id}`;
  } else {
    const hasAccess = await verifyAccess(agentId, body.contact_id!);
    if (!hasAccess) return c.json({ error: "Not a contact" }, 403);
    scope = contactScope(agentId, body.contact_id!);
  }

  const [task] = await db
    .insert(tasks)
    .values({
      scope,
      title: body.title,
      description: body.description,
      priority: body.priority || "medium",
      owner: body.owner || body.contact_id || undefined,
      createdBy: agentId,
      due: body.due,
      contextRef: body.context_ref,
      metadata: body.metadata || {},
    })
    .returning();

  return c.json({
    id: task.id,
    scope: task.scope,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    owner: task.owner,
    created_by: task.createdBy,
    due: task.due,
    context_ref: task.contextRef,
    created_at: task.createdAt,
  }, 201);
});

// List tasks for a contact pair
app.get("/:contactId", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const status = c.req.query("status");
  const ownerFilter = c.req.query("owner");

  const hasAccess = await verifyAccess(agentId, contactId);
  if (!hasAccess) return c.json({ error: "Not a contact" }, 403);

  const scope = contactScope(agentId, contactId);

  let query = db
    .select()
    .from(tasks)
    .where(
      status
        ? and(eq(tasks.scope, scope), eq(tasks.status, status))
        : eq(tasks.scope, scope)
    )
    .orderBy(desc(tasks.createdAt));

  const rows = await query;

  // Filter by owner in JS if requested (avoids complex query building)
  const filtered = ownerFilter ? rows.filter(t => t.owner === ownerFilter) : rows;

  return c.json({
    tasks: filtered.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      owner: t.owner,
      created_by: t.createdBy,
      due: t.due,
      context_ref: t.contextRef,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
    })),
  });
});

// List tasks for a room
app.get("/room/:roomId", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const status = c.req.query("status");
  const ownerFilter = c.req.query("owner");

  const hasAccess = await verifyRoomAccess(agentId, roomId);
  if (!hasAccess) return c.json({ error: "Not a room member" }, 403);

  const scope = `room:${roomId}`;
  const rows = await db
    .select()
    .from(tasks)
    .where(
      status
        ? and(eq(tasks.scope, scope), eq(tasks.status, status))
        : eq(tasks.scope, scope)
    )
    .orderBy(desc(tasks.createdAt));

  const filtered = ownerFilter ? rows.filter(t => t.owner === ownerFilter) : rows;

  return c.json({
    tasks: filtered.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      owner: t.owner,
      created_by: t.createdBy,
      due: t.due,
      context_ref: t.contextRef,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
    })),
  });
});

// Update a task (works for both contact and room scoped tasks)
app.patch("/:scopeId/:taskId", async (c) => {
  const agentId = c.get("agentId");
  const scopeId = c.req.param("scopeId");
  const taskId = c.req.param("taskId");

  // Verify access — could be a contact ID or room ID
  const hasContactAccess = await verifyAccess(agentId, scopeId);
  const hasRoomAccess = await verifyRoomAccess(agentId, scopeId);
  if (!hasContactAccess && !hasRoomAccess) return c.json({ error: "No access" }, 403);

  const body = await c.req.json<{
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    owner?: string;
    due?: string;
    context_ref?: string;
    metadata?: Record<string, unknown>;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.status !== undefined) updates.status = body.status;
  if (body.priority !== undefined) updates.priority = body.priority;
  if (body.owner !== undefined) updates.owner = body.owner;
  if (body.due !== undefined) updates.due = body.due;
  if (body.context_ref !== undefined) updates.contextRef = body.context_ref;
  if (body.metadata !== undefined) updates.metadata = body.metadata;

  const [updated] = await db
    .update(tasks)
    .set(updates)
    .where(eq(tasks.id, taskId))
    .returning();

  if (!updated) return c.json({ error: "Task not found" }, 404);

  return c.json({
    id: updated.id,
    title: updated.title,
    description: updated.description,
    status: updated.status,
    priority: updated.priority,
    owner: updated.owner,
    created_by: updated.createdBy,
    due: updated.due,
    context_ref: updated.contextRef,
    updated_at: updated.updatedAt,
  });
});

export default app;
