import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { canMessage } from "../lib/workspace.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { getCard, signCard, upsertCard, CardError, validateCard } from "../lib/agent-cards.js";
import { UpsertAgentCardRequest } from "../protocol/agent-cards.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mounted at `/agents`. Routes:
//   GET  /me/card       -> current agent's own card
//   PUT  /me/card       -> upsert current agent's own card
//   GET  /:id/card      -> fetch another agent's card
app.get("/me/card", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429 as ContentfulStatusCode);

  const card = await getCard(agentId);
  if (!card) return c.json({ error: "Agent not found", code: "AGENT_NOT_FOUND" }, 404 as ContentfulStatusCode);
  const signingKey = process.env.AGENT_CARD_SIGNING_KEY ?? null;
  const signed = await signCard(card, signingKey);
  return c.json({ card: signed, signed: Boolean(signingKey) });
});

app.put("/me/card", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`write:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429 as ContentfulStatusCode);

  const body = await c.req.json().catch(() => null);
  const parsed = UpsertAgentCardRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid agent card body", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
  }

  try {
    const { card, created } = await upsertCard(agentId, parsed.data);
    validateCard(card);
    const signingKey = process.env.AGENT_CARD_SIGNING_KEY ?? null;
    const signed = await signCard(card, signingKey);
    await audit(agentId, created ? "agent_card.create" : "agent_card.update", "agent", agentId, {
      version: card.version,
      capability_count: card.capabilities.length,
    });
    return c.json({ card: signed, signed: Boolean(signingKey) });
  } catch (err) {
    if (err instanceof CardError) {
      return c.json({ error: err.message, code: "VALIDATION_ERROR" }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
});

app.get("/:id/card", async (c) => {
  const myId = c.get("agentId");
  const targetId = c.req.param("id");
  if (!targetId || !UUID_RE.test(targetId)) {
    return c.json({ error: "Invalid agent id format", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
  }

  const rateLimit = await checkRateLimit(`read:${myId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429 as ContentfulStatusCode);

  const [target] = await db.select().from(agents).where(eq(agents.id, targetId)).limit(1);
  if (!target) return c.json({ error: "Agent not found", code: "AGENT_NOT_FOUND" }, 404 as ContentfulStatusCode);

  const card = await getCard(targetId);
  if (!card) return c.json({ error: "Agent not found", code: "AGENT_NOT_FOUND" }, 404 as ContentfulStatusCode);

  if (card.contact_policy.pairing_open === false) {
    const allowed = await canMessage(myId, targetId);
    if (!allowed) {
      return c.json({ error: "Agent card is private and you are not a contact", code: "FORBIDDEN" }, 403 as ContentfulStatusCode);
    }
  }

  const signingKey = process.env.AGENT_CARD_SIGNING_KEY ?? null;
  const signed = await signCard(card, signingKey);
  return c.json({ card: signed, signed: Boolean(signingKey) });
});

export default app;
