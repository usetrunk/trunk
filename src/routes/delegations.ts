import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { isValidUUID } from "../lib/errors.js";
import {
  claimDelegation,
  createDelegation,
  DelegationError,
  listDelegations,
  revokeDelegation,
} from "../lib/delegations.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.post("/claim", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || "unknown";
  const rateLimit = await checkRateLimit(`delegations:claim:${ip}`, 30, 60 * 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429 as ContentfulStatusCode);
  }

  const body = await c.req.json().catch(() => null);
  try {
    const result = await claimDelegation(body ?? {});
    await audit(result.delegation.child_agent_id, "delegation.claim", "agent_delegation", result.delegation.id, {
      parent_agent_id: result.delegation.parent_agent_id,
      room_id: result.delegation.room_id,
      runtime: result.delegation.runtime,
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof DelegationError) {
      return c.json({ error: err.message, code: err.code }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
});

app.use("/*", authMiddleware);

app.get("/", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429 as ContentfulStatusCode);
  }

  const roomId = c.req.query("room_id");
  if (roomId !== undefined && !isValidUUID(roomId)) {
    return c.json({ error: "Invalid room_id format", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
  }

  const delegations = await listDelegations(agentId, { room_id: roomId });
  return c.json({ delegations, count: delegations.length });
});

app.post("/", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`delegations:create:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429 as ContentfulStatusCode);
  }

  const body = await c.req.json().catch(() => null);
  try {
    const result = await createDelegation(agentId, body ?? {});
    await audit(agentId, "delegation.create", "agent_delegation", result.delegation.id, {
      room_id: result.delegation.room_id,
      task_id: result.delegation.task_id,
      runtime: result.delegation.runtime,
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof DelegationError) {
      return c.json({ error: err.message, code: err.code }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
});

app.delete("/:id", async (c) => {
  const agentId = c.get("agentId");
  const id = c.req.param("id");
  if (!id || !isValidUUID(id)) {
    return c.json({ error: "Invalid delegation id", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
  }

  const rateLimit = await checkRateLimit(`delegations:write:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429 as ContentfulStatusCode);
  }

  const body = await c.req.json().catch(() => ({}));
  try {
    const delegation = await revokeDelegation(agentId, id, typeof body?.reason === "string" ? body.reason : undefined);
    await audit(agentId, "delegation.revoke", "agent_delegation", id, {
      room_id: delegation.room_id,
      reason: typeof body?.reason === "string" ? body.reason : undefined,
    });
    return c.json({ ok: true, delegation });
  } catch (err) {
    if (err instanceof DelegationError) {
      return c.json({ error: err.message, code: err.code }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
});

export default app;
