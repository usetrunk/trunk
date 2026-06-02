import { Hono } from "hono";
import { db } from "../db/index.js";
import { tasks, roomMembers } from "../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { canMessage, verifyWorkspaceAccess } from "../lib/workspace.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// Shared response mapper for task rows
function taskToJson(t: typeof tasks.$inferSelect) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    owner: t.owner,
    created_by: t.createdBy,
    due: t.due,
    start_date: t.startDate,
    group: t.group,
    depends_on: t.dependsOn,
    sequence: t.sequence,
    estimate: t.estimate,
    context_ref: t.contextRef,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

// Helper: build scope string for a contact pair (sorted for consistency)
function contactScope(a: string, b: string): string {
  return `contact:${[a, b].sort().join("-")}`;
}

// Helper: verify two agents can access shared tasks — same rules as messaging
// (direct contact, workspace co-members, or cross-workspace pairings)
async function verifyAccess(agentId: string, otherId: string): Promise<boolean> {
  return canMessage(agentId, otherId);
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

// Create a task (contact-scoped, room-scoped, or workspace-scoped)
app.post("/", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{
    contact_id?: string;
    room_id?: string;
    workspace_id?: string;
    title: string;
    description?: string;
    priority?: string;
    owner?: string;
    due?: string;
    start_date?: string;
    group?: string;
    depends_on?: string[];
    sequence?: number;
    estimate?: number;
    context_ref?: string;
    metadata?: Record<string, unknown>;
  }>();

  if (!body.title) return c.json({ error: "title is required" }, 400);
  if (!body.contact_id && !body.room_id && !body.workspace_id) return c.json({ error: "contact_id, room_id, or workspace_id is required" }, 400);

  let scope: string;

  if (body.workspace_id) {
    const hasAccess = await verifyWorkspaceAccess(agentId, body.workspace_id);
    if (!hasAccess) return c.json({ error: "Not a workspace member" }, 403);
    scope = `workspace:${body.workspace_id}`;
  } else if (body.room_id) {
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
      startDate: body.start_date,
      group: body.group,
      dependsOn: body.depends_on || [],
      sequence: body.sequence,
      estimate: body.estimate,
      contextRef: body.context_ref,
      metadata: body.metadata || {},
    })
    .returning();

  return c.json({ scope: task.scope, ...taskToJson(task) }, 201);
});

// List tasks for a contact pair
app.get("/:contactId", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("contactId");
  const status = c.req.query("status");
  const ownerFilter = c.req.query("owner");
  const groupFilter = c.req.query("group");

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

  let filtered = ownerFilter ? rows.filter(t => t.owner === ownerFilter) : rows;
  if (groupFilter) filtered = filtered.filter(t => t.group === groupFilter);

  return c.json({
    tasks: filtered.map(taskToJson),
  });
});

// List tasks for a room
app.get("/room/:roomId", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const status = c.req.query("status");
  const ownerFilter = c.req.query("owner");
  const groupFilter = c.req.query("group");

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

  let filtered = ownerFilter ? rows.filter(t => t.owner === ownerFilter) : rows;
  if (groupFilter) filtered = filtered.filter(t => t.group === groupFilter);

  return c.json({
    tasks: filtered.map(taskToJson),
  });
});

// List tasks for a workspace
app.get("/workspace/:workspaceId", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const status = c.req.query("status");
  const ownerFilter = c.req.query("owner");
  const groupFilter = c.req.query("group");

  const hasAccess = await verifyWorkspaceAccess(agentId, workspaceId);
  if (!hasAccess) return c.json({ error: "Not a workspace member" }, 403);

  const scope = `workspace:${workspaceId}`;
  const rows = await db
    .select()
    .from(tasks)
    .where(
      status
        ? and(eq(tasks.scope, scope), eq(tasks.status, status))
        : eq(tasks.scope, scope)
    )
    .orderBy(desc(tasks.createdAt));

  let filtered = ownerFilter ? rows.filter(t => t.owner === ownerFilter) : rows;
  if (groupFilter) filtered = filtered.filter(t => t.group === groupFilter);

  return c.json({
    tasks: filtered.map(taskToJson),
  });
});

// Update a task (works for contact, room, and workspace scoped tasks)
app.patch("/:scopeId/:taskId", async (c) => {
  const agentId = c.get("agentId");
  const scopeId = c.req.param("scopeId");
  const taskId = c.req.param("taskId");

  // Verify access — could be a contact ID, room ID, or workspace ID
  const hasContactAccess = await verifyAccess(agentId, scopeId);
  const hasRoomAccess = await verifyRoomAccess(agentId, scopeId);
  const hasWsAccess = await verifyWorkspaceAccess(agentId, scopeId);
  if (!hasContactAccess && !hasRoomAccess && !hasWsAccess) return c.json({ error: "No access" }, 403);

  const body = await c.req.json<{
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    owner?: string;
    due?: string;
    start_date?: string;
    group?: string;
    depends_on?: string[];
    sequence?: number;
    estimate?: number;
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
  if (body.start_date !== undefined) updates.startDate = body.start_date;
  if (body.group !== undefined) updates.group = body.group;
  if (body.depends_on !== undefined) updates.dependsOn = body.depends_on;
  if (body.sequence !== undefined) updates.sequence = body.sequence;
  if (body.estimate !== undefined) updates.estimate = body.estimate;
  if (body.context_ref !== undefined) updates.contextRef = body.context_ref;
  if (body.metadata !== undefined) updates.metadata = body.metadata;

  const [updated] = await db
    .update(tasks)
    .set(updates)
    .where(eq(tasks.id, taskId))
    .returning();

  if (!updated) return c.json({ error: "Task not found" }, 404);

  return c.json(taskToJson(updated));
});

export default app;
