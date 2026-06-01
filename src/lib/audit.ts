import { db } from "../db/index.js";
import { auditEvents } from "../db/schema.js";

export async function audit(
  actorAgent: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await db.insert(auditEvents).values({
    actorAgent: actorAgent ?? undefined,
    action,
    targetType,
    targetId: targetId ?? undefined,
    metadata,
  });
}
