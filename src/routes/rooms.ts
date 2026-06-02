import { Hono } from "hono";
import { db } from "../db/index.js";
import { rooms, roomMembers, agents } from "../db/schema.js";
import { and, eq, or } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { generatePairingCode } from "../lib/auth.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// Create a room
app.post("/", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ name: string; metadata?: Record<string, unknown> }>();

  if (!body.name) return c.json({ error: "name is required" }, 400);

  const pairingCode = generatePairingCode();

  const [room] = await db
    .insert(rooms)
    .values({ name: body.name, createdBy: agentId, pairingCode, metadata: body.metadata || {} })
    .returning();

  // Creator joins as creator
  await db.insert(roomMembers).values({ roomId: room.id, agentId, role: "creator" });

  return c.json({
    id: room.id,
    name: room.name,
    pairing_code: room.pairingCode,
    created_by: room.createdBy,
    created_at: room.createdAt,
  }, 201);
});

// Join a room via pairing code
app.post("/join", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ code: string }>();

  if (!body.code) return c.json({ error: "code is required" }, 400);

  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.pairingCode, body.code.toUpperCase()))
    .limit(1);

  if (!room) return c.json({ error: "Invalid room code" }, 404);

  // Check if already a member
  const existing = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.roomId, room.id))
    .limit(100);

  if (existing.some((m) => m.agentId === agentId)) {
    return c.json({ joined: true, already_member: true, room_id: room.id, name: room.name });
  }

  await db.insert(roomMembers).values({ roomId: room.id, agentId, role: "member" });

  return c.json({
    joined: true,
    room_id: room.id,
    name: room.name,
  });
});

// List rooms I'm in
app.get("/", async (c) => {
  const agentId = c.get("agentId");

  const memberships = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.agentId, agentId));

  if (memberships.length === 0) return c.json({ rooms: [] });

  const roomIds = memberships.map((m) => m.roomId);
  const roomRows = await db
    .select()
    .from(rooms)
    .where(or(...roomIds.map((id) => eq(rooms.id, id))));

  const result = roomRows.map((r) => {
    const membership = memberships.find((m) => m.roomId === r.id);
    return {
      id: r.id,
      name: r.name,
      pairing_code: r.pairingCode,
      role: membership?.role,
      created_at: r.createdAt,
    };
  });

  return c.json({ rooms: result });
});

// List members of a room
app.get("/:roomId/members", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  // Verify membership
  const myMembership = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId))
    .limit(100);

  if (!myMembership.some((m) => m.agentId === agentId)) {
    return c.json({ error: "Not a member of this room" }, 403);
  }

  const memberIds = myMembership.map((m) => m.agentId);
  const memberAgents = await db
    .select({ id: agents.id, name: agents.name, owner: agents.owner })
    .from(agents)
    .where(or(...memberIds.map((id) => eq(agents.id, id))));

  const result = memberAgents.map((a) => {
    const m = myMembership.find((m) => m.agentId === a.id);
    return { ...a, role: m?.role, joined_at: m?.joinedAt };
  });

  return c.json({ members: result });
});

// Update a room (creator/admin only)
app.patch("/:roomId", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const body = await c.req.json<{ name?: string; metadata?: Record<string, unknown> }>();

  if (!body.name && !body.metadata) {
    return c.json({ error: "name or metadata is required" }, 400);
  }

  // Verify creator/admin role
  const [membership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!membership) return c.json({ error: "Not a member of this room" }, 403);
  if (membership.role !== "creator" && membership.role !== "admin") {
    return c.json({ error: "Only creators and admins can update rooms" }, 403);
  }

  const updates: Record<string, unknown> = {};
  if (body.name) updates.name = body.name;
  if (body.metadata) updates.metadata = body.metadata;

  const [updated] = await db
    .update(rooms)
    .set(updates)
    .where(eq(rooms.id, roomId))
    .returning();

  return c.json({
    id: updated.id,
    name: updated.name,
    pairing_code: updated.pairingCode,
    metadata: updated.metadata,
    created_at: updated.createdAt,
  });
});

// Kick a member from a room (creator/admin only)
app.post("/:roomId/kick", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const body = await c.req.json<{ agent_id: string }>();

  if (!body.agent_id) return c.json({ error: "agent_id is required" }, 400);
  if (body.agent_id === agentId) return c.json({ error: "Cannot kick yourself" }, 400);

  // Verify caller is creator/admin
  const callerMembership = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId))
    .limit(100);

  const caller = callerMembership.find((m) => m.agentId === agentId);
  if (!caller) return c.json({ error: "Not a member of this room" }, 403);
  if (caller.role !== "creator" && caller.role !== "admin") {
    return c.json({ error: "Only creators and admins can kick members" }, 403);
  }

  const target = callerMembership.find((m) => m.agentId === body.agent_id);
  if (!target) return c.json({ error: "Target is not a member" }, 404);

  // Admins cannot kick creators or other admins
  if (caller.role === "admin" && (target.role === "creator" || target.role === "admin")) {
    return c.json({ error: "Admins cannot kick creators or other admins" }, 403);
  }

  await db
    .delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, body.agent_id)));

  return c.json({ ok: true, kicked: body.agent_id, room_id: roomId });
});

// Change a member's role (creator only)
app.put("/:roomId/members/:agentId/role", async (c) => {
  const callerId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const targetId = c.req.param("agentId");
  const body = await c.req.json<{ role: string }>();

  if (!body.role || !["admin", "member"].includes(body.role)) {
    return c.json({ error: "role must be 'admin' or 'member'" }, 400);
  }

  if (targetId === callerId) {
    return c.json({ error: "Cannot change your own role" }, 400);
  }

  // Verify caller is creator
  const [callerMembership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, callerId)))
    .limit(1);

  if (!callerMembership) return c.json({ error: "Not a member of this room" }, 403);
  if (callerMembership.role !== "creator") {
    return c.json({ error: "Only the creator can change roles" }, 403);
  }

  // Verify target is a member
  const [targetMembership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, targetId)))
    .limit(1);

  if (!targetMembership) return c.json({ error: "Target is not a member" }, 404);

  await db
    .update(roomMembers)
    .set({ role: body.role })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, targetId)));

  return c.json({ ok: true, agent_id: targetId, role: body.role, room_id: roomId });
});

// Delete a room (creator only)
app.delete("/:roomId", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  // Verify caller is creator
  const [membership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!membership) return c.json({ error: "Not a member of this room" }, 403);
  if (membership.role !== "creator") {
    return c.json({ error: "Only the creator can delete a room" }, 403);
  }

  // Delete all members first, then the room
  await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  await db.delete(rooms).where(eq(rooms.id, roomId));

  return c.json({ ok: true, deleted: roomId });
});

// Leave a room
app.post("/:roomId/leave", async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  // Verify membership
  const [membership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!membership) {
    return c.json({ error: "Not a member of this room" }, 403);
  }

  await db
    .delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)));

  return c.json({ ok: true, room_id: roomId });
});

export default app;
