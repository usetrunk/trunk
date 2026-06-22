import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents, messages, roomMembers } from "../db/schema.js";
import { audit } from "./audit.js";
import { deliverWebhook } from "./webhook.js";
import { checkRateLimit } from "./rate-limit.js";

const HEARTBEAT_COOLDOWN_MS = 30 * 60 * 1000;
const ACTIVE_ROOM_WINDOW_MS = 30 * 60 * 1000;

export const COORDINATION_HEARTBEAT =
  "Coordination check: before continuing, check whether anyone is waiting on you, update stale tasks, and tell the room your next action. If another agent would benefit from context, send it. If you see a weak assumption, challenge it constructively. If coordination is unclear, improve the working agreement directly with the other agents.";

export type RoomHeartbeatRunResponse = {
  checked: number;
  sent: number;
  skipped: Array<{ room_id: string; reason: "inactive" | "cooldown" | "no_members" }>;
  heartbeats: Array<{
    room_id: string;
    thread_id: string | null;
    recipients: number;
    message_ids: string[];
  }>;
};

export async function runRoomHeartbeats(agentId: string): Promise<RoomHeartbeatRunResponse> {
  const now = new Date();
  const activeSince = new Date(now.getTime() - ACTIVE_ROOM_WINDOW_MS);
  const cooldownSince = new Date(now.getTime() - HEARTBEAT_COOLDOWN_MS);

  const memberships = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.agentId, agentId))
    .limit(100);

  if (memberships.length === 0) {
    return { checked: 0, sent: 0, skipped: [], heartbeats: [] };
  }

  const roomIds = memberships.map((m) => m.roomId);
  const heartbeats: RoomHeartbeatRunResponse["heartbeats"] = [];
  const skipped: RoomHeartbeatRunResponse["skipped"] = [];

  for (const roomId of roomIds) {
    const [recentActivity] = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.toRoom, roomId),
        ne(messages.type, "coordination_heartbeat"),
        gte(messages.createdAt, activeSince),
      ))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    if (!recentActivity) {
      skipped.push({ room_id: roomId, reason: "inactive" });
      continue;
    }

    const [recentHeartbeat] = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.toRoom, roomId),
        eq(messages.type, "coordination_heartbeat"),
        gte(messages.createdAt, cooldownSince),
      ))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    if (recentHeartbeat) {
      skipped.push({ room_id: roomId, reason: "cooldown" });
      continue;
    }

    if (!(await acquireRoomHeartbeatLease(roomId, now))) {
      skipped.push({ room_id: roomId, reason: "cooldown" });
      continue;
    }

    const roomHeartbeats = await emitRoomHeartbeat(agentId, roomId, now);
    if (roomHeartbeats.length === 0) {
      skipped.push({ room_id: roomId, reason: "no_members" });
      continue;
    }

    heartbeats.push({
      room_id: roomId,
      thread_id: roomHeartbeats[0].threadId,
      recipients: roomHeartbeats.length,
      message_ids: roomHeartbeats.map((m) => m.id),
    });
  }

  await audit(agentId, "room.heartbeat_run", "room", null, {
    checked: roomIds.length,
    sent: heartbeats.length,
    skipped: skipped.length,
  });

  return { checked: roomIds.length, sent: heartbeats.length, skipped, heartbeats };
}

async function acquireRoomHeartbeatLease(roomId: string, now: Date): Promise<boolean> {
  const fallbackLease = async () => {
    const lease = await checkRateLimit(`room-heartbeat:${roomId}`, 1, HEARTBEAT_COOLDOWN_MS);
    return lease.ok;
  };

  const dbWithExecute = db as unknown as {
    execute?: (query: ReturnType<typeof sql>) => Promise<unknown>;
  };

  if (!dbWithExecute.execute) return fallbackLease();

  const cutoff = new Date(now.getTime() - HEARTBEAT_COOLDOWN_MS);
  const result = await dbWithExecute.execute(sql`
    insert into rate_limits (scope, count, window_start, updated_at)
    values (${`room-heartbeat:${roomId}`}, 1, ${now}, ${now})
    on conflict (scope) do update
      set count = 1,
          window_start = excluded.window_start,
          updated_at = excluded.updated_at
      where rate_limits.window_start <= ${cutoff}
    returning scope
  `);

  if (Array.isArray(result)) return result.length > 0;
  if (result && typeof result === "object" && "rowCount" in result) {
    return Number((result as { rowCount: number }).rowCount) > 0;
  }
  return false;
}

async function emitRoomHeartbeat(agentId: string, roomId: string, now: Date) {
  const members = await db
    .select({ agentId: roomMembers.agentId })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId))
    .limit(500);

  const memberIds = members.map((m) => m.agentId);
  if (memberIds.length === 0) return [];

  const memberAgents = await db.select().from(agents).where(inArray(agents.id, memberIds));
  const agentMap = new Map(memberAgents.map((a) => [a.id, a]));
  const threadId = crypto.randomUUID();
  const created: Array<typeof messages.$inferSelect> = [];

  for (const recipientId of memberIds) {
    const [message] = await db
      .insert(messages)
      .values({
        fromAgent: agentId,
        toAgent: recipientId,
        toRoom: roomId,
        threadId,
        type: "coordination_heartbeat",
        payload: {
          content: COORDINATION_HEARTBEAT,
          source: "trunk",
          finality: "fyi",
          requires_reply: false,
          reason: "active_room_interval",
        },
        status: "delivered",
        deliveredAt: now,
      })
      .returning();

    const recipient = agentMap.get(recipientId);
    if (recipient?.webhookUrl) {
      deliverWebhook(message, recipient).catch(() => {});
    }
    created.push(message);
  }

  await audit(agentId, "room.coordination_heartbeat", "room", roomId, {
    thread_id: threadId,
    recipient_count: created.length,
  });

  return created;
}
