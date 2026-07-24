import { createMiddleware } from "hono/factory";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  actionConfirmations,
  agents,
  sharedObjectQuarantines,
  tasks,
  workspaceActionControls,
} from "../db/schema.js";
import { audit } from "./audit.js";
import type { AgentVariables } from "./types.js";
import {
  ControlledOperation,
  QuarantineObjectType,
  type ControlledOperationT,
  type QuarantineObjectTypeT,
} from "../protocol/action-controls.js";

export const CONTROLLED_OPERATIONS = ControlledOperation.options;
export const QUARANTINE_OBJECT_TYPES = QuarantineObjectType.options;

export type ActionControlDecision =
  | { allowed: true }
  | {
      allowed: false;
      status: 403 | 409;
      code: "CONFIRMATION_REQUIRED" | "CONFIRMATION_REJECTED" | "CONFIRMATION_INVALID";
      message: string;
      confirmation?: ReturnType<typeof confirmationToJson>;
    };

type ControlledAction = {
  workspaceId: string;
  operation: ControlledOperationT;
  targetType: string;
  targetId: string | null;
  fingerprint: string;
};

export const actionControlMiddleware = createMiddleware<AgentVariables>(async (c, next) => {
  const action = await controlledActionForHttp(c.req.raw);
  if (!action) {
    await next();
    return;
  }
  if (action.fingerprint.startsWith("quarantined:")) {
    return c.json({
      error: "This shared object is quarantined pending workspace review",
      code: "OBJECT_QUARANTINED",
      quarantine_id: action.fingerprint.slice("quarantined:".length),
    }, 423);
  }

  const decision = await enforceActionControl({
    actorAgentId: c.get("agentId"),
    action,
    confirmationId: c.req.header("X-Trunk-Confirmation-Id") ?? null,
  });
  if (!decision.allowed) {
    return c.json({
      error: decision.message,
      code: decision.code,
      ...(decision.confirmation ? { confirmation: decision.confirmation } : {}),
    }, decision.status);
  }

  await next();
});

export async function enforceActionControl(input: {
  actorAgentId: string;
  action: ControlledAction;
  confirmationId: string | null;
}): Promise<ActionControlDecision> {
  const [actor] = await db.select().from(agents).where(eq(agents.id, input.actorAgentId)).limit(1);
  if (actor?.workspaceId !== input.action.workspaceId) {
    return { allowed: true };
  }
  const [controls] = await db
    .select()
    .from(workspaceActionControls)
    .where(eq(workspaceActionControls.workspaceId, input.action.workspaceId))
    .limit(1);

  if (!controls || controls.enabled !== 1 || !controls.confirmationOperations.includes(input.action.operation)) {
    return { allowed: true };
  }

  if (!input.confirmationId) {
    const [created] = await db
      .insert(actionConfirmations)
      .values({
        workspaceId: input.action.workspaceId,
        requestedBy: input.actorAgentId,
        operation: input.action.operation,
        requestFingerprint: input.action.fingerprint,
        targetType: input.action.targetType,
        targetId: input.action.targetId,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      })
      .returning();
    await audit(input.actorAgentId, "confirmation.requested", "action_confirmation", created.id, {
      workspace_id: input.action.workspaceId,
      operation: input.action.operation,
      target_type: input.action.targetType,
      target_id: input.action.targetId,
    });
    return {
      allowed: false,
      status: 409,
      code: "CONFIRMATION_REQUIRED",
      message: "This workspace requires confirmation before the operation can run",
      confirmation: confirmationToJson(created),
    };
  }

  const [confirmation] = await db
    .select()
    .from(actionConfirmations)
    .where(eq(actionConfirmations.id, input.confirmationId))
    .limit(1);

  if (
    !confirmation
    || confirmation.workspaceId !== input.action.workspaceId
    || confirmation.requestedBy !== input.actorAgentId
    || confirmation.operation !== input.action.operation
    || confirmation.requestFingerprint !== input.action.fingerprint
  ) {
    return {
      allowed: false,
      status: 403,
      code: "CONFIRMATION_INVALID",
      message: "Confirmation does not match this exact operation",
    };
  }

  if (confirmation.expiresAt.getTime() <= Date.now()) {
    await db.update(actionConfirmations).set({ status: "expired" }).where(eq(actionConfirmations.id, confirmation.id));
    return {
      allowed: false,
      status: 409,
      code: "CONFIRMATION_REQUIRED",
      message: "Confirmation expired, request a new confirmation",
      confirmation: confirmationToJson({ ...confirmation, status: "expired" }),
    };
  }
  if (confirmation.status === "rejected") {
    return { allowed: false, status: 403, code: "CONFIRMATION_REJECTED", message: "The operation was rejected" };
  }
  if (confirmation.status !== "approved") {
    return {
      allowed: false,
      status: 409,
      code: confirmation.status === "pending" ? "CONFIRMATION_REQUIRED" : "CONFIRMATION_INVALID",
      message: confirmation.status === "pending" ? "The operation is awaiting confirmation" : "Confirmation has already been consumed",
      confirmation: confirmationToJson(confirmation),
    };
  }

  const [consumed] = await db
    .update(actionConfirmations)
    .set({ status: "executed", executedAt: new Date() })
    .where(and(eq(actionConfirmations.id, confirmation.id), eq(actionConfirmations.status, "approved")))
    .returning();
  if (!consumed) {
    return { allowed: false, status: 409, code: "CONFIRMATION_INVALID", message: "Confirmation has already been consumed" };
  }
  await audit(input.actorAgentId, "confirmation.consumed", "action_confirmation", confirmation.id, {
    workspace_id: input.action.workspaceId,
    operation: input.action.operation,
  });
  return { allowed: true };
}

export async function controlledActionForMcp(
  toolName: string,
  args: Record<string, unknown>,
): Promise<ControlledAction | null> {
  if (typeof args.workspace_id !== "string") {
    if (!(toolName === "trunk_send" && typeof args.to === "string" && args.to.startsWith("workspace:"))) {
      return null;
    }
  }
  const workspaceId = typeof args.workspace_id === "string"
    ? args.workspace_id
    : (args.to as string).slice("workspace:".length);
  let operation: ControlledOperationT | null = null;
  let targetType = "workspace";
  let targetId: string | null = null;

  if (toolName === "trunk_send") {
    operation = "messages.send";
    targetType = "message";
  } else if (toolName === "trunk_task_create") {
    operation = "tasks.create";
    targetType = "task";
  } else if (toolName === "trunk_task_update") {
    operation = "tasks.update";
    targetType = "task";
    targetId = typeof args.task_id === "string" ? args.task_id : null;
  } else if (toolName === "trunk_task_delete") {
    operation = "tasks.delete";
    targetType = "task";
    targetId = typeof args.task_id === "string" ? args.task_id : null;
  } else if (toolName === "trunk_fact" && (args.action === "put" || args.action === "delete")) {
    operation = args.action === "put" ? "facts.upsert" : "facts.delete";
    targetType = "fact";
    targetId = typeof args.key === "string" ? args.key : null;
  } else if (toolName === "trunk_document" && ["create", "update", "delete"].includes(String(args.action))) {
    operation = args.action === "create"
      ? "documents.create"
      : args.action === "update"
        ? "documents.update"
        : "documents.delete";
    targetType = "document";
    targetId = typeof args.doc_id === "string" ? args.doc_id : null;
  }
  if (!operation) return null;

  const fingerprintArgs = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "secret" && key !== "confirmation_id"),
  );
  const fingerprint = await requestFingerprint("MCP", toolName, fingerprintArgs);
  if (targetId) {
    const quarantined = await activeQuarantine(workspaceId, targetType as QuarantineObjectTypeT, targetId);
    if (quarantined) {
      return { workspaceId, operation, targetType, targetId, fingerprint: `quarantined:${quarantined.id}` };
    }
  }
  return { workspaceId, operation, targetType, targetId, fingerprint };
}

export async function activeQuarantine(
  workspaceId: string,
  objectType: QuarantineObjectTypeT,
  objectId: string,
) {
  const [row] = await db
    .select()
    .from(sharedObjectQuarantines)
    .where(and(
      eq(sharedObjectQuarantines.workspaceId, workspaceId),
      eq(sharedObjectQuarantines.objectType, objectType),
      eq(sharedObjectQuarantines.objectId, objectId),
      eq(sharedObjectQuarantines.status, "active"),
    ))
    .orderBy(desc(sharedObjectQuarantines.createdAt))
    .limit(1);
  return row ?? null;
}

export async function activeQuarantineObjectIds(
  workspaceId: string,
  objectType: QuarantineObjectTypeT,
): Promise<Set<string>> {
  const rows = await db
    .select({ objectId: sharedObjectQuarantines.objectId })
    .from(sharedObjectQuarantines)
    .where(and(
      eq(sharedObjectQuarantines.workspaceId, workspaceId),
      eq(sharedObjectQuarantines.objectType, objectType),
      eq(sharedObjectQuarantines.status, "active"),
    ))
    .limit(500);
  return new Set(rows.map((row) => row.objectId));
}

export async function workspaceForAgent(agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  return agent?.workspaceId ?? null;
}

export function confirmationToJson(row: typeof actionConfirmations.$inferSelect) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    requested_by: row.requestedBy,
    operation: row.operation,
    target_type: row.targetType,
    target_id: row.targetId,
    status: row.status,
    reviewed_by: row.reviewedBy,
    review_note: row.reviewNote,
    expires_at: row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    executed_at: row.executedAt?.toISOString() ?? null,
  };
}

export function quarantineToJson(row: typeof sharedObjectQuarantines.$inferSelect) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    object_type: row.objectType,
    object_id: row.objectId,
    reason: row.reason,
    status: row.status,
    reported_by: row.reportedBy,
    reviewed_by: row.reviewedBy,
    review_note: row.reviewNote,
    created_at: row.createdAt.toISOString(),
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
  };
}

async function controlledActionForHttp(request: Request): Promise<ControlledAction | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD"
    ? {}
    : await request.clone().json().catch(() => ({})) as Record<string, unknown>;
  let workspaceId: string | null = null;
  let operation: ControlledOperationT | null = null;
  let targetType = "workspace";
  let targetId: string | null = null;

  const factMatch = url.pathname.match(/^\/context\/workspace\/([^/]+)\/facts\/([^/]+)$/);
  if (factMatch && (method === "PUT" || method === "DELETE")) {
    workspaceId = factMatch[1];
    operation = method === "PUT" ? "facts.upsert" : "facts.delete";
    targetType = "fact";
    targetId = decodeURIComponent(factMatch[2]);
  }

  const documentMatch = url.pathname.match(/^\/documents\/workspace\/([^/]+)(?:\/([^/]+))?$/);
  if (documentMatch && ["POST", "PUT", "DELETE"].includes(method)) {
    workspaceId = documentMatch[1];
    operation = method === "POST" ? "documents.create" : method === "PUT" ? "documents.update" : "documents.delete";
    targetType = "document";
    targetId = documentMatch[2] ?? null;
  }

  if (url.pathname === "/messages" && method === "POST" && typeof body.to === "string" && body.to.startsWith("workspace:")) {
    workspaceId = body.to.slice("workspace:".length);
    operation = "messages.send";
    targetType = "message";
  }

  if (url.pathname === "/tasks" && method === "POST" && typeof body.workspace_id === "string") {
    workspaceId = body.workspace_id;
    operation = "tasks.create";
    targetType = "task";
  }

  const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)\/([^/]+)$/);
  if (taskMatch && (method === "PATCH" || method === "DELETE")) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskMatch[2])).limit(1);
    if (task?.scope.startsWith("workspace:")) {
      workspaceId = task.scope.slice("workspace:".length);
      operation = method === "PATCH" ? "tasks.update" : "tasks.delete";
      targetType = "task";
      targetId = task.id;
    }
  }

  if (!workspaceId || !operation) return null;
  if (targetId && ["message", "task", "fact", "document"].includes(targetType)) {
    const quarantined = await activeQuarantine(
      workspaceId,
      targetType as QuarantineObjectTypeT,
      targetId,
    );
    if (quarantined) {
      return {
        workspaceId,
        operation,
        targetType,
        targetId,
        fingerprint: `quarantined:${quarantined.id}`,
      };
    }
  }
  return {
    workspaceId,
    operation,
    targetType,
    targetId,
    fingerprint: await requestFingerprint(method, url.pathname, body),
  };
}

async function requestFingerprint(method: string, path: string, body: Record<string, unknown>): Promise<string> {
  const canonical = `${method}\n${path}\n${stableStringify(body)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
