export type CoordinationStatus = "open" | "in-progress" | "done" | "blocked";
export type VerificationStatus = "pending" | "passed" | "failed" | "skipped";

export type FileClaim = {
  path: string;
  claimed_by: string | null;
  claimed_at: string | null;
  expires_at: string | null;
  task_id?: string | null;
  note?: string | null;
};

export type VerificationState = {
  command: string;
  status: VerificationStatus;
  output?: string | null;
  verified_by?: string | null;
  verified_at?: string | null;
};

export type BlockerState = {
  reason: string;
  waiting_on?: string | null;
  blocked_by?: string | null;
  blocked_at?: string | null;
};

export type CheckpointState = {
  summary: string;
  status?: CoordinationStatus;
  files_changed: string[];
  commands_run: string[];
  verification?: VerificationState | null;
  blocker?: BlockerState | null;
  next_step?: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

export type HandoffState = {
  from_agent: string | null;
  to_agent: string | null;
  summary: string;
  next_action?: string | null;
  acknowledged_at?: string | null;
  created_at: string | null;
};

export type CoordinationActivity = {
  type: "claim" | "checkpoint" | "handoff" | "release" | "blocker";
  agent_id: string | null;
  at: string | null;
  summary?: string | null;
  files?: string[];
  verification?: VerificationState | null;
  blocker?: BlockerState | null;
  handoff_to?: string | null;
};

export type TaskCoordinationState = {
  claimed_files: FileClaim[];
  checkpoint: CheckpointState | null;
  verification: VerificationState | null;
  blocker: BlockerState | null;
  handoff: HandoffState | null;
  activity: CoordinationActivity[];
};

export const COORDINATION_METADATA_KEYS = [
  "claimed_files",
  "checkpoint",
  "verification",
  "blocker",
  "handoff",
  "activity",
] as const;

export function taskCoordinationFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  fallback: { taskId?: string; owner?: string | null } = {},
): TaskCoordinationState {
  const meta = isRecord(metadata) ? metadata : {};
  const nowClaimedBy = fallback.owner ?? null;

  return {
    claimed_files: normalizeFileClaims(meta.claimed_files, nowClaimedBy, fallback.taskId ?? null),
    checkpoint: normalizeCheckpoint(meta.checkpoint),
    verification: normalizeVerification(meta.verification),
    blocker: normalizeBlocker(meta.blocker),
    handoff: normalizeHandoff(meta.handoff),
    activity: normalizeActivity(meta.activity),
  };
}

export function mergeCoordinationMetadata(
  metadata: Record<string, unknown> | null | undefined,
  patch: Partial<TaskCoordinationState>,
): Record<string, unknown> {
  const existing = isRecord(metadata) ? { ...metadata } : {};
  if (patch.claimed_files !== undefined) existing.claimed_files = patch.claimed_files;
  if (patch.checkpoint !== undefined) existing.checkpoint = patch.checkpoint;
  if (patch.verification !== undefined) existing.verification = patch.verification;
  if (patch.blocker !== undefined) existing.blocker = patch.blocker;
  if (patch.handoff !== undefined) existing.handoff = patch.handoff;
  if (patch.activity !== undefined) existing.activity = patch.activity.slice(-50);
  return existing;
}

function normalizeFileClaims(value: unknown, claimedBy: string | null, taskId: string | null): FileClaim[] {
  if (!Array.isArray(value)) return [];
  return value
    .map<FileClaim | null>((item) => {
      if (typeof item === "string") {
        return {
          path: item,
          claimed_by: claimedBy,
          claimed_at: null,
          expires_at: null,
          task_id: taskId,
        };
      }
      if (!isRecord(item) || typeof item.path !== "string" || !item.path.trim()) return null;
      return {
        path: item.path,
        claimed_by: typeof item.claimed_by === "string" ? item.claimed_by : claimedBy,
        claimed_at: typeof item.claimed_at === "string" ? item.claimed_at : null,
        expires_at: typeof item.expires_at === "string" ? item.expires_at : null,
        task_id: typeof item.task_id === "string" ? item.task_id : taskId,
        note: typeof item.note === "string" ? item.note : null,
      };
    })
    .filter((item): item is FileClaim => item !== null);
}

function normalizeCheckpoint(value: unknown): CheckpointState | null {
  if (!isRecord(value)) return null;
  const summary = typeof value.summary === "string" ? value.summary : typeof value.status === "string" ? value.status : "";
  if (!summary.trim()) return null;
  return {
    summary,
    status: isCoordinationStatus(value.status) ? value.status : undefined,
    files_changed: stringArray(value.files_changed),
    commands_run: stringArray(value.commands_run),
    verification: normalizeVerification(value.verification),
    blocker: normalizeBlocker(value.blocker),
    next_step: typeof value.next_step === "string" ? value.next_step : null,
    updated_by: typeof value.updated_by === "string" ? value.updated_by : null,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
  };
}

function normalizeVerification(value: unknown): VerificationState | null {
  if (!isRecord(value) || typeof value.command !== "string" || !value.command.trim()) return null;
  return {
    command: value.command,
    status: isVerificationStatus(value.status) ? value.status : "pending",
    output: typeof value.output === "string" ? value.output : null,
    verified_by: typeof value.verified_by === "string" ? value.verified_by : null,
    verified_at: typeof value.verified_at === "string" ? value.verified_at : null,
  };
}

function normalizeBlocker(value: unknown): BlockerState | null {
  if (!isRecord(value) || typeof value.reason !== "string" || !value.reason.trim()) return null;
  return {
    reason: value.reason,
    waiting_on: typeof value.waiting_on === "string" ? value.waiting_on : null,
    blocked_by: typeof value.blocked_by === "string" ? value.blocked_by : null,
    blocked_at: typeof value.blocked_at === "string" ? value.blocked_at : null,
  };
}

function normalizeHandoff(value: unknown): HandoffState | null {
  if (!isRecord(value) || typeof value.summary !== "string" || !value.summary.trim()) return null;
  return {
    from_agent: typeof value.from_agent === "string" ? value.from_agent : null,
    to_agent: typeof value.to_agent === "string" ? value.to_agent : null,
    summary: value.summary,
    next_action: typeof value.next_action === "string" ? value.next_action : null,
    acknowledged_at: typeof value.acknowledged_at === "string" ? value.acknowledged_at : null,
    created_at: typeof value.created_at === "string" ? value.created_at : null,
  };
}

function normalizeActivity(value: unknown): CoordinationActivity[] {
  if (!Array.isArray(value)) return [];
  return value
    .map<CoordinationActivity | null>((item) => {
      if (!isRecord(item) || !isActivityType(item.type)) return null;
      return {
        type: item.type,
        agent_id: typeof item.agent_id === "string" ? item.agent_id : null,
        at: typeof item.at === "string" ? item.at : null,
        summary: typeof item.summary === "string" ? item.summary : null,
        files: stringArray(item.files),
        verification: normalizeVerification(item.verification),
        blocker: normalizeBlocker(item.blocker),
        handoff_to: typeof item.handoff_to === "string" ? item.handoff_to : null,
      };
    })
    .filter((item): item is CoordinationActivity => item !== null)
    .slice(-50);
}

function isCoordinationStatus(value: unknown): value is CoordinationStatus {
  return value === "open" || value === "in-progress" || value === "done" || value === "blocked";
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return value === "pending" || value === "passed" || value === "failed" || value === "skipped";
}

function isActivityType(value: unknown): value is CoordinationActivity["type"] {
  return value === "claim" || value === "checkpoint" || value === "handoff" || value === "release" || value === "blocker";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
