import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, contacts } from "../db/schema.js";
import { eq, or, and } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// Pair with another agent via their pairing code
app.post("/pair", async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ code: string; alias?: string }>();

  if (!body.code) {
    return c.json({ error: "code is required" }, 400);
  }

  // Find the agent with this pairing code
  const [target] = await db
    .select()
    .from(agents)
    .where(eq(agents.pairingCode, body.code.toUpperCase()))
    .limit(1);

  if (!target) {
    return c.json({ error: "Invalid pairing code" }, 404);
  }

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

  // Create bidirectional contact
  await db.insert(contacts).values({
    agentA: agentId,
    agentB: target.id,
    aliasA: body.alias,
  });
  await audit(agentId, "contact.pair", "agent", target.id, { alias: body.alias });

  return c.json({
    contact_id: target.id,
    name: target.name,
    paired_at: new Date().toISOString(),
  }, 201);
});

// List contacts
app.get("/", async (c) => {
  const agentId = c.get("agentId");

  const rows = await db
    .select()
    .from(contacts)
    .where(or(eq(contacts.agentA, agentId), eq(contacts.agentB, agentId)));

  const contactIds = rows.map((r) =>
    r.agentA === agentId ? r.agentB : r.agentA
  );

  if (contactIds.length === 0) {
    return c.json({ contacts: [] });
  }

  const contactAgents = await db
    .select({ id: agents.id, name: agents.name, owner: agents.owner })
    .from(agents)
    .where(or(...contactIds.map((id) => eq(agents.id, id))));

  const result = contactAgents.map((a) => {
    const row = rows.find(
      (r) => r.agentA === a.id || r.agentB === a.id
    );
    return {
      agent_id: a.id,
      name: a.name,
      owner: a.owner,
      paired_at: row?.pairedAt,
    };
  });

  return c.json({ contacts: result });
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

export default app;
