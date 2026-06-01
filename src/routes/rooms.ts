import { Hono } from "hono";
import { db } from "../db/index.js";
import { rooms, roomMembers, agents } from "../db/schema.js";
import { eq, or } from "drizzle-orm";
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
    return c.json({ error: "Already a member" }, 409);
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

export default app;
