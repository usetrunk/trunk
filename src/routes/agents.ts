import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware, generateSecret, generatePairingCode, hashSecretAsync } from "../lib/auth.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

// Register a new agent
app.post("/register", async (c) => {
  const body = await c.req.json<{ name: string; owner?: string; webhook_url?: string }>();
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || "unknown";
  const rateLimit = await checkRateLimit(`register:${ip}`, 10, 60 * 60 * 1000);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const secret = generateSecret();
  const secretHash = await hashSecretAsync(secret);
  const pairingCode = generatePairingCode();
  const webhookSecret = generateSecret();

  const [agent] = await db
    .insert(agents)
    .values({
      name: body.name,
      owner: body.owner,
      secretHash,
      pairingCode,
      webhookUrl: body.webhook_url,
      webhookSecret,
    })
    .returning();

  return c.json({
    agent_id: agent.id,
    name: agent.name,
    secret, // only time the raw secret is returned
    pairing_code: agent.pairingCode,
    webhook_secret: webhookSecret,
    webhook_url: agent.webhookUrl,
  }, 201);
});

// Get current agent info
app.get("/me", authMiddleware, async (c) => {
  const agent = c.get("agent");
  return c.json({
    agent_id: agent.id,
    name: agent.name,
    owner: agent.owner,
    pairing_code: agent.pairingCode,
    webhook_url: agent.webhookUrl,
    created_at: agent.createdAt,
  });
});

// Update current agent
app.patch("/me", authMiddleware, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ name?: string; webhook_url?: string; owner?: string }>();

  const updates: Partial<typeof agents.$inferInsert> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.webhook_url !== undefined) updates.webhookUrl = body.webhook_url;
  if (body.owner !== undefined) updates.owner = body.owner;

  const [updated] = await db
    .update(agents)
    .set(updates)
    .where(eq(agents.id, agentId))
    .returning();

  return c.json({
    agent_id: updated.id,
    name: updated.name,
    owner: updated.owner,
    webhook_url: updated.webhookUrl,
  });
});

// Rotate secret
app.post("/me/rotate-secret", authMiddleware, async (c) => {
  const agentId = c.get("agentId");
  const newSecret = generateSecret();
  const newHash = await hashSecretAsync(newSecret);

  await db
    .update(agents)
    .set({ secretHash: newHash })
    .where(eq(agents.id, agentId));

  return c.json({ secret: newSecret });
});

export default app;
