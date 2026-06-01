import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, workspaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { generatePairingCode } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { getWorkspaceMembers } from "../lib/workspace.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// Create a workspace — the creating agent joins automatically
app.post("/", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ name: string; owner?: string }>();

  if (!body.name) return c.json({ error: "name is required" }, 400);

  // Check if agent already belongs to a workspace
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (agent?.workspaceId) {
    return c.json({ error: "Already in a workspace. Leave first." }, 409);
  }

  const pairingCode = generatePairingCode();

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: body.name, owner: body.owner, pairingCode })
    .returning();

  // Join the creator to the workspace
  await db
    .update(agents)
    .set({ workspaceId: workspace.id })
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
  const body = await c.req.json<{ code: string }>();

  if (!body.code) return c.json({ error: "code is required" }, 400);

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (agent?.workspaceId) {
    return c.json({ error: "Already in a workspace. Leave first." }, 409);
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.pairingCode, body.code.toUpperCase()))
    .limit(1);

  if (!workspace) return c.json({ error: "Invalid workspace code" }, 404);

  await db
    .update(agents)
    .set({ workspaceId: workspace.id })
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

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace" }, 404);
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId))
    .limit(1);

  if (!workspace) return c.json({ error: "Workspace not found" }, 404);

  const memberIds = await getWorkspaceMembers(workspace.id);
  const memberAgents = await db
    .select({ id: agents.id, name: agents.name, owner: agents.owner })
    .from(agents)
    .where(eq(agents.workspaceId, workspace.id));

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
    })),
  });
});

// Leave workspace
app.post("/leave", async (c) => {
  const agentId = c.get("agentId");

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace" }, 400);
  }

  const workspaceId = agent.workspaceId;

  await db
    .update(agents)
    .set({ workspaceId: null })
    .where(eq(agents.id, agentId));

  await audit(agentId, "workspace.leave", "workspace", workspaceId);

  return c.json({ ok: true });
});

// List members of a workspace
app.get("/:id/members", async (c) => {
  const agentId = c.get("agentId");
  const workspaceId = c.req.param("id");

  // Verify membership
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (agent?.workspaceId !== workspaceId) {
    return c.json({ error: "Not a member of this workspace" }, 403);
  }

  const memberAgents = await db
    .select({ id: agents.id, name: agents.name, owner: agents.owner })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));

  return c.json({
    members: memberAgents.map((a) => ({
      agent_id: a.id,
      name: a.name,
      owner: a.owner,
    })),
  });
});

export default app;
