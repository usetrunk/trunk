import { Hono, type Context } from "hono";
import { db } from "../db/index.js";
import { tasks, agents } from "../db/schema.js";
import { eq, and, desc, lt, or, inArray } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { canMessage, verifyWorkspaceAccess } from "../lib/workspace.js";
import { contactScope, verifyRoomAccess, resolveScopeAccess } from "../lib/context.js";
import { requireWorkspaceMember, requireRoomMember } from "../lib/scope-middleware.js";
import { parsePaginationQuery, paginateResults } from "../lib/pagination.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { isValidUUID, requireValidUUIDs, validateMetadata } from "../lib/errors.js";
import { fireRoomTaskWebhooks } from "../lib/room-webhook.js";
import { notifyRoomTaskEvent } from "../lib/webhook.js";
import { taskToJson } from "../lib/response-shapes.js";
import { checkpointTask, claimTask, CoordinationError, handoffTask } from "../lib/coordination.js";
import type { AgentVariables } from "../lib/types.js";

const VALID_STATUSES = ["open", "in-progress", "done", "blocked"] as const;
const VALID_PRIORITIES = ["critical", "high", "medium", "low"] as const;
const MAX_DEPENDS_ON = 50;

/** Detect cycles in the task dependency graph using DFS. Returns true if adding deps to taskId would create a cycle. */
function hasCycle(taskId: string, deps: string[], scopeTasks: { id: string; dependsOn: unknown }[]): boolean {
  const graph = new Map<string, string[]>();
  for (const t of scopeTasks) {
    graph.set(t.id, ((t.dependsOn as string[]) || []).slice());
  }
  // Apply the proposed edges
  graph.set(taskId, deps);

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): boolean {
    if (inStack.has(node)) return true; // cycle
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const dep of graph.get(node) || []) {
      if (dfs(dep)) return true;
    }
    inStack.delete(node);
    return false;
  }

  return dfs(taskId);
}

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function isValidStatus(s: string): boolean {
  return (VALID_STATUSES as readonly string[]).includes(s);
}

function isValidPriority(p: string): boolean {
  return (VALID_PRIORITIES as readonly string[]).includes(p);
}

function isValidDate(s: string): boolean {
  if (!ISO_8601_RE.test(s)) return false;
  const d = new Date(s);
  if (isNaN(d.getTime())) return false;
  // Roundtrip check: reject date rollover (e.g. Feb 30 → Mar 2)
  const [datePart] = s.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day;
}

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

function coordinationErrorResponse(c: Context, error: CoordinationError) {
  return c.json({ error: error.message, code: error.code, ...error.details }, error.status as 400);
}

// Create a task (contact-scoped, room-scoped, or workspace-scoped)
app.post("/", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`tasks:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

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

  if (!body.title || !body.title.trim()) return c.json({ error: "title is required and must not be blank", code: "MISSING_FIELD" }, 400);
  if (body.title.length > 500) return c.json({ error: "title must be 500 characters or fewer", code: "INVALID_FIELD" }, 400);
  if (body.description && body.description.length > 5000) return c.json({ error: "description must be 5000 characters or fewer", code: "INVALID_FIELD" }, 400);
  if (body.group && body.group.length > 200) return c.json({ error: "group must be 200 characters or fewer", code: "INVALID_FIELD" }, 400);
  if (body.context_ref && body.context_ref.length > 500) return c.json({ error: "context_ref must be 500 characters or fewer", code: "INVALID_FIELD" }, 400);
  if (!body.contact_id && !body.room_id && !body.workspace_id) return c.json({ error: "contact_id, room_id, or workspace_id is required", code: "MISSING_FIELD" }, 400);
  const scopeCount = [body.contact_id, body.room_id, body.workspace_id].filter(Boolean).length;
  if (scopeCount > 1) return c.json({ error: "Provide exactly one of contact_id, room_id, or workspace_id", code: "AMBIGUOUS_SCOPE" }, 400);
  if (body.contact_id && !isValidUUID(body.contact_id)) return c.json({ error: "Invalid contact_id format", code: "INVALID_INPUT" }, 400);
  if (body.room_id && !isValidUUID(body.room_id)) return c.json({ error: "Invalid room_id format", code: "INVALID_INPUT" }, 400);
  if (body.workspace_id && !isValidUUID(body.workspace_id)) return c.json({ error: "Invalid workspace_id format", code: "INVALID_INPUT" }, 400);
  if (body.owner && !isValidUUID(body.owner)) return c.json({ error: "Invalid owner format", code: "INVALID_INPUT" }, 400);
  if (body.priority && !isValidPriority(body.priority)) {
    return c.json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}`, code: "INVALID_FIELD" }, 400);
  }
  if (body.metadata) {
    const metaErr = validateMetadata(body.metadata);
    if (metaErr) return c.json({ error: metaErr, code: "VALIDATION_ERROR" }, 400);
  }
  if (body.sequence !== undefined && (typeof body.sequence !== "number" || !Number.isFinite(body.sequence) || body.sequence < 0 || body.sequence > 1_000_000)) {
    return c.json({ error: "sequence must be a finite number between 0 and 1000000", code: "INVALID_FIELD" }, 400);
  }
  if (body.estimate !== undefined && (typeof body.estimate !== "number" || !Number.isFinite(body.estimate) || body.estimate < 0 || body.estimate > 1_000_000)) {
    return c.json({ error: "estimate must be a finite number between 0 and 1000000", code: "INVALID_FIELD" }, 400);
  }
  if (body.depends_on) {
    if (!Array.isArray(body.depends_on)) {
      return c.json({ error: "depends_on must be an array", code: "INVALID_FIELD" }, 400);
    }
    if (body.depends_on.length > MAX_DEPENDS_ON) {
      return c.json({ error: `depends_on cannot exceed ${MAX_DEPENDS_ON} entries`, code: "VALIDATION_ERROR" }, 400);
    }
    for (const dep of body.depends_on) {
      if (!isValidUUID(dep)) {
        return c.json({ error: `Invalid UUID in depends_on: ${dep}`, code: "INVALID_INPUT" }, 400);
      }
    }
  }
  if (body.due !== undefined && body.due !== null && body.due !== "" && !isValidDate(body.due)) {
    return c.json({ error: "due must be a valid ISO 8601 date", code: "INVALID_FIELD" }, 400);
  }
  if (body.start_date !== undefined && body.start_date !== null && body.start_date !== "" && !isValidDate(body.start_date)) {
    return c.json({ error: "start_date must be a valid ISO 8601 date", code: "INVALID_FIELD" }, 400);
  }

  let scope: string;

  if (body.workspace_id) {
    const hasAccess = await verifyWorkspaceAccess(agentId, body.workspace_id);
    if (!hasAccess) return c.json({ error: "Not a workspace member", code: "NOT_MEMBER" }, 403);
    scope = `workspace:${body.workspace_id}`;
  } else if (body.room_id) {
    const hasAccess = await verifyRoomAccess(agentId, body.room_id);
    if (!hasAccess) return c.json({ error: "Not a room member", code: "NOT_MEMBER" }, 403);
    scope = `room:${body.room_id}`;
  } else {
    const hasAccess = await canMessage(agentId, body.contact_id!);
    if (!hasAccess) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);
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

  // Fire room webhooks + push notifications (best-effort, non-blocking)
  if (body.room_id) {
    const taskData = {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      owner: task.owner,
      created_by: task.createdBy,
      group: task.group,
      scope: task.scope,
      metadata: task.metadata,
    };
    await Promise.allSettled([
      fireRoomTaskWebhooks(body.room_id, taskData),
      notifyRoomTaskEvent(body.room_id, "task.created", taskData),
    ]);
  }

  return c.json(taskToJson(task), 201);
});

// List tasks for a contact pair
app.get("/:contactId", requireValidUUIDs("contactId"), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const contactId = c.req.param("contactId");
  const status = c.req.query("status");
  if (status && !isValidStatus(status)) {
    return c.json({ error: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(", ")}`, code: "INVALID_FIELD" }, 400);
  }
  const ownerFilter = c.req.query("owner");
  if (ownerFilter && !isValidUUID(ownerFilter)) return c.json({ error: "Invalid owner UUID format", code: "INVALID_INPUT" }, 400);
  const groupFilter = c.req.query("group");
  if (groupFilter && groupFilter.length > 100) return c.json({ error: "group filter too long", code: "VALIDATION_ERROR" }, 400);
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const hasAccess = await canMessage(agentId, contactId);
  if (!hasAccess) return c.json({ error: "Not a contact", code: "NOT_MEMBER" }, 403);

  const scope = contactScope(agentId, contactId);
  const conditions = [eq(tasks.scope, scope)];
  if (status) conditions.push(eq(tasks.status, status));
  if (ownerFilter) conditions.push(eq(tasks.owner, ownerFilter));
  if (groupFilter) conditions.push(eq(tasks.group, groupFilter));
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

  const page = paginateResults(rows, limit);
  return c.json({
    tasks: page.items.map(taskToJson),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

// List tasks for a room
app.get("/room/:roomId", requireValidUUIDs("roomId"), requireRoomMember(), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const roomId = c.req.param("roomId");
  const status = c.req.query("status");
  if (status && !isValidStatus(status)) {
    return c.json({ error: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(", ")}`, code: "INVALID_FIELD" }, 400);
  }
  const ownerFilter = c.req.query("owner");
  if (ownerFilter && !isValidUUID(ownerFilter)) return c.json({ error: "Invalid owner UUID format", code: "INVALID_INPUT" }, 400);
  const groupFilter = c.req.query("group");
  if (groupFilter && groupFilter.length > 100) return c.json({ error: "group filter too long", code: "VALIDATION_ERROR" }, 400);
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const scope = `room:${roomId}`;
  const conditions = [eq(tasks.scope, scope)];
  if (status) conditions.push(eq(tasks.status, status));
  if (ownerFilter) conditions.push(eq(tasks.owner, ownerFilter));
  if (groupFilter) conditions.push(eq(tasks.group, groupFilter));
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

  const page = paginateResults(rows, limit);
  return c.json({
    tasks: page.items.map(taskToJson),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

// List tasks for a workspace
app.get("/workspace/:workspaceId", requireValidUUIDs("workspaceId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const workspaceId = c.req.param("workspaceId");
  const status = c.req.query("status");
  if (status && !isValidStatus(status)) {
    return c.json({ error: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(", ")}`, code: "INVALID_FIELD" }, 400);
  }
  const ownerFilter = c.req.query("owner");
  if (ownerFilter && !isValidUUID(ownerFilter)) return c.json({ error: "Invalid owner UUID format", code: "INVALID_INPUT" }, 400);
  const groupFilter = c.req.query("group");
  if (groupFilter && groupFilter.length > 100) return c.json({ error: "group filter too long", code: "VALIDATION_ERROR" }, 400);
  const { limit, cursor } = parsePaginationQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });

  const scope = `workspace:${workspaceId}`;
  const conditions = [eq(tasks.scope, scope)];
  if (status) conditions.push(eq(tasks.status, status));
  if (ownerFilter) conditions.push(eq(tasks.owner, ownerFilter));
  if (groupFilter) conditions.push(eq(tasks.group, groupFilter));
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

  const page = paginateResults(rows, limit);
  return c.json({
    tasks: page.items.map(taskToJson),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
});

// Atomically claim ownership of a task and optionally lease files for that task.
app.post("/:scopeId/:taskId/claim", requireValidUUIDs("scopeId", "taskId"), async (c) => {
  const agentId = c.get("agentId");
  const scopeId = c.req.param("scopeId");
  const taskId = c.req.param("taskId");

  const rateLimit = await checkRateLimit(`tasks:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  const body = await c.req.json<{
    claimed_files?: string[];
    ttl_seconds?: number;
    reason?: string;
    force?: boolean;
    expected_status?: "open" | "in-progress" | "done" | "blocked";
    announce?: boolean;
    announcement?: string | null;
  }>();

  if (body.claimed_files !== undefined && !Array.isArray(body.claimed_files)) {
    return c.json({ error: "claimed_files must be an array", code: "INVALID_FIELD" }, 400);
  }
  if (body.ttl_seconds !== undefined && (typeof body.ttl_seconds !== "number" || !Number.isFinite(body.ttl_seconds) || body.ttl_seconds <= 0)) {
    return c.json({ error: "ttl_seconds must be a positive number", code: "INVALID_FIELD" }, 400);
  }
  if (body.expected_status !== undefined && !isValidStatus(body.expected_status)) {
    return c.json({ error: `Invalid expected_status. Must be one of: ${VALID_STATUSES.join(", ")}`, code: "INVALID_FIELD" }, 400);
  }

  try {
    return c.json(await claimTask(agentId, scopeId, taskId, body));
  } catch (error) {
    if (error instanceof CoordinationError) return coordinationErrorResponse(c, error);
    throw error;
  }
});

// Record durable progress, verification, blockers, and next steps.
app.post("/:scopeId/:taskId/checkpoint", requireValidUUIDs("scopeId", "taskId"), async (c) => {
  const agentId = c.get("agentId");
  const scopeId = c.req.param("scopeId");
  const taskId = c.req.param("taskId");

  const rateLimit = await checkRateLimit(`tasks:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  const body = await c.req.json<{
    summary: string;
    status?: "open" | "in-progress" | "done" | "blocked";
    files_changed?: string[];
    commands_run?: string[];
    verification?: { command: string; status: "pending" | "passed" | "failed" | "skipped"; output?: string | null } | null;
    blocker?: { reason: string; waiting_on?: string | null } | null;
    next_step?: string | null;
    announce?: boolean;
    announcement?: string | null;
  }>();

  if (!body.summary || !body.summary.trim()) return c.json({ error: "summary is required", code: "MISSING_FIELD" }, 400);
  if (body.status !== undefined && !isValidStatus(body.status)) {
    return c.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`, code: "INVALID_FIELD" }, 400);
  }
  if (body.files_changed !== undefined && !Array.isArray(body.files_changed)) return c.json({ error: "files_changed must be an array", code: "INVALID_FIELD" }, 400);
  if (body.commands_run !== undefined && !Array.isArray(body.commands_run)) return c.json({ error: "commands_run must be an array", code: "INVALID_FIELD" }, 400);
  if (body.verification && (!body.verification.command || !["pending", "passed", "failed", "skipped"].includes(body.verification.status))) {
    return c.json({ error: "verification requires command and valid status", code: "INVALID_FIELD" }, 400);
  }
  if (body.blocker && (!body.blocker.reason || !body.blocker.reason.trim())) {
    return c.json({ error: "blocker.reason is required", code: "INVALID_FIELD" }, 400);
  }

  try {
    return c.json(await checkpointTask(agentId, scopeId, taskId, body));
  } catch (error) {
    if (error instanceof CoordinationError) return coordinationErrorResponse(c, error);
    throw error;
  }
});

// Transfer work context to another agent without losing the active trail.
app.post("/:scopeId/:taskId/handoff", requireValidUUIDs("scopeId", "taskId"), async (c) => {
  const agentId = c.get("agentId");
  const scopeId = c.req.param("scopeId");
  const taskId = c.req.param("taskId");

  const rateLimit = await checkRateLimit(`tasks:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  const body = await c.req.json<{
    to_agent?: string | null;
    summary: string;
    next_action?: string | null;
    status?: "open" | "in-progress" | "done" | "blocked";
    announce?: boolean;
    announcement?: string | null;
  }>();

  if (!body.summary || !body.summary.trim()) return c.json({ error: "summary is required", code: "MISSING_FIELD" }, 400);
  if (body.to_agent !== undefined && body.to_agent !== null && body.to_agent !== "" && !isValidUUID(body.to_agent)) {
    return c.json({ error: "Invalid to_agent format", code: "INVALID_INPUT" }, 400);
  }
  if (body.status !== undefined && !isValidStatus(body.status)) {
    return c.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`, code: "INVALID_FIELD" }, 400);
  }

  try {
    return c.json(await handoffTask(agentId, scopeId, taskId, body));
  } catch (error) {
    if (error instanceof CoordinationError) return coordinationErrorResponse(c, error);
    throw error;
  }
});

// Update a task (works for contact, room, and workspace scoped tasks)
app.patch("/:scopeId/:taskId", requireValidUUIDs("scopeId", "taskId"), async (c) => {
  const agentId = c.get("agentId");
  const scopeId = c.req.param("scopeId");
  const taskId = c.req.param("taskId");

  const rateLimit = await checkRateLimit(`tasks:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  const scope = await resolveScopeAccess(agentId, scopeId);
  if (!scope) return c.json({ error: "No access", code: "FORBIDDEN" }, 403);

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

  if (body.status !== undefined && !isValidStatus(body.status)) {
    return c.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`, code: "INVALID_FIELD" }, 400);
  }
  if (body.priority !== undefined && !isValidPriority(body.priority)) {
    return c.json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}`, code: "INVALID_FIELD" }, 400);
  }
  if (body.title !== undefined && !String(body.title).trim()) {
    return c.json({ error: "title must not be blank", code: "INVALID_FIELD" }, 400);
  }
  if (body.title !== undefined && body.title.length > 500) {
    return c.json({ error: "title must be 500 characters or fewer", code: "INVALID_FIELD" }, 400);
  }
  if (body.description !== undefined && body.description !== null && body.description.length > 5000) {
    return c.json({ error: "description must be 5000 characters or fewer", code: "INVALID_FIELD" }, 400);
  }
  if (body.group !== undefined && body.group !== null && body.group.length > 200) {
    return c.json({ error: "group must be 200 characters or fewer", code: "INVALID_FIELD" }, 400);
  }
  if (body.context_ref !== undefined && body.context_ref !== null && body.context_ref.length > 500) {
    return c.json({ error: "context_ref must be 500 characters or fewer", code: "INVALID_FIELD" }, 400);
  }
  if (body.owner !== undefined && body.owner !== null && body.owner !== "" && !isValidUUID(body.owner)) {
    return c.json({ error: "Invalid owner format", code: "INVALID_INPUT" }, 400);
  }
  if (body.metadata !== undefined) {
    const metaErr = validateMetadata(body.metadata);
    if (metaErr) return c.json({ error: metaErr, code: "VALIDATION_ERROR" }, 400);
  }
  if (body.sequence !== undefined && body.sequence !== null && (typeof body.sequence !== "number" || !Number.isFinite(body.sequence) || body.sequence < 0 || body.sequence > 1_000_000)) {
    return c.json({ error: "sequence must be a finite number between 0 and 1000000", code: "INVALID_FIELD" }, 400);
  }
  if (body.estimate !== undefined && body.estimate !== null && (typeof body.estimate !== "number" || !Number.isFinite(body.estimate) || body.estimate < 0 || body.estimate > 1_000_000)) {
    return c.json({ error: "estimate must be a finite number between 0 and 1000000", code: "INVALID_FIELD" }, 400);
  }
  if (body.depends_on !== undefined) {
    if (!Array.isArray(body.depends_on)) {
      return c.json({ error: "depends_on must be an array", code: "INVALID_FIELD" }, 400);
    }
    if (body.depends_on.length > MAX_DEPENDS_ON) {
      return c.json({ error: `depends_on cannot exceed ${MAX_DEPENDS_ON} entries`, code: "VALIDATION_ERROR" }, 400);
    }
    for (const dep of body.depends_on) {
      if (!isValidUUID(dep)) {
        return c.json({ error: `Invalid UUID in depends_on: ${dep}`, code: "INVALID_INPUT" }, 400);
      }
    }
    if (body.depends_on.includes(taskId)) {
      return c.json({ error: "A task cannot depend on itself", code: "CYCLE_DETECTED" }, 400);
    }
    // Check for dependency cycles within the scope
    if (body.depends_on.length > 0) {
      const scopeTasks = await db
        .select({ id: tasks.id, dependsOn: tasks.dependsOn })
        .from(tasks)
        .where(eq(tasks.scope, scope))
        .limit(500);
      if (hasCycle(taskId, body.depends_on, scopeTasks)) {
        return c.json({ error: "Dependency cycle detected", code: "CYCLE_DETECTED" }, 400);
      }
    }
  }
  if (body.due !== undefined && body.due !== null && body.due !== "" && !isValidDate(body.due)) {
    return c.json({ error: "due must be a valid ISO 8601 date", code: "INVALID_FIELD" }, 400);
  }
  if (body.start_date !== undefined && body.start_date !== null && body.start_date !== "" && !isValidDate(body.start_date)) {
    return c.json({ error: "start_date must be a valid ISO 8601 date", code: "INVALID_FIELD" }, 400);
  }

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
    .where(and(eq(tasks.id, taskId), eq(tasks.scope, scope)))
    .returning();

  if (!updated) return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);

  // Fire room webhooks + push notifications for task updates (best-effort)
  if (updated.scope.startsWith("room:")) {
    const roomId = updated.scope.slice(5);
    const taskData = {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      status: updated.status,
      priority: updated.priority,
      owner: updated.owner,
      created_by: updated.createdBy,
      group: updated.group,
      scope: updated.scope,
      metadata: updated.metadata,
    };
    await Promise.allSettled([
      fireRoomTaskWebhooks(roomId, taskData, "task.updated"),
      notifyRoomTaskEvent(roomId, "task.updated", taskData),
    ]);
  }

  // When a task is marked done, auto-unblock downstream tasks
  if (body.status === "done") {
    const allScopeTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.scope, updated.scope))
      .limit(500);

    const doneIds = new Set(allScopeTasks.filter(t => t.status === "done").map(t => t.id));

    const toUnblock: typeof allScopeTasks = [];
    for (const t of allScopeTasks) {
      const deps = (t.dependsOn as string[]) || [];
      if (deps.includes(taskId) && t.status === "blocked") {
        if (deps.every(d => doneIds.has(d))) {
          toUnblock.push(t);
        }
      }
    }

    if (toUnblock.length > 0) {
      const unblockIds = toUnblock.map(t => t.id);
      await db
        .update(tasks)
        .set({ status: "open", updatedAt: new Date() })
        .where(inArray(tasks.id, unblockIds));

      // Fire webhooks + push for auto-unblocked room tasks
      if (updated.scope.startsWith("room:")) {
        const roomId = updated.scope.slice(5);
        for (const t of toUnblock) {
          const unblockedData = {
            id: t.id,
            title: t.title,
            description: t.description,
            status: "open",
            priority: t.priority,
            owner: t.owner,
            created_by: t.createdBy,
            group: t.group,
            scope: t.scope,
            metadata: t.metadata,
          };
          await Promise.allSettled([
            fireRoomTaskWebhooks(roomId, unblockedData, "task.updated"),
            notifyRoomTaskEvent(roomId, "task.unblocked", unblockedData),
          ]);
        }
      }
    }
  }

  return c.json(taskToJson(updated));
});

// Gantt data endpoint — returns tasks with dependency info for visualization
app.get("/gantt/workspace/:workspaceId", requireValidUUIDs("workspaceId"), requireWorkspaceMember(), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const workspaceId = c.req.param("workspaceId");

  const scope = `workspace:${workspaceId}`;
  const allTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.scope, scope))
    .orderBy(tasks.sequence, tasks.createdAt)
    .limit(500);

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
app.delete("/:scopeId/:taskId", requireValidUUIDs("scopeId", "taskId"), async (c) => {
  const agentId = c.get("agentId");
  const scopeId = c.req.param("scopeId");
  const taskId = c.req.param("taskId");

  const rateLimit = await checkRateLimit(`tasks:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);

  const deleteScope = await resolveScopeAccess(agentId, scopeId);
  if (!deleteScope) return c.json({ error: "No access", code: "FORBIDDEN" }, 403);

  const [deleted] = await db
    .delete(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.scope, deleteScope)))
    .returning();

  if (!deleted) return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);

  // Fire room webhooks + push for task deletion (best-effort)
  if (deleted.scope.startsWith("room:")) {
    const roomId = deleted.scope.slice(5);
    const deletedData = {
      id: deleted.id,
      title: deleted.title,
      description: deleted.description,
      status: deleted.status,
      priority: deleted.priority,
      owner: deleted.owner,
      created_by: deleted.createdBy,
      group: deleted.group,
      scope: deleted.scope,
    };
    await Promise.allSettled([
      fireRoomTaskWebhooks(roomId, deletedData, "task.deleted"),
      notifyRoomTaskEvent(roomId, "task.deleted", deletedData),
    ]);
  }

  return c.json({ ok: true, deleted_id: deleted.id });
});

export default app;
