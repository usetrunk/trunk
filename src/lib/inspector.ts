/**
 * Inspector service — read-only operational views.
 *
 * Aggregates from existing tables (webhook_deliveries, messages, audit_events,
 * tasks, fact_history) into shapes the protocol layer can publish and the
 * dashboard route can render.
 */
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  auditEvents,
  factHistory,
  messages,
  rooms,
  roomMembers,
  tasks,
  webhookDeliveries,
} from "../db/schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type DeliveryHealthSummary = {
  agent_id: string;
  window: { from: string; to: string };
  totals: {
    attempts: number;
    successes: number;
    failures: number;
    success_rate: number | null;
    avg_latency_ms: number | null;
  };
  recent_failures: Array<{
    id: string;
    message_id: string | null;
    url: string;
    event: string;
    success: boolean;
    http_status: number | null;
    latency_ms: number | null;
    error: string | null;
    attempts: number;
    created_at: string;
  }>;
  recent_successes: Array<{
    id: string;
    message_id: string | null;
    url: string;
    event: string;
    success: boolean;
    http_status: number | null;
    latency_ms: number | null;
    error: string | null;
    attempts: number;
    created_at: string;
  }>;
  by_event: Array<{
    event: string;
    attempts: number;
    successes: number;
    failures: number;
  }>;
  webhook_configured: boolean;
};

function attemptRowToJson(row: typeof webhookDeliveries.$inferSelect) {
  return {
    id: row.id,
    message_id: row.messageId,
    url: row.url,
    event: row.event,
    success: row.success === 1,
    http_status: row.httpStatus,
    latency_ms: row.latencyMs,
    error: row.error,
    attempts: row.attempts,
    created_at: row.createdAt.toISOString(),
  };
}

export async function getDeliveryHealth(
  agentId: string,
  days = 7,
  now: Date = new Date(),
): Promise<DeliveryHealthSummary> {
  const from = new Date(now.getTime() - days * DAY_MS);
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.agentId, agentId), gte(webhookDeliveries.createdAt, from)))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(500);

  let successes = 0;
  let failures = 0;
  let latencySum = 0;
  let latencyCount = 0;
  const byEvent = new Map<string, { attempts: number; successes: number; failures: number }>();
  for (const row of rows) {
    const eventBucket = byEvent.get(row.event) ?? { attempts: 0, successes: 0, failures: 0 };
    eventBucket.attempts += 1;
    if (row.success === 1) {
      successes += 1;
      eventBucket.successes += 1;
    } else {
      failures += 1;
      eventBucket.failures += 1;
    }
    if (row.latencyMs != null) {
      latencySum += row.latencyMs;
      latencyCount += 1;
    }
    byEvent.set(row.event, eventBucket);
  }

  const recentFailures = rows.filter((r) => r.success === 0).slice(0, 25).map(attemptRowToJson);
  const recentSuccesses = rows.filter((r) => r.success === 1).slice(0, 25).map(attemptRowToJson);

  const [agent] = await db.select({ webhookUrl: agents.webhookUrl }).from(agents).where(eq(agents.id, agentId)).limit(1);

  return {
    agent_id: agentId,
    window: { from: from.toISOString(), to: now.toISOString() },
    totals: {
      attempts: rows.length,
      successes,
      failures,
      success_rate: rows.length === 0 ? null : successes / rows.length,
      avg_latency_ms: latencyCount === 0 ? null : Math.round(latencySum / latencyCount),
    },
    recent_failures: recentFailures,
    recent_successes: recentSuccesses,
    by_event: [...byEvent.entries()].map(([event, v]) => ({ event, ...v })).sort((a, b) => b.attempts - a.attempts),
    webhook_configured: Boolean(agent?.webhookUrl),
  };
}

export type ThreadTimelineEntry = {
  message_id: string;
  type: string;
  from: string;
  from_name: string | null;
  to: string;
  to_name: string | null;
  status: string;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  edited_at: string | null;
  attempts?: number;
  delivery_state: "queued" | "delivered" | "failed" | "skipped" | "unknown";
};

export type ThreadTimeline = {
  thread_id: string;
  participants: Array<{ agent_id: string; name: string | null }>;
  entries: ThreadTimelineEntry[];
  counts: { messages: number; delivered: number; failed: number; edited: number };
};

export async function getThreadTimeline(threadId: string): Promise<ThreadTimeline> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(messages.createdAt);

  const agentIds = [...new Set(rows.flatMap((m) => [m.fromAgent, m.toAgent]))];
  const agentRows = agentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
    : [];
  const nameMap = new Map(agentRows.map((a) => [a.id, a.name]));

  const messageIds = rows.map((r) => r.id);
  const deliveryRows = messageIds.length > 0
    ? await db
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.agentId, sql`${rows[0]?.toAgent ?? ""}`), inArray(webhookDeliveries.messageId, messageIds)))
    : [];
  const attemptsByMessage = new Map<string, number>();
  for (const d of deliveryRows) {
    if (!d.messageId) continue;
    attemptsByMessage.set(d.messageId, (attemptsByMessage.get(d.messageId) ?? 0) + 1);
  }

  const entries: ThreadTimelineEntry[] = rows.map((m) => {
    let deliveryState: ThreadTimelineEntry["delivery_state"] = "unknown";
    if (m.status === "delivered" || m.status === "processed" || m.status === "replied") {
      deliveryState = "delivered";
    } else if (m.status === "undelivered") {
      deliveryState = "failed";
    } else if (m.status === "scheduled") {
      deliveryState = "queued";
    } else if (m.status === "cancelled" || m.status === "deleted") {
      deliveryState = "skipped";
    }
    return {
      message_id: m.id,
      type: m.type,
      from: m.fromAgent,
      from_name: nameMap.get(m.fromAgent) ?? null,
      to: m.toAgent,
      to_name: nameMap.get(m.toAgent) ?? null,
      status: m.status,
      created_at: m.createdAt.toISOString(),
      delivered_at: m.deliveredAt ? m.deliveredAt.toISOString() : null,
      read_at: m.readAt ? m.readAt.toISOString() : null,
      replied_at: m.repliedAt ? m.repliedAt.toISOString() : null,
      edited_at: m.editedAt ? m.editedAt.toISOString() : null,
      attempts: attemptsByMessage.get(m.id) ?? 0,
      delivery_state: deliveryState,
    };
  });

  const participants: Array<{ agent_id: string; name: string | null }> = [];
  for (const a of agentRows) {
    participants.push({ agent_id: a.id, name: a.name });
  }

  return {
    thread_id: threadId,
    participants,
    entries,
    counts: {
      messages: entries.length,
      delivered: entries.filter((e) => e.delivery_state === "delivered").length,
      failed: entries.filter((e) => e.delivery_state === "failed").length,
      edited: entries.filter((e) => e.edited_at !== null).length,
    },
  };
}

export type TaskChangeEventRow = {
  task_id: string;
  scope: string;
  action: "created" | "updated" | "deleted" | "status_changed" | "assigned";
  from: string | null;
  to: string | null;
  actor_agent: string | null;
  reason: string | null;
  occurred_at: string;
  title: string | null;
};

export async function getTaskChanges(agentId: string, days = 7, now: Date = new Date()): Promise<TaskChangeEventRow[]> {
  const from = new Date(now.getTime() - days * DAY_MS);
  // Audit events filter to ones the agent can see (their own actions or
  // for tasks in their rooms). For now we pull their own actions.
  const auditRows = await db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "task"),
        or(eq(auditEvents.actorAgent, agentId), gte(auditEvents.createdAt, from)),
        gte(auditEvents.createdAt, from),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(100);

  const taskIds = [...new Set(auditRows.map((r) => r.targetId).filter((v): v is string => Boolean(v)))];
  const taskRows = taskIds.length > 0
    ? await db.select().from(tasks).where(inArray(tasks.id, taskIds))
    : [];
  const taskMap = new Map(taskRows.map((t) => [t.id, t]));

  const events: TaskChangeEventRow[] = [];
  for (const audit of auditRows) {
    if (!audit.targetId) continue;
    const task = taskMap.get(audit.targetId);
    const meta = audit.metadata as Record<string, unknown>;
    let action: TaskChangeEventRow["action"] = "updated";
    if (audit.action === "task.create") action = "created";
    else if (audit.action === "task.delete") action = "deleted";
    else if (typeof meta.status === "string") action = "status_changed";
    else if (typeof meta.owner === "string") action = "assigned";
    events.push({
      task_id: audit.targetId,
      scope: task?.scope ?? "unknown",
      action,
      from: typeof meta.from === "string" ? meta.from : null,
      to: typeof meta.to === "string" ? meta.to : null,
      actor_agent: audit.actorAgent,
      reason: typeof meta.reason === "string" ? meta.reason : null,
      occurred_at: audit.createdAt.toISOString(),
      title: task?.title ?? null,
    });
  }
  return events;
}

export type FactTouch = {
  key: string;
  scope: string;
  version: number;
  set_by: string;
  set_at: string;
  reason: string | null;
  source_message_id: string | null;
  source_thread_id: string | null;
};

export async function getFactTouches(agentId: string, days = 7, now: Date = new Date()): Promise<FactTouch[]> {
  const from = new Date(now.getTime() - days * DAY_MS);
  // Find the scopes this agent can see: contact scopes, their room scopes, their workspace.
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return [];

  const roomMemberships = await db.select().from(roomMembers).where(eq(roomMembers.agentId, agentId));
  const roomIds = roomMemberships.map((r) => r.roomId);

  const allowedPrefixes: string[] = ["contact:"];
  for (const id of roomIds) allowedPrefixes.push(`room:${id}`);
  if (agent.workspaceId) allowedPrefixes.push(`workspace:${agent.workspaceId}`);

  // Pull the agent's own fact writes (audited) plus any in the agent's accessible scopes.
  const ownHistory = await db
    .select()
    .from(factHistory)
    .where(and(eq(factHistory.setBy, agentId), gte(factHistory.setAt, from)))
    .orderBy(desc(factHistory.setAt))
    .limit(100);

  const inScopeHistory = allowedPrefixes.length > 0
    ? await db
        .select()
        .from(factHistory)
        .where(
          and(
            gte(factHistory.setAt, from),
            or(...allowedPrefixes.map((p) => sql`${factHistory.scope} LIKE ${p + "%"}`))!,
          ),
        )
        .orderBy(desc(factHistory.setAt))
        .limit(100)
    : [];

  const seen = new Set<string>();
  const merged: FactTouch[] = [];
  for (const row of [...ownHistory, ...inScopeHistory]) {
    const k = `${row.scope}:${row.key}:${row.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push({
      key: row.key,
      scope: row.scope,
      version: row.version,
      set_by: row.setBy,
      set_at: row.setAt.toISOString(),
      reason: row.reason,
      source_message_id: row.sourceMessageId,
      source_thread_id: row.sourceThreadId,
    });
  }
  return merged.slice(0, 50);
}

export type AuditEventRow = {
  id: string;
  actor_agent: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export async function getRecentAudits(agentId: string, days = 7, now: Date = new Date()): Promise<AuditEventRow[]> {
  const from = new Date(now.getTime() - days * DAY_MS);
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.actorAgent, agentId), gte(auditEvents.createdAt, from)))
    .orderBy(desc(auditEvents.createdAt))
    .limit(100);

  return rows.map((r) => ({
    id: r.id,
    actor_agent: r.actorAgent,
    action: r.action,
    target_type: r.targetType,
    target_id: r.targetId,
    metadata: r.metadata ?? {},
    created_at: r.createdAt.toISOString(),
  }));
}

export async function getRecentThreads(agentId: string, limit = 10) {
  const rows = await db
    .select({
      threadId: messages.threadId,
      messageId: messages.id,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId)))
    .orderBy(desc(messages.createdAt))
    .limit(500);

  const byThread = new Map<string, { last_activity: Date; message_count: number }>();
  for (const row of rows) {
    if (!row.threadId) continue;
    const existing = byThread.get(row.threadId);
    if (existing) {
      existing.message_count += 1;
    } else {
      byThread.set(row.threadId, { last_activity: row.createdAt, message_count: 1 });
    }
  }

  return [...byThread.entries()]
    .map(([thread_id, v]) => ({
      thread_id,
      last_activity: v.last_activity.toISOString(),
      message_count: v.message_count,
    }))
    .sort((a, b) => b.last_activity.localeCompare(a.last_activity))
    .slice(0, limit);
}

void lte;
void lt;
void rooms;
