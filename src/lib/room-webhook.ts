import { db } from "../db/index.js";
import { roomWebhooks } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { signTrunkWebhook } from "./verify-webhook.js";

type TaskData = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  owner?: string | null;
  created_by: string;
  group?: string | null;
  scope: string;
};

/**
 * Fire room webhooks that match a newly created task's criteria.
 * Best-effort — failures are logged but don't block task creation.
 */
export async function fireRoomTaskWebhooks(roomId: string, task: TaskData): Promise<void> {
  const webhooks = await db
    .select()
    .from(roomWebhooks)
    .where(eq(roomWebhooks.roomId, roomId))
    .limit(20);

  const matching = webhooks.filter((w) => {
    if (w.active !== 1) return false;
    if (w.filterGroup && w.filterGroup !== task.group) return false;
    if (w.filterPriority && w.filterPriority !== task.priority) return false;
    if (w.filterStatus && w.filterStatus !== task.status) return false;
    return true;
  });

  if (matching.length === 0) return;

  const payload = {
    event: "task.created",
    room_id: roomId,
    task,
  };

  await Promise.allSettled(
    matching.map(async (w) => {
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Trunk-Event": "task.created",
      };

      if (w.secret) {
        headers["X-Trunk-Signature"] = await signTrunkWebhook(body, w.secret);
      }

      try {
        await fetch(w.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        // Best-effort — don't fail task creation
      }
    })
  );
}
