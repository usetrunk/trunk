import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, contacts, workspaces, workspaceContacts, blockedContacts, contactNotes, notificationPreferences } from "../db/schema.js";
import { eq, or, and } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// Pair with another agent or workspace via pairing code
app.post("/pair", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ code: string; alias?: string }>();

  if (!body.code) {
    return c.json({ error: "code is required" }, 400);
  }

  const code = body.code.toUpperCase();

  // Try agent pairing code first
  const [target] = await db
    .select()
    .from(agents)
    .where(eq(agents.pairingCode, code))
    .limit(1);

  if (target) {
    if (target.id === agentId) {
      return c.json({ error: "Cannot pair with yourself" }, 400);
    }

    // Check if already paired (in either direction)
    const existing = await db
      .select()
      .from(contacts)
      .where(
        or(
          and(eq(contacts.agentA, agentId), eq(contacts.agentB, target.id)),
          and(eq(contacts.agentA, target.id), eq(contacts.agentB, agentId))
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return c.json({ error: "Already paired" }, 409);
    }

    await db.insert(contacts).values({
      agentA: agentId,
      agentB: target.id,
      aliasA: body.alias,
    });
    await audit(agentId, "contact.pair", "agent", target.id, { alias: body.alias });

    return c.json({
      contact_id: target.id,
      name: target.name,
      contact_type: "agent",
      paired_at: new Date().toISOString(),
    }, 201);
  }

  // Try workspace pairing code
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.pairingCode, code))
    .limit(1);

  if (!workspace) {
    return c.json({ error: "Invalid pairing code" }, 404);
  }

  // Don't allow workspace members to pair with their own workspace
  const [callerAgent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (callerAgent?.workspaceId === workspace.id) {
    return c.json({ error: "Cannot pair with your own workspace" }, 400);
  }

  // Check if already paired with this workspace
  const existingWc = await db
    .select()
    .from(workspaceContacts)
    .where(and(eq(workspaceContacts.workspaceId, workspace.id), eq(workspaceContacts.agentId, agentId)))
    .limit(1);

  if (existingWc.length > 0) {
    return c.json({ error: "Already paired with this workspace" }, 409);
  }

  await db.insert(workspaceContacts).values({
    workspaceId: workspace.id,
    agentId,
    alias: body.alias,
  });
  await audit(agentId, "contact.pair_workspace", "workspace", workspace.id, { alias: body.alias });

  // Get workspace members to return
  const members = await db
    .select({ id: agents.id, name: agents.name, owner: agents.owner })
    .from(agents)
    .where(eq(agents.workspaceId, workspace.id));

  return c.json({
    workspace_id: workspace.id,
    workspace_name: workspace.name,
    contact_type: "workspace",
    members: members.map((m) => ({ agent_id: m.id, name: m.name, owner: m.owner })),
    paired_at: new Date().toISOString(),
  }, 201);
});

// List contacts (direct + workspace-derived)
app.get("/", async (c) => {
  const agentId = c.get("agentId");

  // Direct contacts
  const rows = await db
    .select()
    .from(contacts)
    .where(or(eq(contacts.agentA, agentId), eq(contacts.agentB, agentId)));

  const directIds = rows.map((r) =>
    r.agentA === agentId ? r.agentB : r.agentA
  );

  const result: Array<{
    agent_id: string;
    name: string;
    owner?: string | null;
    paired_at?: Date;
    via_workspace?: string;
  }> = [];
  const seenIds = new Set<string>();

  // Resolve direct contacts
  if (directIds.length > 0) {
    const contactAgents = await db
      .select({ id: agents.id, name: agents.name, owner: agents.owner })
      .from(agents)
      .where(or(...directIds.map((id) => eq(agents.id, id))));

    for (const a of contactAgents) {
      const row = rows.find((r) => r.agentA === a.id || r.agentB === a.id);
      result.push({
        agent_id: a.id,
        name: a.name,
        owner: a.owner,
        paired_at: row?.pairedAt,
      });
      seenIds.add(a.id);
    }
  }

  // Workspace contacts: workspaces I'm paired with (as external agent)
  const myWorkspacePairings = await db
    .select()
    .from(workspaceContacts)
    .where(eq(workspaceContacts.agentId, agentId));

  for (const wc of myWorkspacePairings) {
    const members = await db
      .select({ id: agents.id, name: agents.name, owner: agents.owner })
      .from(agents)
      .where(eq(agents.workspaceId, wc.workspaceId));

    for (const m of members) {
      if (!seenIds.has(m.id) && m.id !== agentId) {
        result.push({
          agent_id: m.id,
          name: m.name,
          owner: m.owner,
          paired_at: wc.pairedAt,
          via_workspace: wc.workspaceId,
        });
        seenIds.add(m.id);
      }
    }
  }

  // Workspace contacts: agents paired with my workspace
  const [callerAgent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (callerAgent?.workspaceId) {
    const externalPairings = await db
      .select()
      .from(workspaceContacts)
      .where(eq(workspaceContacts.workspaceId, callerAgent.workspaceId));

    for (const wc of externalPairings) {
      if (!seenIds.has(wc.agentId) && wc.agentId !== agentId) {
        const [extAgent] = await db
          .select({ id: agents.id, name: agents.name, owner: agents.owner })
          .from(agents)
          .where(eq(agents.id, wc.agentId))
          .limit(1);
        if (extAgent) {
          result.push({
            agent_id: extAgent.id,
            name: extAgent.name,
            owner: extAgent.owner,
            paired_at: wc.pairedAt,
            via_workspace: callerAgent.workspaceId,
          });
          seenIds.add(extAgent.id);
        }
      }
    }

    // Same-workspace members
    const coworkers = await db
      .select({ id: agents.id, name: agents.name, owner: agents.owner })
      .from(agents)
      .where(eq(agents.workspaceId, callerAgent.workspaceId));

    for (const cw of coworkers) {
      if (!seenIds.has(cw.id) && cw.id !== agentId) {
        result.push({
          agent_id: cw.id,
          name: cw.name,
          owner: cw.owner,
          via_workspace: callerAgent.workspaceId,
        });
        seenIds.add(cw.id);
      }
    }
  }

  return c.json({ contacts: result });
});

// List blocked agents
app.get("/blocked", async (c) => {
  const myId = c.get("agentId");

  const rows = await db
    .select()
    .from(blockedContacts)
    .where(eq(blockedContacts.agentId, myId));

  const agentIds = rows.map((r) => r.blockedAgentId);
  const agentRows = agentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(or(...agentIds.map((id) => eq(agents.id, id))))
    : [];
  const nameMap = new Map(agentRows.map((a) => [a.id, a.name]));

  return c.json({
    blocked: rows.map((r) => ({
      agent_id: r.blockedAgentId,
      name: nameMap.get(r.blockedAgentId) ?? null,
      reason: r.reason,
      blocked_at: r.createdAt,
    })),
    count: rows.length,
  });
});

// Update contact alias
app.patch("/:agentId", async (c) => {
  const myId = c.get("agentId");
  const targetId = c.req.param("agentId");
  const body = await c.req.json<{ alias: string | null }>();

  if (body.alias === undefined) {
    return c.json({ error: "alias is required" }, 400);
  }

  // Find the contact row in either direction
  const [row] = await db
    .select()
    .from(contacts)
    .where(
      or(
        and(eq(contacts.agentA, myId), eq(contacts.agentB, targetId)),
        and(eq(contacts.agentA, targetId), eq(contacts.agentB, myId))
      )
    )
    .limit(1);

  if (!row) return c.json({ error: "Not a contact" }, 404);

  // Update the alias for whichever side I am
  if (row.agentA === myId) {
    await db.update(contacts).set({ aliasA: body.alias }).where(
      and(eq(contacts.agentA, myId), eq(contacts.agentB, targetId))
    );
  } else {
    await db.update(contacts).set({ aliasB: body.alias }).where(
      and(eq(contacts.agentA, targetId), eq(contacts.agentB, myId))
    );
  }

  await audit(myId, "contact.update_alias", "agent", targetId, { alias: body.alias });
  return c.json({ ok: true, alias: body.alias });
});

// Unpair
app.delete("/:agentId", async (c) => {
  const myId = c.get("agentId");
  const targetId = c.req.param("agentId");

  await db
    .delete(contacts)
    .where(
      or(
        and(eq(contacts.agentA, myId), eq(contacts.agentB, targetId)),
        and(eq(contacts.agentA, targetId), eq(contacts.agentB, myId))
      )
    );
  await audit(myId, "contact.unpair", "agent", targetId);

  return c.json({ ok: true });
});

// Block an agent
app.post("/:agentId/block", async (c) => {
  const myId = c.get("agentId");
  const targetId = c.req.param("agentId");
  if (myId === targetId) return c.json({ error: "Cannot block yourself" }, 400);

  const body = await c.req.json<{ reason?: string }>().catch(() => ({}));

  // Check if already blocked
  const existing = await db
    .select()
    .from(blockedContacts)
    .where(and(eq(blockedContacts.agentId, myId), eq(blockedContacts.blockedAgentId, targetId)));
  if (existing.length > 0) {
    return c.json({ ok: true, already_blocked: true, blocked_at: existing[0].createdAt });
  }

  const [row] = await db.insert(blockedContacts).values({
    agentId: myId,
    blockedAgentId: targetId,
    reason: body.reason ?? null,
  }).returning();
  await audit(myId, "contact.block", "agent", targetId, { reason: body.reason });
  return c.json({ ok: true, id: row.id, blocked_at: row.createdAt }, 201);
});

// Unblock an agent
app.delete("/:agentId/block", async (c) => {
  const myId = c.get("agentId");
  const targetId = c.req.param("agentId");

  const deleted = await db
    .delete(blockedContacts)
    .where(and(eq(blockedContacts.agentId, myId), eq(blockedContacts.blockedAgentId, targetId)))
    .returning();
  if (deleted.length === 0) return c.json({ error: "Not blocked" }, 404);
  await audit(myId, "contact.unblock", "agent", targetId);
  return c.json({ ok: true });
});

// Add or update a private note about a contact
app.put("/:agentId/notes", async (c) => {
  const myId = c.get("agentId");
  const targetId = c.req.param("agentId");
  const body = await c.req.json<{ content: string }>();
  if (!body.content || typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  // Check for existing note
  const existing = await db
    .select()
    .from(contactNotes)
    .where(and(eq(contactNotes.agentId, myId), eq(contactNotes.contactAgentId, targetId)));

  if (existing.length > 0) {
    const [updated] = await db
      .update(contactNotes)
      .set({ content: body.content, updatedAt: new Date() })
      .where(and(eq(contactNotes.agentId, myId), eq(contactNotes.contactAgentId, targetId)))
      .returning();
    await audit(myId, "contact.note_update", "agent", targetId);
    return c.json({ id: updated.id, contact_id: targetId, content: updated.content, updated_at: updated.updatedAt });
  }

  const [row] = await db.insert(contactNotes).values({
    agentId: myId,
    contactAgentId: targetId,
    content: body.content,
  }).returning();
  await audit(myId, "contact.note_create", "agent", targetId);
  return c.json({ id: row.id, contact_id: targetId, content: row.content, created_at: row.createdAt }, 201);
});

// Get note about a contact
app.get("/:agentId/notes", async (c) => {
  const myId = c.get("agentId");
  const targetId = c.req.param("agentId");

  const [note] = await db
    .select()
    .from(contactNotes)
    .where(and(eq(contactNotes.agentId, myId), eq(contactNotes.contactAgentId, targetId)));

  if (!note) return c.json({ contact_id: targetId, content: null });
  return c.json({ id: note.id, contact_id: targetId, content: note.content, created_at: note.createdAt, updated_at: note.updatedAt });
});

// Delete note about a contact
app.delete("/:agentId/notes", async (c) => {
  const myId = c.get("agentId");
  const targetId = c.req.param("agentId");

  const deleted = await db
    .delete(contactNotes)
    .where(and(eq(contactNotes.agentId, myId), eq(contactNotes.contactAgentId, targetId)))
    .returning();
  if (deleted.length === 0) return c.json({ error: "No note found" }, 404);
  await audit(myId, "contact.note_delete", "agent", targetId);
  return c.json({ ok: true });
});

// --- Notification preferences ---

// Get notification preferences for a contact
app.get("/:id/notifications", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("id");

  const [pref] = await db
    .select()
    .from(notificationPreferences)
    .where(and(
      eq(notificationPreferences.agentId, agentId),
      eq(notificationPreferences.contactAgentId, contactId)
    ))
    .limit(1);

  if (!pref) {
    return c.json({ muted: false, urgency_filter: "all" });
  }

  return c.json({
    muted: pref.muted === 1,
    urgency_filter: pref.urgencyFilter,
    updated_at: pref.updatedAt,
  });
});

// Set notification preferences for a contact
app.put("/:id/notifications", async (c) => {
  const agentId = c.get("agentId");
  const contactId = c.req.param("id");
  const body = await c.req.json<{
    muted?: boolean;
    urgency_filter?: string;
  }>();

  if (body.urgency_filter && !["all", "sync_only"].includes(body.urgency_filter)) {
    return c.json({ error: "urgency_filter must be 'all' or 'sync_only'" }, 400);
  }

  const [existing] = await db
    .select()
    .from(notificationPreferences)
    .where(and(
      eq(notificationPreferences.agentId, agentId),
      eq(notificationPreferences.contactAgentId, contactId)
    ))
    .limit(1);

  if (existing) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.muted !== undefined) updates.muted = body.muted ? 1 : 0;
    if (body.urgency_filter) updates.urgencyFilter = body.urgency_filter;

    await db
      .update(notificationPreferences)
      .set(updates)
      .where(eq(notificationPreferences.id, existing.id));

    await audit(agentId, "contact.notification_prefs_update", "agent", contactId);
    return c.json({
      muted: body.muted !== undefined ? body.muted : existing.muted === 1,
      urgency_filter: body.urgency_filter ?? existing.urgencyFilter,
      updated_at: new Date(),
    });
  }

  const [pref] = await db
    .insert(notificationPreferences)
    .values({
      agentId,
      contactAgentId: contactId,
      muted: body.muted ? 1 : 0,
      urgencyFilter: body.urgency_filter ?? "all",
    })
    .returning();

  await audit(agentId, "contact.notification_prefs_set", "agent", contactId);
  return c.json({
    muted: pref.muted === 1,
    urgency_filter: pref.urgencyFilter,
    updated_at: pref.updatedAt,
  });
});

export default app;
