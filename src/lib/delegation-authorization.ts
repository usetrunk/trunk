import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentDelegations, agents, roomMembers, tasks } from "../db/schema.js";
import type { DelegationCapabilityT } from "../protocol/delegations.js";

export type DelegationEnvelope = {
  id: string;
  parentAgentId: string;
  childAgentId: string;
  roomId: string;
  taskId: string;
  capabilities: DelegationCapabilityT[];
  expiresAt: Date | null;
};

export type DelegationCredentialResolution =
  | { kind: "none" }
  | { kind: "active"; envelope: DelegationEnvelope }
  | { kind: "invalid" };

export type DelegationAuthorizationTarget = {
  roomId?: string;
  taskId?: string;
  agentId?: string;
};

export type DelegationAuthorizationRequest = {
  capability: DelegationCapabilityT;
  target?: DelegationAuthorizationTarget;
};

export type DelegationAuthorizationDecision =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "DELEGATION_ACTION_NOT_ALLOWED"
        | "DELEGATION_SCOPE_MISMATCH"
        | "DELEGATION_PRIVILEGE_ESCALATION";
      message: string;
    };

export async function resolveDelegationCredential(
  agentId: string,
  visited = new Set<string>(),
): Promise<DelegationCredentialResolution> {
  if (visited.has(agentId)) return { kind: "invalid" };
  visited.add(agentId);

  const [row] = await db
    .select()
    .from(agentDelegations)
    .where(eq(agentDelegations.childAgentId, agentId))
    .limit(1);
  if (!row || row.containment !== "strict") return { kind: "none" };
  if (
    row.status !== "claimed"
    || !row.childAgentId
    || !row.taskId
    || row.revokedAt
    || (row.expiresAt && row.expiresAt.getTime() <= Date.now())
  ) {
    await invalidateExpiredCredential(row);
    return { kind: "invalid" };
  }

  const [parentMembership] = await db
    .select({ agentId: roomMembers.agentId })
    .from(roomMembers)
    .where(and(
      eq(roomMembers.roomId, row.roomId),
      eq(roomMembers.agentId, row.parentAgentId),
    ))
    .limit(1);
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(
      eq(tasks.id, row.taskId),
      eq(tasks.scope, `room:${row.roomId}`),
    ))
    .limit(1);
  if (!parentMembership || !task) return { kind: "invalid" };

  const envelope: DelegationEnvelope = {
    id: row.id,
    parentAgentId: row.parentAgentId,
    childAgentId: row.childAgentId,
    roomId: row.roomId,
    taskId: row.taskId,
    capabilities: normalizeCapabilities(row.capabilities),
    expiresAt: row.expiresAt,
  };

  const parentResolution = await resolveDelegationCredential(row.parentAgentId, visited);
  if (parentResolution.kind === "invalid") return { kind: "invalid" };
  if (parentResolution.kind === "active") {
    const parent = parentResolution.envelope;
    const isContained =
      parent.capabilities.includes("delegations:create")
      && parent.roomId === envelope.roomId
      && parent.taskId === envelope.taskId
      && envelope.capabilities.every((capability) => parent.capabilities.includes(capability))
      && (
        !parent.expiresAt
        || (envelope.expiresAt !== null && envelope.expiresAt.getTime() <= parent.expiresAt.getTime())
      );
    if (!isContained) return { kind: "invalid" };
  }

  return { kind: "active", envelope };
}

export function authorizeDelegation(
  envelope: DelegationEnvelope,
  request: DelegationAuthorizationRequest | null,
): DelegationAuthorizationDecision {
  if (!request || !envelope.capabilities.includes(request.capability)) {
    return {
      allowed: false,
      code: "DELEGATION_ACTION_NOT_ALLOWED",
      message: "The delegated credential cannot perform this action",
    };
  }

  const target = request.target;
  if (
    (target?.roomId && target.roomId !== envelope.roomId)
    || (target?.taskId && target.taskId !== envelope.taskId)
    || (
      target?.agentId
      && target.agentId !== envelope.parentAgentId
      && target.agentId !== envelope.childAgentId
    )
  ) {
    return {
      allowed: false,
      code: "DELEGATION_SCOPE_MISMATCH",
      message: "The requested resource is outside the delegated room and task",
    };
  }
  return { allowed: true };
}

export async function delegationRequestForHttp(
  request: Request,
  envelope: DelegationEnvelope,
): Promise<DelegationAuthorizationRequest | null | DelegationAuthorizationDecision> {
  const url = new URL(request.url);
  const path = url.pathname;
  const read = request.method === "GET" || request.method === "HEAD";
  const body = read ? null : await request.clone().json().catch(() => null);
  const record = isRecord(body) ? body : {};

  if (path === "/agents/me" && read) {
    return { capability: "rooms:read" };
  }

  if (path === "/messages" || path.startsWith("/messages/")) {
    if (!read && path !== "/messages") return null;
    const target: DelegationAuthorizationTarget = {};
    if (path === "/messages" && typeof record.to === "string") {
      if (record.to.startsWith("room:")) target.roomId = record.to.slice("room:".length);
      else if (record.to.startsWith("workspace:")) target.roomId = record.to;
      else target.agentId = record.to;
    }
    return {
      capability: read ? "messages:read" : "messages:send",
      target,
    };
  }

  const roomMatch = path.match(/^\/rooms\/([^/]+)\/(?:members|state)$/);
  if (read && roomMatch) {
    return { capability: "rooms:read", target: { roomId: decodeURIComponent(roomMatch[1]) } };
  }

  const taskListMatch = path.match(/^\/tasks\/room\/([^/]+)$/);
  if (read && taskListMatch) {
    return { capability: "tasks:read", target: { roomId: decodeURIComponent(taskListMatch[1]) } };
  }
  const taskMutationMatch = path.match(/^\/tasks\/([^/]+)\/([^/]+)(?:\/(?:claim|checkpoint|handoff))?$/);
  if (taskMutationMatch && !read) {
    return {
      capability: "tasks:write",
      target: {
        roomId: decodeURIComponent(taskMutationMatch[1]),
        taskId: decodeURIComponent(taskMutationMatch[2]),
      },
    };
  }

  const contextMatch = path.match(/^\/context\/room\/([^/]+)\/facts(?:\/[^/]+(?:\/history)?)?$/);
  if (contextMatch) {
    return {
      capability: read ? "facts:read" : "facts:write",
      target: { roomId: decodeURIComponent(contextMatch[1]) },
    };
  }

  const documentMatch = path.match(/^\/documents\/room\/([^/]+)(?:\/.*)?$/);
  if (documentMatch) {
    return {
      capability: read ? "documents:read" : "documents:write",
      target: { roomId: decodeURIComponent(documentMatch[1]) },
    };
  }

  if (path === "/delegations" || path.startsWith("/delegations/")) {
    if (request.method === "POST" && path === "/delegations") {
      if (record.containment !== "strict") {
        return {
          allowed: false,
          code: "DELEGATION_PRIVILEGE_ESCALATION",
          message: "A strictly contained agent can only create strict child delegations",
        };
      }
      return {
        capability: "delegations:create",
        target: {
          roomId: stringValue(record.room_id),
          taskId: stringValue(record.task_id),
        },
      };
    }
    return {
      capability: "delegations:create",
      target: { roomId: url.searchParams.get("room_id") ?? envelope.roomId },
    };
  }

  return null;
}

export function delegationRequestForMcp(
  toolName: string,
  args: Record<string, unknown>,
  envelope: DelegationEnvelope,
): DelegationAuthorizationRequest | null | DelegationAuthorizationDecision {
  const roomId = stringValue(args.room_id);
  const taskId = stringValue(args.task_id);
  const target: DelegationAuthorizationTarget = { roomId, taskId };

  if (MCP_MESSAGE_READ_TOOLS.has(toolName)) return { capability: "messages:read" };
  if (MCP_MESSAGE_WRITE_TOOLS.has(toolName)) {
    if (toolName !== "trunk_send") return null;
    const to = stringValue(args.to);
    if (to?.startsWith("room:")) target.roomId = to.slice("room:".length);
    else if (to?.startsWith("workspace:")) target.roomId = to;
    else if (to) target.agentId = to;
    return { capability: "messages:send", target };
  }
  if (toolName === "trunk_room_state") return { capability: "rooms:read", target };
  if (toolName === "trunk_task_list") return { capability: "tasks:read", target };
  if (toolName.startsWith("trunk_task_") && toolName !== "trunk_task_create") {
    return { capability: "tasks:write", target };
  }
  if (toolName === "trunk_fact") {
    const action = stringValue(args.action);
    return {
      capability: action === "get" || action === "list" || action === "history" ? "facts:read" : "facts:write",
      target,
    };
  }
  if (toolName === "trunk_document_versions") {
    return { capability: "documents:read", target };
  }
  if (toolName === "trunk_document") {
    const action = stringValue(args.action);
    return {
      capability: action === "get" || action === "list" || action === "versions" ? "documents:read" : "documents:write",
      target,
    };
  }
  if (toolName === "trunk_delegate") {
    const action = stringValue(args.action);
    if (action === "create" && args.containment !== "strict") {
      return {
        allowed: false,
        code: "DELEGATION_PRIVILEGE_ESCALATION",
        message: "A strictly contained agent can only create strict child delegations",
      };
    }
    return {
      capability: "delegations:create",
      target: { roomId: roomId ?? envelope.roomId, taskId: taskId ?? envelope.taskId },
    };
  }
  if (toolName === "trunk_profile") {
    return { capability: "rooms:read", target: { agentId: envelope.childAgentId } };
  }
  return null;
}

async function invalidateExpiredCredential(row: typeof agentDelegations.$inferSelect): Promise<void> {
  if (
    row.containment !== "strict"
    || row.status !== "claimed"
    || !row.childAgentId
    || !row.expiresAt
    || row.expiresAt.getTime() > Date.now()
  ) return;

  await db.transaction(async (tx) => {
    await tx.update(agentDelegations)
      .set({ status: "expired" })
      .where(and(
        eq(agentDelegations.id, row.id),
        eq(agentDelegations.status, "claimed"),
        isNull(agentDelegations.revokedAt),
      ));
    await tx.update(agents)
      .set({ secretHash: await invalidatedSecretHash() })
      .where(eq(agents.id, row.childAgentId!));
  });
}

async function invalidatedSecretHash(): Promise<string> {
  const material = new Uint8Array(32);
  crypto.getRandomValues(material);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeCapabilities(value: unknown): DelegationCapabilityT[] {
  return Array.isArray(value)
    ? value.filter((item): item is DelegationCapabilityT => (
      typeof item === "string" && DELEGATION_CAPABILITY_SET.has(item)
    ))
    : [];
}

const DELEGATION_CAPABILITY_SET = new Set<string>([
  "messages:send",
  "messages:read",
  "facts:read",
  "facts:write",
  "tasks:read",
  "tasks:write",
  "rooms:read",
  "documents:read",
  "documents:write",
  "delegations:create",
]);

const MCP_MESSAGE_READ_TOOLS = new Set([
  "trunk_inbox",
  "trunk_inbox_stats",
  "trunk_sent",
  "trunk_search",
  "trunk_message_edit_history",
  "trunk_scheduled_messages",
  "trunk_reactions",
  "trunk_thread_pins",
  "trunk_thread",
  "trunk_thread_summary",
  "trunk_threads",
  "trunk_message_labels",
  "trunk_labels_list",
  "trunk_messages_by_label",
]);

const MCP_MESSAGE_WRITE_TOOLS = new Set([
  "trunk_send",
  "trunk_reply",
  "trunk_ack_bulk",
  "trunk_read_bulk",
  "trunk_delete_bulk",
  "trunk_label_bulk",
  "trunk_edit_message",
  "trunk_delete_message",
  "trunk_purge_messages",
  "trunk_cancel_scheduled",
  "trunk_deliver_scheduled",
  "trunk_forward",
  "trunk_react",
  "trunk_unreact",
  "trunk_pin",
  "trunk_unpin",
  "trunk_mark_read",
  "trunk_label_message",
  "trunk_unlabel_message",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
