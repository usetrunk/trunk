// Workspace identity groups for multi-agent teams
import { db } from "../db/index.js";
import { agents, contacts, workspaces, workspaceContacts, blockedContacts } from "../db/schema.js";
import { eq, or, and, inArray } from "drizzle-orm";

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
 * Check if the recipient has blocked the sender.
 */
export async function isBlocked(sender: string, recipient: string): Promise<boolean> {
  const [block] = await db
    .select()
    .from(blockedContacts)
    .where(and(eq(blockedContacts.agentId, recipient), eq(blockedContacts.blockedAgentId, sender)))
    .limit(1);
  return !!block;
}

/**
 * Batch-check which recipients have blocked the sender.
 * Returns a Set of recipient IDs that have blocked the sender.
 */
export async function getBlockedRecipients(sender: string, recipientIds: string[]): Promise<Set<string>> {
  if (recipientIds.length === 0) return new Set();
  const blocks = await db
    .select({ agentId: blockedContacts.agentId })
    .from(blockedContacts)
    .where(and(eq(blockedContacts.blockedAgentId, sender), inArray(blockedContacts.agentId, recipientIds)));
  return new Set(blocks.map((b) => b.agentId));
}

/**
 * Check if an agent can send to an entire workspace (fan-out).
 * True only if the agent is a workspace member or a workspace_contact.
 * Direct contacts with individual members do NOT grant workspace-level access.
 */
export async function canMessageWorkspace(agentId: string, workspaceId: string): Promise<boolean> {
  // Check if sender is a member of this workspace
  const [member] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  if (member) return true;

  // Check if sender is a workspace_contact (external agent paired with workspace)
  const [wc] = await db
    .select()
    .from(workspaceContacts)
    .where(and(eq(workspaceContacts.workspaceId, workspaceId), eq(workspaceContacts.agentId, agentId)))
    .limit(1);
  if (wc) return true;

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
