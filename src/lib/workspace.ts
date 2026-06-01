import { db } from "../db/index.js";
import { agents, contacts, workspaces, workspaceContacts } from "../db/schema.js";
import { eq, or, and } from "drizzle-orm";

/**
 * Check if agentA can message agentB.
 * True if:
 * 1. Same agent (self-messaging)
 * 2. Direct contact exists
 * 3. Same workspace members
 * 4. One has a workspace_contacts entry linking to the other's workspace
 */
export async function canMessage(agentA: string, agentB: string): Promise<boolean> {
  if (agentA === agentB) return true;

  // Direct contact check
  const directContact = await db
    .select()
    .from(contacts)
    .where(
      or(
        and(eq(contacts.agentA, agentA), eq(contacts.agentB, agentB)),
        and(eq(contacts.agentA, agentB), eq(contacts.agentB, agentA))
      )
    )
    .limit(1);

  if (directContact.length > 0) return true;

  // Load both agents to check workspace membership
  const [a] = await db.select().from(agents).where(eq(agents.id, agentA)).limit(1);
  const [b] = await db.select().from(agents).where(eq(agents.id, agentB)).limit(1);
  if (!a || !b) return false;

  // Same workspace
  if (a.workspaceId && a.workspaceId === b.workspaceId) return true;

  // agentA's workspace has a workspace_contact with agentB
  if (a.workspaceId) {
    const [wc] = await db
      .select()
      .from(workspaceContacts)
      .where(and(eq(workspaceContacts.workspaceId, a.workspaceId), eq(workspaceContacts.agentId, agentB)))
      .limit(1);
    if (wc) return true;
  }

  // agentB's workspace has a workspace_contact with agentA
  if (b.workspaceId) {
    const [wc] = await db
      .select()
      .from(workspaceContacts)
      .where(and(eq(workspaceContacts.workspaceId, b.workspaceId), eq(workspaceContacts.agentId, agentA)))
      .limit(1);
    if (wc) return true;
  }

  return false;
}

/**
 * Get all agent IDs that are members of a workspace.
 */
export async function getWorkspaceMembers(workspaceId: string): Promise<string[]> {
  const members = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
  return members.map((m) => m.id);
}

/**
 * Verify an agent is a member of a workspace.
 */
export async function verifyWorkspaceAccess(agentId: string, workspaceId: string): Promise<boolean> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  return !!agent;
}
