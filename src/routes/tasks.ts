import { Hono } from "hono";
import { db } from "../db/index.js";
import { tasks, roomMembers, agents } from "../db/schema.js";
import { eq, and, desc, lt, or, inArray } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { canMessage, verifyWorkspaceAccess } from "../lib/workspace.js";
import { parsePaginationQuery, paginateResults } from "../lib/pagination.js";
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
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const hasAccess = await verifyAccess(agentId, contactId);
  if (!hasAccess) return c.json({ error: "Not a contact" }, 403);

  const scope = contactScope(agentId, contactId);
  const conditions = [eq(tasks.scope, scope)];
  if (status) conditions.push(eq(tasks.status, status));
  if (cursor) {
    conditions.push(
      or(
        lt(tasks.createdAt, cursor.createdAt),
        and(eq(tasks.createdAt, cursor.createdAt), lt(tasks.id, cursor.id))
      )!
    );
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit + 1);

  let filtered = ownerFilter ? rows.filter(t => t.owner === ownerFilter) : rows;
  if (groupFilter) filtered = filtered.filter(t => t.group === groupFilter);

  const page = paginateResults(filtered, limit);
  return c.json({
    tasks: page.items.map(taskToJson),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

// List tasks for a room
app.get("/room/:roomId", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const status = c.req.query("status");
  const ownerFilter = c.req.query("owner");
  const groupFilter = c.req.query("group");
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const hasAccess = await verifyRoomAccess(agentId, roomId);
  if (!hasAccess) return c.json({ error: "Not a room member" }, 403);

  const scope = `room:${roomId}`;
  const conditions = [eq(tasks.scope, scope)];
  if (status) conditions.push(eq(tasks.status, status));
  if (cursor) {
    conditions.push(
      or(
        lt(tasks.createdAt, cursor.createdAt),
        and(eq(tasks.createdAt, cursor.createdAt), lt(tasks.id, cursor.id))
      )!
    );
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit + 1);

  let filtered = ownerFilter ? rows.filter(t => t.owner === ownerFilter) : rows;
  if (groupFilter) filtered = filtered.filter(t => t.group === groupFilter);

  const page = paginateResults(filtered, limit);
  return c.json({
    tasks: page.items.map(taskToJson),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

// List tasks for a workspace
app.get("/workspace/:workspaceId", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");
  const status = c.req.query("status");
  const ownerFilter = c.req.query("owner");
  const groupFilter = c.req.query("group");
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const hasAccess = await verifyWorkspaceAccess(agentId, workspaceId);
  if (!hasAccess) return c.json({ error: "Not a workspace member" }, 403);

  const scope = `workspace:${workspaceId}`;
  const conditions = [eq(tasks.scope, scope)];
  if (status) conditions.push(eq(tasks.status, status));
  if (cursor) {
    conditions.push(
      or(
        lt(tasks.createdAt, cursor.createdAt),
        and(eq(tasks.createdAt, cursor.createdAt), lt(tasks.id, cursor.id))
      )!
    );
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit + 1);

  let filtered = ownerFilter ? rows.filter(t => t.owner === ownerFilter) : rows;
  if (groupFilter) filtered = filtered.filter(t => t.group === groupFilter);

  const page = paginateResults(filtered, limit);
  return c.json({
    tasks: page.items.map(taskToJson),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
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

  // When a task is marked done, auto-unblock downstream tasks
  if (body.status === "done") {
    const allScopeTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.scope, updated.scope));

    const doneIds = new Set(allScopeTasks.filter(t => t.status === "done").map(t => t.id));

    for (const t of allScopeTasks) {
      const deps = (t.dependsOn as string[]) || [];
      if (deps.includes(taskId) && t.status === "blocked") {
        if (deps.every(d => doneIds.has(d))) {
          await db
            .update(tasks)
            .set({ status: "open", updatedAt: new Date() })
            .where(eq(tasks.id, t.id));
        }
      }
    }
  }

  return c.json(taskToJson(updated));
});

// Gantt data endpoint — returns tasks with dependency info for visualization
app.get("/gantt/workspace/:workspaceId", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("workspaceId");

  const hasAccess = await verifyWorkspaceAccess(agentId, workspaceId);
  if (!hasAccess) return c.json({ error: "Not a workspace member" }, 403);

  const scope = `workspace:${workspaceId}`;
  const allTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.scope, scope))
    .orderBy(tasks.sequence, tasks.createdAt);

  const ownerIds = [...new Set(allTasks.map(t => t.owner).filter(Boolean))] as string[];
  const ownerRows = ownerIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ownerIds))
    : [];
  const ownerNames = Object.fromEntries(ownerRows.map(a => [a.id, a.name]));

  const doneIds = new Set(allTasks.filter(t => t.status === "done").map(t => t.id));

  const ganttTasks = allTasks.map(t => {
    const deps = (t.dependsOn as string[]) || [];
    const blockedBy = deps.filter(d => !doneIds.has(d));

    return {
      ...taskToJson(t),
      owner_name: t.owner ? ownerNames[t.owner] || t.owner.slice(0, 8) : null,
      deps_met: blockedBy.length === 0,
      blocked_by: blockedBy,
    };
  });

  const grouped: Record<string, typeof ganttTasks> = {};
  const ungrouped: typeof ganttTasks = [];
  for (const t of ganttTasks) {
    if (t.group) {
      if (!grouped[t.group]) grouped[t.group] = [];
      grouped[t.group].push(t);
    } else {
      ungrouped.push(t);
    }
  }

  return c.json({
    tasks: ganttTasks,
    groups: grouped,
    ungrouped,
    summary: {
      total: allTasks.length,
      done: allTasks.filter(t => t.status === "done").length,
      in_progress: allTasks.filter(t => t.status === "in-progress").length,
      blocked: allTasks.filter(t => t.status === "blocked").length,
      open: allTasks.filter(t => t.status === "open").length,
    },
  });
});

// Delete a task (works for contact, room, and workspace scoped tasks)
app.delete("/:scopeId/:taskId", async (c) => {
  const agentId = c.get("agentId");
  const scopeId = c.req.param("scopeId");
  const taskId = c.req.param("taskId");

  const hasContactAccess = await verifyAccess(agentId, scopeId);
  const hasRoomAccess = await verifyRoomAccess(agentId, scopeId);
  const hasWsAccess = await verifyWorkspaceAccess(agentId, scopeId);
  if (!hasContactAccess && !hasRoomAccess && !hasWsAccess) return c.json({ error: "No access" }, 403);

  const [deleted] = await db
    .delete(tasks)
    .where(eq(tasks.id, taskId))
    .returning();

  if (!deleted) return c.json({ error: "Task not found" }, 404);

  return c.json({ ok: true, deleted_id: deleted.id });
});

export default app;
