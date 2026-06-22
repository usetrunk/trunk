import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents, messages, roomMembers, rooms, tasks } from "../db/schema.js";
import { listRoomDelegations } from "./delegations.js";
import { resolveScopeAccess, verifyRoomAccess } from "./context.js";
import { fireRoomTaskWebhooks } from "./room-webhook.js";
import { messageToJson, taskToJson } from "./response-shapes.js";
import {
  type CheckpointState,
  type CoordinationActivity,
  type CoordinationStatus,
  type FileClaim,
  type HandoffState,
  type VerificationState,
  mergeCoordinationMetadata,
  taskCoordinationFromMetadata,
} from "./coordination-metadata.js";

const ACTIVE_MEMBER_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_CLAIM_TTL_SECONDS = 30 * 60;
const MAX_CLAIM_TTL_SECONDS = 24 * 60 * 60;
const MAX_FILES_PER_EVENT = 100;

type TaskRow = typeof tasks.$inferSelect;
type CoordinationTaskEvent = "task.claimed" | "task.checkpointed" | "task.blocked" | "task.handed_off" | "task.updated";

export class CoordinationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type ClaimTaskInput = {
  claimed_files?: string[];
  ttl_seconds?: number;
  reason?: string;
  force?: boolean;
  expected_status?: CoordinationStatus;
  announce?: boolean;
  announcement?: string | null;
};

export type CheckpointTaskInput = {
  summary: string;
  status?: CoordinationStatus;
  files_changed?: string[];
  commands_run?: string[];
  verification?: {
    command: string;
    status: VerificationState["status"];
    output?: string | null;
  } | null;
  blocker?: {
    reason: string;
    waiting_on?: string | null;
  } | null;
  next_step?: string | null;
  announce?: boolean;
  announcement?: string | null;
};

export type HandoffTaskInput = {
  to_agent?: string | null;
  summary: string;
  next_action?: string | null;
  status?: CoordinationStatus;
  announce?: boolean;
  announcement?: string | null;
};

export async function claimTask(agentId: string, scopeId: string, taskId: string, input: ClaimTaskInput) {
  const scope = await requireScopeAccess(agentId, scopeId);
  const current = await getTaskForScope(scope, taskId);
  if (!current) throw new CoordinationError(404, "TASK_NOT_FOUND", "Task not found");

  if (input.expected_status && current.status !== input.expected_status) {
    throw new CoordinationError(409, "TASK_STATUS_CHANGED", "Task status changed", {
      current_status: current.status,
      expected_status: input.expected_status,
    });
  }

  if (!input.force && current.owner && current.owner !== agentId) {
    throw new CoordinationError(409, "TASK_CLAIMED", "Task is already claimed", {
      owner: current.owner,
      task: taskToJson(current),
    });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const ttlSeconds = clampTtl(input.ttl_seconds);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const existing = taskCoordinationFromMetadata(current.metadata, { taskId: current.id, owner: current.owner });
  const claimedFiles = normalizeRequestedFiles(input.claimed_files).map<FileClaim>((path) => ({
    path,
    claimed_by: agentId,
    claimed_at: nowIso,
    expires_at: expiresAt,
    task_id: taskId,
    note: input.reason ?? null,
  }));
  const activity = appendActivity(existing.activity, {
    type: "claim",
    agent_id: agentId,
    at: nowIso,
    summary: input.reason ?? "Task claimed",
    files: claimedFiles.map((claim) => claim.path),
  });
  const metadata = mergeCoordinationMetadata(current.metadata, {
    claimed_files: claimedFiles,
    activity,
  });

  const conditions = input.force
    ? and(eq(tasks.id, taskId), eq(tasks.scope, scope))
    : and(eq(tasks.id, taskId), eq(tasks.scope, scope), or(isNull(tasks.owner), eq(tasks.owner, agentId))!);

  const [updated] = await db
    .update(tasks)
    .set({ owner: agentId, status: "in-progress", metadata, updatedAt: now })
    .where(conditions)
    .returning();

  if (!updated) {
    const latest = await getTaskForScope(scope, taskId);
    throw new CoordinationError(409, "TASK_CLAIMED", "Task is already claimed", {
      owner: latest?.owner ?? null,
      task: latest ? taskToJson(latest) : null,
    });
  }

  await emitRoomTaskEvent(updated, "task.claimed");
  if (input.announce && updated.scope.startsWith("room:")) {
    await announceRoomCoordination(agentId, updated, {
      type: "update",
      event: "task.claimed",
      content: input.announcement || input.reason || "Task claimed",
      files: claimedFiles.map((claim) => claim.path),
    });
  }
  return taskToJson(updated);
}

export async function checkpointTask(agentId: string, scopeId: string, taskId: string, input: CheckpointTaskInput) {
  if (!input.summary || !input.summary.trim()) {
    throw new CoordinationError(400, "MISSING_FIELD", "summary is required");
  }

  const scope = await requireScopeAccess(agentId, scopeId);
  const current = await getTaskForScope(scope, taskId);
  if (!current) throw new CoordinationError(404, "TASK_NOT_FOUND", "Task not found");

  const now = new Date();
  const nowIso = now.toISOString();
  const existing = taskCoordinationFromMetadata(current.metadata, { taskId: current.id, owner: current.owner });
  const verification = input.verification
    ? {
        command: input.verification.command,
        status: input.verification.status,
        output: input.verification.output ?? null,
        verified_by: agentId,
        verified_at: nowIso,
      }
    : null;
  const blocker = input.blocker
    ? {
        reason: input.blocker.reason,
        waiting_on: input.blocker.waiting_on ?? null,
        blocked_by: agentId,
        blocked_at: nowIso,
      }
    : null;
  const checkpoint: CheckpointState = {
    summary: input.summary,
    status: input.status,
    files_changed: normalizeRequestedFiles(input.files_changed),
    commands_run: normalizeRequestedFiles(input.commands_run),
    verification,
    blocker,
    next_step: input.next_step ?? null,
    updated_by: agentId,
    updated_at: nowIso,
  };
  const activity = appendActivity(existing.activity, {
    type: blocker ? "blocker" : "checkpoint",
    agent_id: agentId,
    at: nowIso,
    summary: input.summary,
    files: checkpoint.files_changed,
    verification,
    blocker,
  });
  const nextStatus = input.status ?? (blocker ? "blocked" : current.status);
  const metadata = mergeCoordinationMetadata(current.metadata, {
    checkpoint,
    verification,
    blocker,
    activity,
  });

  const [updated] = await db
    .update(tasks)
    .set({ status: nextStatus, metadata, updatedAt: now })
    .where(and(eq(tasks.id, taskId), eq(tasks.scope, scope)))
    .returning();

  if (!updated) throw new CoordinationError(404, "TASK_NOT_FOUND", "Task not found");

  await emitRoomTaskEvent(updated, blocker ? "task.blocked" : "task.checkpointed");
  if ((input.announce || blocker) && updated.scope.startsWith("room:")) {
    await announceRoomCoordination(agentId, updated, {
      type: "update",
      event: blocker ? "task.blocked" : "task.checkpointed",
      content: input.announcement || input.summary,
      files: checkpoint.files_changed,
      verification,
      blocker,
      next_step: input.next_step ?? null,
    });
  }
  return taskToJson(updated);
}

export async function handoffTask(agentId: string, scopeId: string, taskId: string, input: HandoffTaskInput) {
  if (!input.summary || !input.summary.trim()) {
    throw new CoordinationError(400, "MISSING_FIELD", "summary is required");
  }

  const scope = await requireScopeAccess(agentId, scopeId);
  const current = await getTaskForScope(scope, taskId);
  if (!current) throw new CoordinationError(404, "TASK_NOT_FOUND", "Task not found");

  if (input.to_agent && !(await canAccessScope(input.to_agent, scope))) {
    throw new CoordinationError(403, "HANDOFF_TARGET_NOT_IN_SCOPE", "Target agent cannot access this task scope");
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const existing = taskCoordinationFromMetadata(current.metadata, { taskId: current.id, owner: current.owner });
  const handoff: HandoffState = {
    from_agent: agentId,
    to_agent: input.to_agent ?? null,
    summary: input.summary,
    next_action: input.next_action ?? null,
    acknowledged_at: null,
    created_at: nowIso,
  };
  const activity = appendActivity(existing.activity, {
    type: "handoff",
    agent_id: agentId,
    at: nowIso,
    summary: input.summary,
    handoff_to: input.to_agent ?? null,
  });
  const metadata = mergeCoordinationMetadata(current.metadata, {
    handoff,
    activity,
  });

  const [updated] = await db
    .update(tasks)
    .set({
      owner: input.to_agent ?? null,
      status: input.status ?? "in-progress",
      metadata,
      updatedAt: now,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.scope, scope)))
    .returning();

  if (!updated) throw new CoordinationError(404, "TASK_NOT_FOUND", "Task not found");

  await emitRoomTaskEvent(updated, "task.handed_off");
  if (input.announce !== false && updated.scope.startsWith("room:")) {
    await announceRoomCoordination(agentId, updated, {
      type: "handoff",
      event: "task.handed_off",
      content: input.announcement || input.summary,
      next_action: input.next_action ?? null,
      to_agent: input.to_agent ?? null,
    });
  }
  return taskToJson(updated);
}

export async function getRoomState(agentId: string, roomId: string) {
  if (!(await verifyRoomAccess(agentId, roomId))) {
    throw new CoordinationError(403, "NOT_MEMBER", "Not a room member");
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) throw new CoordinationError(404, "ROOM_NOT_FOUND", "Room not found");

  const memberRows = await db.select().from(roomMembers).where(eq(roomMembers.roomId, roomId)).limit(500);
  const memberIds = memberRows.map((member) => member.agentId);
  const agentRows = memberIds.length > 0
    ? await db.select().from(agents).where(inArray(agents.id, memberIds))
    : [];
  const activeCutoff = Date.now() - ACTIVE_MEMBER_WINDOW_MS;
  const members = memberRows.map((member) => {
    const agent = agentRows.find((row) => row.id === member.agentId);
    const lastSeenAt = agent?.lastSeenAt ?? null;
    const active = lastSeenAt instanceof Date ? lastSeenAt.getTime() >= activeCutoff : false;
    const metadata = isRecord(agent?.metadata) ? agent.metadata : {};
    return {
      agent_id: member.agentId,
      name: agent?.name ?? member.agentId,
      owner: agent?.owner ?? null,
      role: member.role,
      profile_role: typeof metadata.role === "string" ? metadata.role : null,
      collaboration_role: member.collaborationRole ?? null,
      joined_at: member.joinedAt,
      last_seen_at: lastSeenAt,
      status_text: typeof metadata.status_text === "string" ? metadata.status_text : null,
      active,
    };
  });

  const taskRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.scope, `room:${roomId}`))
    .orderBy(desc(tasks.updatedAt))
    .limit(200);
  const roomTasks = taskRows.map(taskToJson);

  const recentMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.toRoom, roomId))
    .orderBy(desc(messages.createdAt))
    .limit(25);

  const fileClaims = roomTasks.flatMap((task) =>
    task.coordination.claimed_files.map((claim) => ({
      ...claim,
      task_id: task.id,
      task_title: task.title,
      stale: isStaleClaim(claim),
    }))
  );
  const blockers = roomTasks
    .filter((task) => task.coordination.blocker)
    .map((task) => ({
      task_id: task.id,
      task_title: task.title,
      ...task.coordination.blocker!,
    }));
  const checkpoints = roomTasks
    .filter((task) => task.coordination.checkpoint)
    .map((task) => ({
      task_id: task.id,
      task_title: task.title,
      ...task.coordination.checkpoint!,
    }));
  const handoffs = roomTasks
    .filter((task) => task.coordination.handoff)
    .map((task) => ({
      task_id: task.id,
      task_title: task.title,
      ...task.coordination.handoff!,
    }));
  const delegations = await listRoomDelegations(roomId);

  return {
    room: {
      id: room.id,
      name: room.name,
      created_by: room.createdBy,
      created_at: room.createdAt,
      metadata: room.metadata ?? {},
    },
    members,
    tasks: roomTasks,
    file_claims: fileClaims,
    delegations,
    blockers,
    checkpoints,
    handoffs,
    latest_activity: {
      messages: recentMessages.map(messageToJson),
      task_activity: roomTasks.flatMap((task) =>
        task.coordination.activity.map((activity) => ({
          task_id: task.id,
          task_title: task.title,
          ...activity,
        }))
      ).slice(-50),
    },
    summary: {
      members: members.length,
      active_members: members.filter((member) => member.active).length,
      open_tasks: roomTasks.filter((task) => task.status === "open").length,
      in_progress_tasks: roomTasks.filter((task) => task.status === "in-progress").length,
      blocked_tasks: roomTasks.filter((task) => task.status === "blocked").length,
      done_tasks: roomTasks.filter((task) => task.status === "done").length,
      file_claims: fileClaims.length,
      delegations: delegations.length,
      open_delegations: delegations.filter((delegation) => delegation.status === "open").length,
      stale_claims: fileClaims.filter((claim) => claim.stale).length,
      blockers: blockers.length,
      handoffs: handoffs.length,
    },
  };
}

function appendActivity(existing: CoordinationActivity[], item: CoordinationActivity): CoordinationActivity[] {
  return [...existing, item].slice(-50);
}

function normalizeRequestedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, MAX_FILES_PER_EVENT);
}

function clampTtl(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_CLAIM_TTL_SECONDS;
  return Math.min(Math.floor(value), MAX_CLAIM_TTL_SECONDS);
}

async function requireScopeAccess(agentId: string, scopeId: string): Promise<string> {
  const scope = await resolveScopeAccess(agentId, scopeId);
  if (!scope) throw new CoordinationError(403, "FORBIDDEN", "No access");
  return scope;
}

async function getTaskForScope(scope: string, taskId: string): Promise<TaskRow | undefined> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.scope, scope)))
    .limit(1);
  return task;
}

async function canAccessScope(agentId: string, scope: string): Promise<boolean> {
  if (scope.startsWith("room:")) return verifyRoomAccess(agentId, scope.slice(5));
  const resolved = await resolveScopeAccess(agentId, scope.replace(/^workspace:|^contact:/, ""));
  return resolved === scope;
}

async function emitRoomTaskEvent(task: TaskRow, event: CoordinationTaskEvent = "task.updated") {
  if (!task.scope.startsWith("room:")) return;
  const roomId = task.scope.slice(5);
  const payload = taskToJson(task);
  await fireRoomTaskWebhooks(roomId, payload, event);
}

async function announceRoomCoordination(
  agentId: string,
  task: TaskRow,
  announcement: {
    type: "update" | "handoff";
    event: CoordinationTaskEvent;
    content: string;
    files?: string[];
    verification?: VerificationState | null;
    blocker?: { reason: string; waiting_on?: string | null; blocked_by?: string | null; blocked_at?: string | null } | null;
    next_step?: string | null;
    next_action?: string | null;
    to_agent?: string | null;
  },
) {
  if (!task.scope.startsWith("room:")) return;
  const roomId = task.scope.slice(5);
  const recipients = await db
    .select({ agentId: roomMembers.agentId })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId));
  const recipientIds = recipients.map((recipient) => recipient.agentId).filter((id) => id !== agentId);
  if (recipientIds.length === 0) return;

  const threadId = crypto.randomUUID();
  const now = new Date();
  const payload = {
    content: announcement.content,
    source: "coordination",
    finality: "fyi",
    event: announcement.event,
    task_id: task.id,
    task_title: task.title,
    files: announcement.files ?? [],
    verification: announcement.verification ?? null,
    blocker: announcement.blocker ?? null,
    next_step: announcement.next_step ?? null,
    next_action: announcement.next_action ?? null,
    to_agent: announcement.to_agent ?? null,
  };

  await db.transaction(async (tx) => {
    for (const recipientId of recipientIds) {
      await tx
        .insert(messages)
        .values({
          fromAgent: agentId,
          toAgent: recipientId,
          toRoom: roomId,
          threadId,
          idempotencyKey: `coordination:${announcement.event}:${task.id}:${recipientId}:${now.getTime()}`,
          type: announcement.type,
          payload,
          status: "delivered",
          deliveredAt: now,
        });
    }
  });
}

function isStaleClaim(claim: FileClaim): boolean {
  if (!claim.expires_at) return false;
  const expiresAt = Date.parse(claim.expires_at);
  return Number.isFinite(expiresAt) && expiresAt < Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
