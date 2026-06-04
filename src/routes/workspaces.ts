import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, workspaces, workspaceContacts, tasks, sharedFacts, sharedDocuments } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { generatePairingCode } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { isValidUUID, requireValidUUIDs } from "../lib/errors.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// Create a workspace — the creating agent joins automatically
app.post("/", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`workspace:create:${agentId}`, 5, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{ name: string; owner?: string }>();

  if (!body.name || (typeof body.name === "string" && body.name.trim().length === 0)) return c.json({ error: "name is required", code: "MISSING_FIELD" }, 400);
  if (body.name.length > 100) return c.json({ error: "name must be 100 characters or fewer", code: "INVALID_FIELD" }, 400);
  if (body.owner !== undefined) {
    if (typeof body.owner !== "string" || body.owner.trim().length === 0) return c.json({ error: "owner must not be empty", code: "INVALID_FIELD" }, 400);
    if (body.owner.length > 100) return c.json({ error: "owner must be 100 characters or fewer", code: "INVALID_FIELD" }, 400);
  }

  // Check if agent already belongs to a workspace
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (agent?.workspaceId) {
    return c.json({ error: "Already in a workspace. Leave first.", code: "ALREADY_MEMBER" }, 409);
  }

  const pairingCode = generatePairingCode();

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: body.name, owner: body.owner, pairingCode })
    .returning();

  // Join the creator to the workspace as admin
  await db
    .update(agents)
    .set({ workspaceId: workspace.id, workspaceRole: "admin" })
    .where(eq(agents.id, agentId));

  await audit(agentId, "workspace.create", "workspace", workspace.id, { name: body.name });

  return c.json({
    id: workspace.id,
    name: workspace.name,
    owner: workspace.owner,
    pairing_code: workspace.pairingCode,
    created_at: workspace.createdAt,
  }, 201);
});

// Join an existing workspace via its pairing code
app.post("/join", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`join:${agentId}`, 20, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{ code: string }>();

  if (!body.code || typeof body.code !== "string") return c.json({ error: "code is required", code: "MISSING_FIELD" }, 400);
  if (body.code.length > 20 || !/^[A-Za-z0-9]+$/.test(body.code)) return c.json({ error: "Invalid code format", code: "INVALID_INPUT" }, 400);

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (agent?.workspaceId) {
    return c.json({ error: "Already in a workspace. Leave first.", code: "ALREADY_MEMBER" }, 409);
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.pairingCode, body.code.toUpperCase()))
    .limit(1);

  if (!workspace) return c.json({ error: "Invalid workspace code", code: "WORKSPACE_NOT_FOUND" }, 404);

  await db
    .update(agents)
    .set({ workspaceId: workspace.id, workspaceRole: "member" })
    .where(eq(agents.id, agentId));

  await audit(agentId, "workspace.join", "workspace", workspace.id);

  return c.json({
    joined: true,
    workspace_id: workspace.id,
    name: workspace.name,
  });
});

// Get my workspace info
app.get("/me", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace", code: "WORKSPACE_NOT_FOUND" }, 404);
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId))
    .limit(1);

  if (!workspace) return c.json({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" }, 404);

  const memberAgents = await db
    .select({ id: agents.id, name: agents.name, owner: agents.owner, workspaceRole: agents.workspaceRole })
    .from(agents)
    .where(eq(agents.workspaceId, workspace.id))
    .limit(500);

  return c.json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      owner: workspace.owner,
      pairing_code: workspace.pairingCode,
      created_at: workspace.createdAt,
    },
    members: memberAgents.map((a) => ({
      agent_id: a.id,
      name: a.name,
      owner: a.owner,
      role: a.workspaceRole ?? "member",
    })),
  });
});

// Update workspace name/metadata (admin only)
app.patch("/me", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`workspace:patch:${agentId}`, 20, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace", code: "WORKSPACE_NOT_FOUND" }, 404);
  }
  if (agent.workspaceRole !== "admin") {
    return c.json({ error: "Admin role required", code: "INSUFFICIENT_ROLE" }, 403);
  }

  const body = await c.req.json<{ name?: string; metadata?: Record<string, unknown> }>();
  if (!body.name && !body.metadata) {
    return c.json({ error: "name or metadata is required", code: "MISSING_FIELD" }, 400);
  }
  if (body.name && body.name.length > 100) {
    return c.json({ error: "name must be 100 characters or fewer", code: "INVALID_FIELD" }, 400);
  }
  if (body.metadata && JSON.stringify(body.metadata).length > 10000) {
    return c.json({ error: "metadata must not exceed 10KB", code: "INVALID_FIELD" }, 400);
  }

  const updates: Record<string, unknown> = {};
  if (body.name) updates.name = body.name;
  if (body.metadata) updates.metadata = body.metadata;

  const [updated] = await db
    .update(workspaces)
    .set(updates)
    .where(eq(workspaces.id, agent.workspaceId))
    .returning();

  await audit(agentId, "workspace.update", "workspace", agent.workspaceId, updates);

  return c.json({
    id: updated.id,
    name: updated.name,
    owner: updated.owner,
    pairing_code: updated.pairingCode,
    metadata: updated.metadata,
    created_at: updated.createdAt,
  });
});

// Leave workspace
app.post("/leave", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`write:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace", code: "VALIDATION_ERROR" }, 400);
  }

  const workspaceId = agent.workspaceId;

  // If this agent is an admin, ensure at least one other admin remains
  if (agent.workspaceRole === "admin") {
    const otherAdmins = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.workspaceRole, "admin"),
        ),
      )
      .limit(2);
    // Check if there are other members at all
    const otherMembers = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId))
      .limit(2);
    const hasOtherMembers = otherMembers.filter((m) => m.id !== agentId).length > 0;
    const hasOtherAdmins = otherAdmins.filter((a) => a.id !== agentId).length > 0;
    if (hasOtherMembers && !hasOtherAdmins) {
      return c.json({
        error: "Cannot leave as the last admin while other members exist. Promote another member to admin first, or delete the workspace.",
        code: "LAST_ADMIN_CANNOT_LEAVE",
      }, 400);
    }
  }

  await db
    .update(agents)
    .set({ workspaceId: null, workspaceRole: null })
    .where(eq(agents.id, agentId));

  await audit(agentId, "workspace.leave", "workspace", workspaceId);

  return c.json({ ok: true });
});

// List members of a workspace
app.get("/:id/members", requireValidUUIDs("id"), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const workspaceId = c.req.param("id");

  // Verify membership
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (agent?.workspaceId !== workspaceId) {
    return c.json({ error: "Not a member of this workspace", code: "NOT_MEMBER" }, 403);
  }

  const memberAgents = await db
    .select({ id: agents.id, name: agents.name, owner: agents.owner, workspaceRole: agents.workspaceRole })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .limit(500);

  return c.json({
    members: memberAgents.map((a) => ({
      agent_id: a.id,
      name: a.name,
      owner: a.owner,
      role: a.workspaceRole ?? "member",
    })),
  });
});

// Kick a member from workspace (admin only)
app.post("/kick", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`write:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const body = await c.req.json<{ agent_id: string }>();

  if (!body.agent_id || typeof body.agent_id !== "string") return c.json({ error: "agent_id is required", code: "MISSING_FIELD" }, 400);
  if (!isValidUUID(body.agent_id)) return c.json({ error: "Invalid agent_id format", code: "INVALID_INPUT" }, 400);

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace", code: "WORKSPACE_NOT_FOUND" }, 404);
  }
  if (agent.workspaceRole !== "admin") {
    return c.json({ error: "Admin role required", code: "INSUFFICIENT_ROLE" }, 403);
  }
  if (body.agent_id === agentId) {
    return c.json({ error: "Cannot kick yourself. Use leave instead.", code: "SELF_ACTION" }, 400);
  }

  const [target] = await db.select().from(agents).where(eq(agents.id, body.agent_id)).limit(1);
  if (!target || target.workspaceId !== agent.workspaceId) {
    return c.json({ error: "Agent is not a member of this workspace", code: "NOT_FOUND" }, 404);
  }

  await db
    .update(agents)
    .set({ workspaceId: null, workspaceRole: null })
    .where(eq(agents.id, body.agent_id));

  await audit(agentId, "workspace.kick", "workspace", agent.workspaceId, { kicked: body.agent_id });

  return c.json({ ok: true, kicked: body.agent_id });
});

// Change a member's role (admin only)
app.patch("/members/:id/role", requireValidUUIDs("id"), async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`write:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const targetId = c.req.param("id");
  const body = await c.req.json<{ role: string }>();

  if (!body.role || !["admin", "member"].includes(body.role)) {
    return c.json({ error: "role must be 'admin' or 'member'", code: "INVALID_INPUT" }, 400);
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace", code: "WORKSPACE_NOT_FOUND" }, 404);
  }
  if (agent.workspaceRole !== "admin") {
    return c.json({ error: "Admin role required", code: "INSUFFICIENT_ROLE" }, 403);
  }

  const [target] = await db.select().from(agents).where(eq(agents.id, targetId)).limit(1);
  if (!target || target.workspaceId !== agent.workspaceId) {
    return c.json({ error: "Agent is not a member of this workspace", code: "NOT_FOUND" }, 404);
  }

  // Prevent demoting the last admin — use transaction to avoid TOCTOU race
  if (target.workspaceRole === "admin" && body.role === "member") {
    const demoted = await db.transaction(async (tx) => {
      const otherAdmins = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, agent.workspaceId),
            eq(agents.workspaceRole, "admin"),
          ),
        )
        .limit(2);
      const remainingAdmins = otherAdmins.filter((a) => a.id !== targetId);
      if (remainingAdmins.length === 0) {
        return false;
      }
      await tx
        .update(agents)
        .set({ workspaceRole: body.role })
        .where(eq(agents.id, targetId));
      return true;
    });
    if (!demoted) {
      return c.json({
        error: "Cannot demote the last admin. Promote another member first.",
        code: "LAST_ADMIN",
      }, 400);
    }
  } else {
    await db
      .update(agents)
      .set({ workspaceRole: body.role })
      .where(eq(agents.id, targetId));
  }

  await audit(agentId, "workspace.change_role", "workspace", agent.workspaceId, {
    target: targetId,
    role: body.role,
  });

  return c.json({ ok: true, agent_id: targetId, role: body.role });
});

// Delete workspace (admin only) — removes all members
app.delete("/", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`write:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace", code: "WORKSPACE_NOT_FOUND" }, 404);
  }
  if (agent.workspaceRole !== "admin") {
    return c.json({ error: "Admin role required", code: "INSUFFICIENT_ROLE" }, 403);
  }

  const workspaceId = agent.workspaceId;

  const scope = `workspace:${workspaceId}`;

  // Atomic deletion: remove members, contacts, scoped data, and workspace in one transaction
  const cascade = await db.transaction(async (tx) => {
    // Count members being removed
    const memberRows = await tx
      .update(agents)
      .set({ workspaceId: null, workspaceRole: null })
      .where(eq(agents.workspaceId, workspaceId))
      .returning({ id: agents.id });

    // Delete workspace contacts
    const contactRows = await tx
      .delete(workspaceContacts)
      .where(eq(workspaceContacts.workspaceId, workspaceId))
      .returning({ agentId: workspaceContacts.agentId });

    // Delete workspace-scoped tasks, facts, and documents
    const taskRows = await tx.delete(tasks).where(eq(tasks.scope, scope)).returning({ id: tasks.id });
    const factRows = await tx.delete(sharedFacts).where(eq(sharedFacts.scope, scope)).returning({ key: sharedFacts.key });
    const docRows = await tx.delete(sharedDocuments).where(eq(sharedDocuments.scope, scope)).returning({ id: sharedDocuments.id });

    // Delete workspace
    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));

    return {
      members: memberRows.length,
      contacts: contactRows.length,
      tasks: taskRows.length,
      facts: factRows.length,
      documents: docRows.length,
    };
  });

  await audit(agentId, "workspace.delete", "workspace", workspaceId, { cascade });

  return c.json({ ok: true, deleted: workspaceId });
});

export default app;
