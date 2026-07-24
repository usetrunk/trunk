import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  actionConfirmations,
  agents,
  sharedDocuments,
  sharedFacts,
  sharedObjectQuarantines,
  workspaceActionControls,
} from "../db/schema.js";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import {
  CONTROLLED_OPERATIONS,
  QUARANTINE_OBJECT_TYPES,
  confirmationToJson,
  quarantineToJson,
} from "../lib/action-controls.js";
import {
  ReportQuarantineRequest,
  ReviewConfirmationRequest,
  ReviewQuarantineRequest,
  UpdateWorkspaceActionControlsRequest,
} from "../protocol/action-controls.js";
import { workspaceScope } from "../lib/context.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();
app.use("/*", authMiddleware);

app.get("/", async (c) => {
  const agent = await currentWorkspaceAgent(c.get("agentId"));
  if (!agent) return c.json({ error: "Not in a workspace", code: "WORKSPACE_NOT_FOUND" }, 404);
  const [controls] = await db
    .select()
    .from(workspaceActionControls)
    .where(eq(workspaceActionControls.workspaceId, agent.workspaceId!))
    .limit(1);
  return c.json({
    controls: controlsToJson(controls),
    operation_catalog: CONTROLLED_OPERATIONS,
    quarantine_object_catalog: QUARANTINE_OBJECT_TYPES,
  });
});

app.put("/", async (c) => {
  const agent = await requireWorkspaceAdmin(c.get("agentId"));
  if (!agent) return c.json({ error: "Workspace admin role required", code: "INSUFFICIENT_ROLE" }, 403);
  const parsed = UpdateWorkspaceActionControlsRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid action controls", code: "INVALID_INPUT", details: parsed.error.issues }, 400);
  const values = {
    enabled: parsed.data.enabled ? 1 : 0,
    confirmationOperations: parsed.data.confirmation_operations,
    quarantineEnabled: parsed.data.quarantine_enabled ? 1 : 0,
    quarantineObjectTypes: parsed.data.quarantine_object_types,
    updatedBy: agent.id,
    updatedAt: new Date(),
  };
  const [existing] = await db
    .select()
    .from(workspaceActionControls)
    .where(eq(workspaceActionControls.workspaceId, agent.workspaceId!))
    .limit(1);
  const [saved] = existing
    ? await db.update(workspaceActionControls).set(values).where(eq(workspaceActionControls.workspaceId, agent.workspaceId!)).returning()
    : await db.insert(workspaceActionControls).values({ workspaceId: agent.workspaceId!, ...values }).returning();
  await audit(agent.id, "action_controls.updated", "workspace", agent.workspaceId!, {
    enabled: parsed.data.enabled,
    confirmation_operations: parsed.data.confirmation_operations,
    quarantine_enabled: parsed.data.quarantine_enabled,
    quarantine_object_types: parsed.data.quarantine_object_types,
  });
  return c.json({ controls: controlsToJson(saved) });
});

app.get("/confirmations", async (c) => {
  const agent = await requireWorkspaceAdmin(c.get("agentId"));
  if (!agent) return c.json({ error: "Workspace admin role required", code: "INSUFFICIENT_ROLE" }, 403);
  const rows = await db
    .select()
    .from(actionConfirmations)
    .where(eq(actionConfirmations.workspaceId, agent.workspaceId!))
    .orderBy(desc(actionConfirmations.createdAt))
    .limit(200);
  return c.json({ confirmations: rows.map(confirmationToJson) });
});

app.post("/confirmations/:id", async (c) => {
  const agent = await requireWorkspaceAdmin(c.get("agentId"));
  if (!agent) return c.json({ error: "Workspace admin role required", code: "INSUFFICIENT_ROLE" }, 403);
  const parsed = ReviewConfirmationRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid confirmation decision", code: "INVALID_INPUT" }, 400);
  const [existing] = await db.select().from(actionConfirmations).where(eq(actionConfirmations.id, c.req.param("id"))).limit(1);
  if (!existing || existing.workspaceId !== agent.workspaceId) {
    return c.json({ error: "Confirmation not found", code: "NOT_FOUND" }, 404);
  }
  if (existing.status !== "pending") {
    return c.json({ error: "Only pending confirmations can be reviewed", code: "INVALID_STATE" }, 409);
  }
  const [updated] = await db
    .update(actionConfirmations)
    .set({
      status: parsed.data.decision === "approve" ? "approved" : "rejected",
      reviewedBy: agent.id,
      reviewNote: parsed.data.note ?? null,
      reviewedAt: new Date(),
    })
    .where(and(eq(actionConfirmations.id, existing.id), eq(actionConfirmations.status, "pending")))
    .returning();
  if (!updated) return c.json({ error: "Confirmation was already reviewed", code: "INVALID_STATE" }, 409);
  await audit(agent.id, `confirmation.${parsed.data.decision}d`, "action_confirmation", existing.id, {
    workspace_id: agent.workspaceId,
    operation: existing.operation,
  });
  return c.json({ confirmation: confirmationToJson(updated) });
});

app.get("/quarantines", async (c) => {
  const agent = await requireWorkspaceAdmin(c.get("agentId"));
  if (!agent) return c.json({ error: "Workspace admin role required", code: "INSUFFICIENT_ROLE" }, 403);
  const rows = await db
    .select()
    .from(sharedObjectQuarantines)
    .where(eq(sharedObjectQuarantines.workspaceId, agent.workspaceId!))
    .orderBy(desc(sharedObjectQuarantines.createdAt))
    .limit(200);
  return c.json({ quarantines: rows.map(quarantineToJson) });
});

app.post("/quarantines", async (c) => {
  const agent = await currentWorkspaceAgent(c.get("agentId"));
  if (!agent) return c.json({ error: "Not in a workspace", code: "WORKSPACE_NOT_FOUND" }, 404);
  const parsed = ReportQuarantineRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid quarantine report", code: "INVALID_INPUT" }, 400);
  const [controls] = await db.select().from(workspaceActionControls)
    .where(eq(workspaceActionControls.workspaceId, agent.workspaceId!)).limit(1);
  if (
    !controls
    || controls.enabled !== 1
    || controls.quarantineEnabled !== 1
    || !controls.quarantineObjectTypes.includes(parsed.data.object_type)
  ) {
    return c.json({ error: "Quarantine is not enabled for this object type", code: "QUARANTINE_DISABLED" }, 409);
  }
  if (!(await objectBelongsToWorkspace(agent.workspaceId!, parsed.data.object_type, parsed.data.object_id))) {
    return c.json({ error: "Shared object not found in this workspace", code: "NOT_FOUND" }, 404);
  }
  const [active] = await db.select().from(sharedObjectQuarantines).where(and(
    eq(sharedObjectQuarantines.workspaceId, agent.workspaceId!),
    eq(sharedObjectQuarantines.objectType, parsed.data.object_type),
    eq(sharedObjectQuarantines.objectId, parsed.data.object_id),
    eq(sharedObjectQuarantines.status, "active"),
  )).limit(1);
  if (active) return c.json({ quarantine: quarantineToJson(active) });
  const [created] = await db.insert(sharedObjectQuarantines).values({
    workspaceId: agent.workspaceId!,
    objectType: parsed.data.object_type,
    objectId: parsed.data.object_id,
    reason: parsed.data.reason,
    reportedBy: agent.id,
  }).returning();
  await audit(agent.id, "object.quarantined", parsed.data.object_type, parsed.data.object_id, {
    workspace_id: agent.workspaceId,
    reason: parsed.data.reason,
  });
  return c.json({ quarantine: quarantineToJson(created) }, 201);
});

app.post("/quarantines/:id", async (c) => {
  const agent = await requireWorkspaceAdmin(c.get("agentId"));
  if (!agent) return c.json({ error: "Workspace admin role required", code: "INSUFFICIENT_ROLE" }, 403);
  const parsed = ReviewQuarantineRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid quarantine decision", code: "INVALID_INPUT" }, 400);
  const [existing] = await db.select().from(sharedObjectQuarantines)
    .where(eq(sharedObjectQuarantines.id, c.req.param("id"))).limit(1);
  if (!existing || existing.workspaceId !== agent.workspaceId) {
    return c.json({ error: "Quarantine not found", code: "NOT_FOUND" }, 404);
  }
  if (existing.status !== "active") {
    return c.json({ error: "Quarantine has already been released", code: "INVALID_STATE" }, 409);
  }
  const [updated] = await db.update(sharedObjectQuarantines).set({
    status: parsed.data.decision === "release" ? "released" : "active",
    reviewedBy: agent.id,
    reviewNote: parsed.data.note ?? null,
    reviewedAt: new Date(),
  }).where(eq(sharedObjectQuarantines.id, existing.id)).returning();
  await audit(agent.id, `object.quarantine_${parsed.data.decision}d`, existing.objectType, existing.objectId, {
    workspace_id: agent.workspaceId,
  });
  return c.json({ quarantine: quarantineToJson(updated) });
});

async function currentWorkspaceAgent(agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  return agent?.workspaceId ? agent : null;
}

async function requireWorkspaceAdmin(agentId: string) {
  const agent = await currentWorkspaceAgent(agentId);
  return agent?.workspaceRole === "admin" ? agent : null;
}

function controlsToJson(row?: typeof workspaceActionControls.$inferSelect) {
  return {
    enabled: row?.enabled === 1,
    confirmation_operations: row?.confirmationOperations ?? [],
    quarantine_enabled: row?.quarantineEnabled === 1,
    quarantine_object_types: row?.quarantineObjectTypes ?? [],
  };
}

async function objectBelongsToWorkspace(
  workspaceId: string,
  objectType: "fact" | "document",
  objectId: string,
): Promise<boolean> {
  if (objectType === "document") {
    const [row] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, objectId)).limit(1);
    return row?.scope === workspaceScope(workspaceId);
  }
  const [row] = await db.select().from(sharedFacts).where(and(
    eq(sharedFacts.scope, workspaceScope(workspaceId)),
    eq(sharedFacts.key, objectId),
  )).limit(1);
  return Boolean(row);
}

export default app;
