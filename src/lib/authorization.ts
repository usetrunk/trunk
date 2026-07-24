import type { GrantRecordT, GrantScopeT } from "../protocol/grants.js";

export type AuthorizationTarget = {
  agentId?: string;
  workspaceId?: string;
  roomId?: string;
};

export type AuthorizationRequest = {
  scope: GrantScopeT;
  target?: AuthorizationTarget;
};

export type AuthorizationDenialCode =
  | "GRANT_ACTION_NOT_ALLOWED"
  | "INSUFFICIENT_SCOPE"
  | "AUDIENCE_MISMATCH";

export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; code: AuthorizationDenialCode; message: string };

type GrantAuthorizationContext = {
  grant: GrantRecordT;
  scopes: GrantScopeT[];
};

export function authorizeGrant(
  credential: GrantAuthorizationContext | null | undefined,
  request: AuthorizationRequest | null,
): AuthorizationDecision {
  // Full bearer agent secrets are intentionally unrestricted for backwards compatibility.
  if (!credential) return { allowed: true };
  if (!request) {
    return {
      allowed: false,
      code: "GRANT_ACTION_NOT_ALLOWED",
      message: "Scoped grants cannot perform this action",
    };
  }
  if (!credential.scopes.includes(request.scope)) {
    return {
      allowed: false,
      code: "INSUFFICIENT_SCOPE",
      message: `Missing required scope: ${request.scope}`,
    };
  }

  const audience = credential.grant.audience;
  if (!audience) return { allowed: true };
  const target = request.target ?? {};
  if (audience.agent_id && audience.agent_id !== target.agentId) {
    return {
      allowed: false,
      code: "AUDIENCE_MISMATCH",
      message: "Grant agent audience does not match the requested resource",
    };
  }
  if (audience.workspace_id && audience.workspace_id !== target.workspaceId) {
    return {
      allowed: false,
      code: "AUDIENCE_MISMATCH",
      message: "Grant workspace audience does not match the requested resource",
    };
  }
  if (audience.room_id && audience.room_id !== target.roomId) {
    return {
      allowed: false,
      code: "AUDIENCE_MISMATCH",
      message: "Grant room audience does not match the requested resource",
    };
  }
  return { allowed: true };
}

export async function authorizationRequestForHttp(
  request: Request,
  actor: { id: string; workspaceId?: string | null },
): Promise<AuthorizationRequest | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const scope = scopeForHttpRequest(request.method, path);
  if (!scope) return null;

  const target: AuthorizationTarget = { agentId: actor.id };
  const roomMatch = path.match(/^\/(?:rooms|context\/room|documents\/room|tasks\/room)\/([^/]+)/);
  if (roomMatch) target.roomId = decodeURIComponent(roomMatch[1]);

  const workspaceMatch = path.match(/^\/(?:context\/workspace|documents\/workspace|tasks\/workspace)\/([^/]+)/)
    ?? path.match(/^\/tasks\/gantt\/workspace\/([^/]+)/)
    ?? path.match(/^\/workspaces\/([^/]+)/);
  if (workspaceMatch && workspaceMatch[1] !== "me") {
    target.workspaceId = decodeURIComponent(workspaceMatch[1]);
  } else if (path.startsWith("/workspaces/me")) {
    target.workspaceId = actor.workspaceId ?? undefined;
  }

  const agentMatch = path.match(/^\/agents\/([^/]+)(?:\/card)?$/)
    ?? path.match(/^\/contacts\/([^/]+)/)
    ?? path.match(/^\/context\/(?!room\/|workspace\/)([^/]+)/)
    ?? path.match(/^\/tasks\/(?!room\/|workspace\/|gantt\/)([^/]+)/);
  if (agentMatch && agentMatch[1] !== "me") {
    target.agentId = decodeURIComponent(agentMatch[1]);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await request.clone().json().catch(() => null);
    if (isRecord(body)) {
      if (typeof body.to === "string") applyAddressTarget(target, body.to);
      if (typeof body.contact_id === "string") target.agentId = body.contact_id;
      if (typeof body.workspace_id === "string") target.workspaceId = body.workspace_id;
      if (typeof body.room_id === "string") target.roomId = body.room_id;
    }
  }

  return { scope, target };
}

export function scopeForHttpRequest(method: string, path: string): GrantScopeT | null {
  const read = method === "GET" || method === "HEAD";
  if (path === "/messages" || path.startsWith("/messages/")) {
    return read ? "messages:read" : "messages:send";
  }
  if (path === "/context" || path.startsWith("/context/")) {
    return read ? "facts:read" : "facts:write";
  }
  if (path === "/tasks" || path.startsWith("/tasks/")) {
    return read ? "tasks:read" : "tasks:write";
  }
  if (path === "/rooms" || path.startsWith("/rooms/")) {
    return read ? "rooms:read" : "rooms:write";
  }
  if (read && (path === "/contacts" || path.startsWith("/contacts/"))) {
    return "contacts:read";
  }
  if (read && (path === "/workspaces" || path.startsWith("/workspaces/"))) {
    return "workspaces:read";
  }
  if (read && (/^\/agents\/(?:me|[^/]+)\/card$/.test(path) || /^\/agents\/(?!me$)[^/]+$/.test(path))) {
    return "agent_card:read";
  }
  return null;
}

export function targetFromMcpArguments(
  actorId: string,
  args: {
    agent_id?: string;
    contact_id?: string;
    workspace_id?: string;
    room_id?: string;
    to?: string;
  },
): AuthorizationTarget {
  const target: AuthorizationTarget = { agentId: actorId };
  if (args.agent_id) target.agentId = args.agent_id;
  if (args.contact_id) target.agentId = args.contact_id;
  if (args.workspace_id) target.workspaceId = args.workspace_id;
  if (args.room_id) target.roomId = args.room_id;
  if (args.to) applyAddressTarget(target, args.to);
  return target;
}

export function authorizationRequestForMcp(
  toolName: string,
  args: Record<string, unknown>,
  actor: { id: string; workspaceId?: string | null },
): AuthorizationRequest | null {
  const target = targetFromMcpArguments(actor.id, {
    agent_id: stringValue(args.agent_id),
    contact_id: stringValue(args.contact_id),
    workspace_id: stringValue(args.workspace_id),
    room_id: stringValue(args.room_id),
    to: stringValue(args.to),
  });
  const action = stringValue(args.action);

  if (MCP_MESSAGE_READ_TOOLS.has(toolName)) return { scope: "messages:read", target };
  if (MCP_MESSAGE_WRITE_TOOLS.has(toolName)) return { scope: "messages:send", target };
  if (toolName === "trunk_fact") {
    return { scope: action === "list" || action === "get" ? "facts:read" : "facts:write", target };
  }
  if (toolName === "trunk_task_list" || toolName === "trunk_gantt") {
    return { scope: "tasks:read", target };
  }
  if (toolName.startsWith("trunk_task_")) return { scope: "tasks:write", target };
  if (toolName === "trunk_room_state") return { scope: "rooms:read", target };
  if (toolName === "trunk_room") {
    return {
      scope: action === "list" || action === "members" || action === "state" ? "rooms:read" : "rooms:write",
      target,
    };
  }
  if (toolName === "trunk_room_webhook") {
    return { scope: action === "list" ? "rooms:read" : "rooms:write", target };
  }
  if (toolName === "trunk_contacts" || toolName === "trunk_blocked_list" || toolName === "trunk_contact_note" || toolName === "trunk_contact_tags") {
    return { scope: "contacts:read", target };
  }
  if (toolName === "trunk_workspace" && (action === "status" || action === "members")) {
    if (!target.workspaceId) target.workspaceId = actor.workspaceId ?? undefined;
    return { scope: "workspaces:read", target };
  }
  if (toolName === "trunk_presence") {
    target.workspaceId = actor.workspaceId ?? undefined;
    return { scope: "workspaces:read", target };
  }
  if (toolName === "trunk_profile") return { scope: "agent_card:read", target };
  return null;
}

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

function applyAddressTarget(target: AuthorizationTarget, address: string): void {
  if (address.startsWith("workspace:")) {
    target.workspaceId = address.slice("workspace:".length);
  } else if (address.startsWith("room:")) {
    target.roomId = address.slice("room:".length);
  } else {
    target.agentId = address;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
