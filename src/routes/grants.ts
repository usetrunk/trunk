import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { authMiddleware } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { createGrant, listGrants, revokeGrant, GrantError } from "../lib/grants.js";
import { isValidUUID } from "../lib/errors.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

app.get("/", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`read:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429 as ContentfulStatusCode);

  const grants = await listGrants(agentId);
  return c.json({ grants, count: grants.length });
});

app.post("/", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`write:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429 as ContentfulStatusCode);

  const body = await c.req.json().catch(() => null);
  try {
    const { grant, secret } = await createGrant(agentId, body ?? {}, agentId);
    await audit(agentId, "grant.create", "scoped_grant", grant.id, {
      name: grant.name,
      scopes: grant.scopes,
    });
    return c.json({
      grant,
      secret,
      warning: "Save this secret now — it cannot be retrieved again. Revoke and reissue to rotate.",
    }, 201);
  } catch (err) {
    if (err instanceof GrantError) {
      return c.json({ error: err.message, code: "VALIDATION_ERROR" }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
});

app.delete("/:id", async (c) => {
  const agentId = c.get("agentId");
  const id = c.req.param("id");
  if (!id || !isValidUUID(id)) {
    return c.json({ error: "Invalid grant id", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
  }

  const rateLimit = await checkRateLimit(`write:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429 as ContentfulStatusCode);

  try {
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body?.reason === "string" ? body.reason : undefined;
    const grant = await revokeGrant(agentId, id, reason);
    await audit(agentId, "grant.revoke", "scoped_grant", id, {
      name: grant.name,
    });
    return c.json({ ok: true, grant });
  } catch (err) {
    if (err instanceof GrantError) {
      return c.json({ error: err.message, code: err.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR" }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
});

export default app;
