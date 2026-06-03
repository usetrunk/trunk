import { and, eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { contacts, sharedFacts, roomMembers } from "../db/schema.js";
import { canMessage, verifyWorkspaceAccess } from "./workspace.js";

export function contactScope(a: string, b: string): string {
  return `contact:${[a, b].sort().join("-")}`;
}

/**
 * Resolve a scopeId to a fully-qualified scope string by trying
 * contact, room, and workspace access in order.
 * Returns the scope string or undefined if the agent has no access.
 */
export async function resolveScopeAccess(
  agentId: string,
  scopeId: string
): Promise<string | undefined> {
  const hasContactAccess = await canMessage(agentId, scopeId);
  if (hasContactAccess) return contactScope(agentId, scopeId);

  const hasRoomAccess = await verifyRoomAccess(agentId, scopeId);
  if (hasRoomAccess) return `room:${scopeId}`;

  const hasWsAccess = await verifyWorkspaceAccess(agentId, scopeId);
  if (hasWsAccess) return `workspace:${scopeId}`;

  return undefined;
}

export function roomScope(roomId: string): string {
  return `room:${roomId}`;
}

export function workspaceScope(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export async function verifyRoomAccess(agentId: string, roomId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);
  return rows.length > 0;
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
        .set({ value, version: (existing[0].version ?? 1) + 1, updatedBy: actorAgent, updatedAt: new Date() })
        .where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)));
    } else {
      await db.insert(sharedFacts).values({ scope, key, value, updatedBy: actorAgent });
    }
  }
}

export function isValidFactKey(key: string): boolean {
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(key);
}
