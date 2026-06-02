import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents, webhookDeliveries } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { authMiddleware, generateSecret, generatePairingCode, hashSecretAsync } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { canMessage } from "../lib/workspace.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

// Register a new agent
app.post("/register", async (c) => {
  const body = await c.req.json<{ name: string; owner?: string; webhook_url?: string }>();
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || "unknown";
  const rateLimit = await checkRateLimit(`register:${ip}`, 10, 60 * 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
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
  const meta = (agent.metadata ?? {}) as Record<string, unknown>;
  return c.json({
    agent_id: agent.id,
    name: agent.name,
    owner: agent.owner,
    pairing_code: agent.pairingCode,
    webhook_url: agent.webhookUrl,
    role: meta.role as string | undefined,
    projects: meta.projects as string[] | undefined,
    metadata: meta,
    created_at: agent.createdAt,
  });
});

// Update current agent (name, webhook_url, owner, role, projects, metadata)
app.patch("/me", authMiddleware, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{
    name?: string;
    webhook_url?: string;
    owner?: string;
    role?: string;
    projects?: string[];
    metadata?: Record<string, unknown>;
  }>();

  const updates: Partial<typeof agents.$inferInsert> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.webhook_url !== undefined) updates.webhookUrl = body.webhook_url;
  if (body.owner !== undefined) updates.owner = body.owner;

  if (body.role !== undefined || body.projects !== undefined || body.metadata !== undefined) {
    const [current] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId)).limit(1);
    const existing = ((current?.metadata ?? {}) as Record<string, unknown>);
    const newMeta: Record<string, unknown> = { ...existing };
    if (body.role !== undefined) newMeta.role = body.role;
    if (body.projects !== undefined) newMeta.projects = body.projects;
    if (body.metadata !== undefined) Object.assign(newMeta, body.metadata);
    updates.metadata = newMeta;
  }

  const [updated] = await db
    .update(agents)
    .set(updates)
    .where(eq(agents.id, agentId))
    .returning();

  const meta = ((updated.metadata ?? {}) as Record<string, unknown>);
  return c.json({
    agent_id: updated.id,
    name: updated.name,
    owner: updated.owner,
    webhook_url: updated.webhookUrl,
    role: meta.role as string | undefined,
    projects: meta.projects as string[] | undefined,
    metadata: meta,
  });
});

// Set or clear custom status text
app.put("/me/status", authMiddleware, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ text: string | null }>();

  const [current] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId)).limit(1);
  const meta = { ...((current?.metadata ?? {}) as Record<string, unknown>) };
  if (body.text) {
    meta.status_text = body.text;
  } else {
    delete meta.status_text;
  }

  await db.update(agents).set({ metadata: meta }).where(eq(agents.id, agentId));
  await audit(agentId, "agent.status_update", "agent", agentId, { status_text: body.text });
  return c.json({ ok: true, status_text: body.text ?? null });
});

// Presence — show online/away/offline status for workspace co-members
// NOTE: must be before /:id to avoid being caught by the param route
app.get("/presence", authMiddleware, async (c) => {
  const agent = c.get("agent");
  if (!agent.workspaceId) {
    return c.json({ error: "Not in a workspace" }, 400);
  }

  const members = await db
    .select({
      id: agents.id,
      name: agents.name,
      owner: agents.owner,
      lastSeenAt: agents.lastSeenAt,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.workspaceId, agent.workspaceId));

  const now = Date.now();
  const ONLINE_THRESHOLD = 5 * 60 * 1000;  // 5 minutes
  const AWAY_THRESHOLD = 30 * 60 * 1000;   // 30 minutes

  const presence = members.map((m) => {
    const lastSeen = m.lastSeenAt ? m.lastSeenAt.getTime() : 0;
    const elapsed = now - lastSeen;
    let status: "online" | "away" | "offline";
    if (!m.lastSeenAt) {
      status = "offline";
    } else if (elapsed < ONLINE_THRESHOLD) {
      status = "online";
    } else if (elapsed < AWAY_THRESHOLD) {
      status = "away";
    } else {
      status = "offline";
    }

    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return {
      agent_id: m.id,
      name: m.name,
      owner: m.owner,
      role: meta.role as string | undefined,
      status_text: (meta.status_text as string | undefined) ?? null,
      status,
      last_seen_at: m.lastSeenAt,
    };
  });

  return c.json({
    workspace_id: agent.workspaceId,
    members: presence,
    online: presence.filter((p) => p.status === "online").length,
    away: presence.filter((p) => p.status === "away").length,
    offline: presence.filter((p) => p.status === "offline").length,
  });
});

// Get another agent's public profile (caller must be a contact or workspace co-member)
app.get("/:id", authMiddleware, async (c) => {
  const myId = c.get("agentId");
  const targetId = c.req.param("id");

  const allowed = await canMessage(myId, targetId);
  if (!allowed) {
    return c.json({ error: "Not a contact" }, 403);
  }

  const [target] = await db.select().from(agents).where(eq(agents.id, targetId)).limit(1);
  if (!target) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const meta = ((target.metadata ?? {}) as Record<string, unknown>);
  return c.json({
    agent_id: target.id,
    name: target.name,
    owner: target.owner,
    role: meta.role as string | undefined,
    projects: meta.projects as string[] | undefined,
    metadata: meta,
  });
});

// Get webhook configuration
app.get("/me/webhook", authMiddleware, async (c) => {
  const agent = c.get("agent");
  return c.json({
    url: agent.webhookUrl ?? null,
    secret_hint: agent.webhookSecret ? `${agent.webhookSecret.slice(0, 6)}...` : null,
    configured: Boolean(agent.webhookUrl),
  });
});

// Set/update webhook configuration
app.put("/me/webhook", authMiddleware, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ url: string }>();

  if (!body.url) {
    return c.json({ error: "url is required" }, 400);
  }

  try {
    new URL(body.url);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }

  const [updated] = await db
    .update(agents)
    .set({ webhookUrl: body.url })
    .where(eq(agents.id, agentId))
    .returning();

  return c.json({
    url: updated.webhookUrl,
    secret_hint: updated.webhookSecret ? `${updated.webhookSecret.slice(0, 6)}...` : null,
    configured: true,
  });
});

// Remove webhook configuration
app.delete("/me/webhook", authMiddleware, async (c) => {
  const agentId = c.get("agentId");

  await db
    .update(agents)
    .set({ webhookUrl: null })
    .where(eq(agents.id, agentId));

  return c.json({ ok: true });
});

// Rotate webhook signing secret
app.post("/me/webhook/rotate-secret", authMiddleware, async (c) => {
  const agentId = c.get("agentId");
  const newWebhookSecret = generateSecret();

  await db
    .update(agents)
    .set({ webhookSecret: newWebhookSecret })
    .where(eq(agents.id, agentId));

  return c.json({
    webhook_secret: newWebhookSecret,
    message: "Webhook signing secret rotated. Update your verification logic with the new secret.",
  });
});

// List recent webhook deliveries
app.get("/me/webhook/deliveries", authMiddleware, async (c) => {
  const agentId = c.get("agentId");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);

  const deliveries = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.agentId, agentId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);

  return c.json({
    deliveries: deliveries.map((d) => ({
      id: d.id,
      message_id: d.messageId,
      url: d.url,
      event: d.event,
      success: d.success === 1,
      http_status: d.httpStatus,
      latency_ms: d.latencyMs,
      error: d.error,
      attempts: d.attempts,
      created_at: d.createdAt,
    })),
    count: deliveries.length,
  });
});

// Test webhook — sends a ping to the agent's configured webhook URL
app.post("/me/webhook/test", authMiddleware, async (c) => {
  const agent = c.get("agent");
  if (!agent.webhookUrl) {
    return c.json({ error: "No webhook URL configured. Set one with PUT /agents/me/webhook" }, 400);
  }

  const testPayload = JSON.stringify({
    event: "webhook.test",
    agent_id: agent.id,
    timestamp: new Date().toISOString(),
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Trunk-Event": "webhook.test",
  };

  if (agent.webhookSecret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(agent.webhookSecret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(testPayload));
    headers["X-Trunk-Signature"] = `sha256=${Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  }

  const start = Date.now();
  let success = false;
  let httpStatus: number | undefined;
  let errorMsg: string | undefined;

  try {
    const res = await fetch(agent.webhookUrl, {
      method: "POST",
      headers,
      body: testPayload,
      signal: AbortSignal.timeout(10000),
    });

    success = res.ok;
    httpStatus = res.status;
    if (!res.ok) errorMsg = `HTTP ${res.status}`;
  } catch (err: unknown) {
    errorMsg = err instanceof Error ? err.message : "unknown error";
  }

  const latencyMs = Date.now() - start;

  // Log the test delivery
  await db.insert(webhookDeliveries).values({
    agentId: agent.id,
    url: agent.webhookUrl,
    event: "webhook.test",
    success: success ? 1 : 0,
    httpStatus: httpStatus ?? null,
    latencyMs,
    error: errorMsg ?? null,
    attempts: 1,
  });

  if (success) {
    return c.json({
      ok: true,
      status: httpStatus,
      webhook_url: agent.webhookUrl,
      latency_ms: latencyMs,
      message: "Webhook responded successfully",
    });
  }

  return c.json({
    ok: false,
    status: httpStatus,
    webhook_url: agent.webhookUrl,
    latency_ms: latencyMs,
    message: errorMsg ? `Webhook failed: ${errorMsg}` : "Webhook unreachable",
  }, httpStatus ? 200 : 502);
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
