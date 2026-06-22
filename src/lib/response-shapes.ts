import { taskCoordinationFromMetadata } from "./coordination-metadata.js";

type MessageLike = {
  id: string;
  fromAgent: string;
  toAgent: string;
  toWorkspace?: string | null;
  toRoom?: string | null;
  threadId: string | null;
  replyTo?: string | null;
  idempotencyKey?: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: string | Date;
  readAt?: string | Date | null;
  deliveredAt?: string | Date | null;
  processedAt?: string | Date | null;
  repliedAt?: string | Date | null;
  deletedAt?: string | Date | null;
  editedAt?: string | Date | null;
  pinnedAt?: string | Date | null;
  pinnedBy?: string | null;
  scheduledAt?: string | Date | null;
  expiresAt?: string | Date | null;
};

type TaskLike = {
  id: string;
  scope: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  owner: string | null;
  createdBy: string;
  due: string | null;
  startDate: string | null;
  group: string | null;
  dependsOn: string[] | unknown;
  sequence: number | null;
  estimate: number | null;
  contextRef: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string | Date;
  updatedAt: string | Date;
};

export function messageToJson(message: MessageLike) {
  return {
    id: message.id,
    from_agent: message.fromAgent,
    to_agent: message.toAgent,
    to_workspace: message.toWorkspace ?? null,
    to_room: message.toRoom ?? null,
    thread_id: message.threadId,
    reply_to: message.replyTo ?? null,
    idempotency_key: message.idempotencyKey ?? null,
    type: message.type,
    payload: message.payload,
    status: message.status,
    created_at: message.createdAt,
    read_at: message.readAt ?? null,
    delivered_at: message.deliveredAt ?? null,
    processed_at: message.processedAt ?? null,
    replied_at: message.repliedAt ?? null,
    deleted_at: message.deletedAt ?? null,
    edited_at: message.editedAt ?? null,
    pinned_at: message.pinnedAt ?? null,
    pinned_by: message.pinnedBy ?? null,
    scheduled_at: message.scheduledAt ?? null,
    expires_at: message.expiresAt ?? null,
  };
}

export function taskToJson(task: TaskLike) {
  return {
    id: task.id,
    scope: task.scope,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    owner: task.owner,
    created_by: task.createdBy,
    due: task.due,
    start_date: task.startDate,
    group: task.group,
    depends_on: task.dependsOn,
    sequence: task.sequence,
    estimate: task.estimate,
    context_ref: task.contextRef,
    metadata: task.metadata ?? {},
    coordination: taskCoordinationFromMetadata(task.metadata, { taskId: task.id, owner: task.owner }),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}
