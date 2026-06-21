import { z } from "zod";
import { Uuid, IsoTimestamp, ScopedId } from "./primitives.js";

/**
 * Inspector views — read-only surfaces for humans and operators to inspect
 * delivery health, thread timelines, webhook attempts, audit events, task
 * changes, and fact touches.
 *
 * These are first-class schema types so dashboards, SDK consumers, and CLI
 * tools render the same shape.
 */

export const DeliveryAttempt = z.object({
  id: Uuid,
  message_id: Uuid.nullable(),
  url: z.string(),
  event: z.string(),
  success: z.boolean(),
  http_status: z.number().int().nullable(),
  latency_ms: z.number().int().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  created_at: IsoTimestamp,
});
export type DeliveryAttemptT = z.infer<typeof DeliveryAttempt>;

export const DeliveryHealth = z.object({
  agent_id: Uuid,
  window: z.object({
    from: IsoTimestamp,
    to: IsoTimestamp,
  }),
  totals: z.object({
    attempts: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    success_rate: z.number().min(0).max(1).nullable(),
    avg_latency_ms: z.number().nullable(),
  }),
  recent_failures: z.array(DeliveryAttempt).max(50),
  recent_successes: z.array(DeliveryAttempt).max(50),
  by_event: z.array(
    z.object({
      event: z.string(),
      attempts: z.number().int().nonnegative(),
      successes: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
    }),
  ),
  webhook_configured: z.boolean(),
});
export type DeliveryHealthT = z.infer<typeof DeliveryHealth>;

export const ThreadTimelineEntry = z.object({
  message_id: Uuid,
  type: z.string(),
  from: Uuid,
  from_name: z.string().nullable().optional(),
  to: Uuid,
  to_name: z.string().nullable().optional(),
  status: z.string(),
  created_at: IsoTimestamp,
  delivered_at: IsoTimestamp.nullable().optional(),
  read_at: IsoTimestamp.nullable().optional(),
  replied_at: IsoTimestamp.nullable().optional(),
  edited_at: IsoTimestamp.nullable().optional(),
  attempts: z.number().int().nonnegative().optional(),
  delivery_state: z.enum(["queued", "delivered", "failed", "skipped", "unknown"]),
});
export type ThreadTimelineEntryT = z.infer<typeof ThreadTimelineEntry>;

export const ThreadTimeline = z.object({
  thread_id: Uuid,
  participants: z.array(z.object({ agent_id: Uuid, name: z.string().nullable().optional() })),
  entries: z.array(ThreadTimelineEntry),
  counts: z.object({
    messages: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    edited: z.number().int().nonnegative(),
  }),
});
export type ThreadTimelineT = z.infer<typeof ThreadTimeline>;

export const AuditEvent = z.object({
  id: Uuid,
  actor_agent: Uuid.nullable(),
  action: z.string(),
  target_type: z.string(),
  target_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: IsoTimestamp,
});
export type AuditEventT = z.infer<typeof AuditEvent>;

export const TaskChangeEvent = z.object({
  task_id: Uuid,
  scope: ScopedId,
  action: z.enum(["created", "updated", "deleted", "status_changed", "assigned"]),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  actor_agent: Uuid.nullable(),
  reason: z.string().nullable().optional(),
  occurred_at: IsoTimestamp,
  title: z.string().optional(),
});
export type TaskChangeEventT = z.infer<typeof TaskChangeEvent>;

export const FactTouch = z.object({
  key: z.string(),
  scope: ScopedId,
  version: z.number().int().nonnegative(),
  set_by: Uuid,
  set_at: IsoTimestamp,
  reason: z.string().nullable().optional(),
  source_message_id: Uuid.nullable().optional(),
  source_thread_id: Uuid.nullable().optional(),
});
export type FactTouchT = z.infer<typeof FactTouch>;

export const InspectorSummary = z.object({
  agent_id: Uuid,
  generated_at: IsoTimestamp,
  health: DeliveryHealth,
  recent_threads: z.array(z.object({ thread_id: Uuid, last_activity: IsoTimestamp, message_count: z.number().int().nonnegative() })),
  recent_facts: z.array(FactTouch),
  recent_audits: z.array(AuditEvent),
});
export type InspectorSummaryT = z.infer<typeof InspectorSummary>;
