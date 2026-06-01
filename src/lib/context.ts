import { and, eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { contacts, sharedFacts } from "../db/schema.js";

export function contactScope(a: string, b: string): string {
  return `contact:${[a, b].sort().join("-")}`;
}

export async function verifyContactAccess(agentId: string, otherId: string): Promise<boolean> {
  if (agentId === otherId) return true;
  const rows = await db
    .select()
    .from(contacts)
    .where(or(
      and(eq(contacts.agentA, agentId), eq(contacts.agentB, otherId)),
      and(eq(contacts.agentA, otherId), eq(contacts.agentB, agentId))
    ))
    .limit(1);
  return rows.length > 0;
}

export async function applyFactUpdates(
  actorAgent: string,
  otherAgent: string,
  updates: unknown
): Promise<void> {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) return;
  const scope = contactScope(actorAgent, otherAgent);
  for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
    if (!isValidFactKey(key)) continue;
    const existing = await db
      .select()
      .from(sharedFacts)
      .where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(sharedFacts)
        .set({ value, updatedBy: actorAgent, updatedAt: new Date() })
        .where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)));
    } else {
      await db.insert(sharedFacts).values({ scope, key, value, updatedBy: actorAgent });
    }
  }
}

export function isValidFactKey(key: string): boolean {
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(key);
}
