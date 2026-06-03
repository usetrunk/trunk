import { Hono } from "hono";
import { db } from "../db/index.js";
import { rooms, roomMembers, agents, messages } from "../db/schema.js";
import { and, eq, or } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { generatePairingCode } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { isValidUUID, requireValidUUIDs } from "../lib/errors.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// Create a room
app.post("/", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`rooms:create:${agentId}`, 20, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{ name: string; metadata?: Record<string, unknown> }>();

  if (!body.name) return c.json({ error: "name is required", code: "MISSING_FIELD" }, 400);
  if (body.name.length > 100) return c.json({ error: "name must be 100 characters or fewer", code: "INVALID_FIELD" }, 400);
  if (body.metadata && JSON.stringify(body.metadata).length > 10000) {
    return c.json({ error: "metadata must not exceed 10KB", code: "INVALID_FIELD" }, 400);
  }

  const pairingCode = generatePairingCode();

  const [room] = await db
    .insert(rooms)
    .values({ name: body.name, createdBy: agentId, pairingCode, metadata: body.metadata || {} })
    .returning();

  // Creator joins as creator
  await db.insert(roomMembers).values({ roomId: room.id, agentId, role: "creator" });

  await audit(agentId, "room.created", "room", room.id, { name: room.name });

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

  const rateLimit = await checkRateLimit(`join:${agentId}`, 20, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{ code: string }>();

  if (!body.code || typeof body.code !== "string") return c.json({ error: "code is required", code: "MISSING_FIELD" }, 400);
  if (body.code.length > 20) return c.json({ error: "Invalid code format", code: "INVALID_INPUT" }, 400);

  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.pairingCode, body.code.toUpperCase()))
    .limit(1);

  if (!room) return c.json({ error: "Invalid room code", code: "ROOM_NOT_FOUND" }, 404);

  // Check if already a member
  const [existing] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (existing) {
    return c.json({ joined: true, already_member: true, room_id: room.id, name: room.name });
  }

  await db.insert(roomMembers).values({ roomId: room.id, agentId, role: "member" });

  await audit(agentId, "room.joined", "room", room.id, { name: room.name });

  return c.json({
    joined: true,
    room_id: room.id,
    name: room.name,
  });
});

// List rooms I'm in
app.get("/", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const memberships = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.agentId, agentId))
    .limit(100);

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
app.get("/:roomId/members", requireValidUUIDs("roomId"), async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const roomId = c.req.param("roomId");

  // Verify caller is a member
  const [myMembership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!myMembership) {
    return c.json({ error: "Not a member of this room", code: "NOT_MEMBER" }, 403);
  }

  // Fetch all members separately (with limit)
  const allMembers = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId))
    .limit(500);

  const memberIds = allMembers.map((m) => m.agentId);
  const memberAgents = await db
    .select({ id: agents.id, name: agents.name, owner: agents.owner })
    .from(agents)
    .where(or(...memberIds.map((id) => eq(agents.id, id))));

  const result = memberAgents.map((a) => {
    const m = allMembers.find((m) => m.agentId === a.id);
    return { ...a, role: m?.role, joined_at: m?.joinedAt };
  });

  return c.json({ members: result });
});

// Update a room (creator/admin only)
app.patch("/:roomId", requireValidUUIDs("roomId"), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  const rateLimit = await checkRateLimit(`rooms:write:${agentId}`, 20, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{ name?: string; metadata?: Record<string, unknown> }>();

  if (!body.name && !body.metadata) {
    return c.json({ error: "name or metadata is required", code: "MISSING_FIELD" }, 400);
  }
  if (body.name && body.name.length > 100) {
    return c.json({ error: "name must be 100 characters or fewer", code: "INVALID_FIELD" }, 400);
  }
  if (body.metadata && JSON.stringify(body.metadata).length > 10000) {
    return c.json({ error: "metadata must not exceed 10KB", code: "INVALID_FIELD" }, 400);
  }

  // Verify creator/admin role
  const [membership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!membership) return c.json({ error: "Not a member of this room", code: "NOT_MEMBER" }, 403);
  if (membership.role !== "creator" && membership.role !== "admin") {
    return c.json({ error: "Only creators and admins can update rooms", code: "INSUFFICIENT_ROLE" }, 403);
  }

  const updates: Record<string, unknown> = {};
  if (body.name) updates.name = body.name;
  if (body.metadata) updates.metadata = body.metadata;

  const [updated] = await db
    .update(rooms)
    .set(updates)
    .where(eq(rooms.id, roomId))
    .returning();

  await audit(agentId, "room.updated", "room", roomId, { name: body.name, metadata_changed: !!body.metadata });

  return c.json({
    id: updated.id,
    name: updated.name,
    pairing_code: updated.pairingCode,
    metadata: updated.metadata,
    created_at: updated.createdAt,
  });
});

// Kick a member from a room (creator/admin only)
app.post("/:roomId/kick", requireValidUUIDs("roomId"), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  const rateLimit = await checkRateLimit(`rooms:write:${agentId}`, 20, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{ agent_id: string }>();

  if (!body.agent_id) return c.json({ error: "agent_id is required", code: "MISSING_FIELD" }, 400);
  if (!isValidUUID(body.agent_id)) return c.json({ error: "Invalid agent_id format", code: "INVALID_INPUT" }, 400);
  if (body.agent_id === agentId) return c.json({ error: "Cannot kick yourself", code: "SELF_ACTION" }, 400);

  // Verify caller is creator/admin
  const [caller] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!caller) return c.json({ error: "Not a member of this room", code: "NOT_MEMBER" }, 403);
  if (caller.role !== "creator" && caller.role !== "admin") {
    return c.json({ error: "Only creators and admins can kick members", code: "INSUFFICIENT_ROLE" }, 403);
  }

  // Look up target membership specifically
  const [target] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, body.agent_id)))
    .limit(1);

  if (!target) return c.json({ error: "Target is not a member", code: "NOT_FOUND" }, 404);

  // Admins cannot kick creators or other admins
  if (caller.role === "admin" && (target.role === "creator" || target.role === "admin")) {
    return c.json({ error: "Admins cannot kick creators or other admins", code: "INSUFFICIENT_ROLE" }, 403);
  }

  await db
    .delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, body.agent_id)));

  await audit(agentId, "room.member_kicked", "room", roomId, { kicked_agent: body.agent_id });

  return c.json({ ok: true, kicked: body.agent_id, room_id: roomId });
});

// Change a member's role (creator only)
app.put("/:roomId/members/:agentId/role", requireValidUUIDs("roomId", "agentId"), async (c) => {
  const callerId = c.get("agentId");
  const roomId = c.req.param("roomId");
  const targetId = c.req.param("agentId");

  const rateLimit = await checkRateLimit(`rooms:write:${callerId}`, 20, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{ role: string }>();

  if (!body.role || !["admin", "member"].includes(body.role)) {
    return c.json({ error: "role must be 'admin' or 'member'", code: "INVALID_INPUT" }, 400);
  }

  if (targetId === callerId) {
    return c.json({ error: "Cannot change your own role", code: "SELF_ACTION" }, 400);
  }

  // Verify caller is creator
  const [callerMembership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, callerId)))
    .limit(1);

  if (!callerMembership) return c.json({ error: "Not a member of this room", code: "NOT_MEMBER" }, 403);
  if (callerMembership.role !== "creator") {
    return c.json({ error: "Only the creator can change roles", code: "INSUFFICIENT_ROLE" }, 403);
  }

  // Verify target is a member
  const [targetMembership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, targetId)))
    .limit(1);

  if (!targetMembership) return c.json({ error: "Target is not a member", code: "NOT_FOUND" }, 404);

  await db
    .update(roomMembers)
    .set({ role: body.role })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, targetId)));

  await audit(callerId, "room.role_changed", "room", roomId, { target_agent: targetId, new_role: body.role });

  return c.json({ ok: true, agent_id: targetId, role: body.role, room_id: roomId });
});

// Delete a room (creator only)
app.delete("/:roomId", requireValidUUIDs("roomId"), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  const rateLimit = await checkRateLimit(`rooms:write:${agentId}`, 20, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  // Verify caller is creator
  const [membership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!membership) return c.json({ error: "Not a member of this room", code: "NOT_MEMBER" }, 403);
  if (membership.role !== "creator") {
    return c.json({ error: "Only the creator can delete a room", code: "INSUFFICIENT_ROLE" }, 403);
  }

  // Delete messages, members, then the room
  await db.delete(messages).where(eq(messages.toRoom, roomId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  await db.delete(rooms).where(eq(rooms.id, roomId));

  await audit(agentId, "room.deleted", "room", roomId, {});

  return c.json({ ok: true, deleted: roomId });
});

// Leave a room
app.post("/:roomId/leave", requireValidUUIDs("roomId"), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  const rateLimit = await checkRateLimit(`rooms:write:${agentId}`, 20, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  // Verify membership
  const [membership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!membership) {
    return c.json({ error: "Not a member of this room", code: "NOT_MEMBER" }, 403);
  }

  // Creators cannot leave — they must delete the room or transfer ownership first
  if (membership.role === "creator") {
    // Allow if they're the last member
    const memberCount = await db
      .select()
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId))
      .limit(2);
    if (memberCount.length > 1) {
      return c.json({
        error: "Room creator cannot leave while other members exist. Delete the room or transfer ownership first.",
        code: "CREATOR_CANNOT_LEAVE",
      }, 400);
    }
  }

  await db
    .delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)));

  await audit(agentId, "room.left", "room", roomId, {});

  return c.json({ ok: true, room_id: roomId });
});

export default app;
