import { Hono } from "hono";
import { db } from "../db/index.js";
import { auditEvents } from "../db/schema.js";
import { eq, and, desc, lt, gte, lte } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { parsePaginationQuery, paginateResults } from "../lib/pagination.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

// GET /audit-events — query audit log for the authenticated agent
app.get("/", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`audit:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }
  const query = c.req.query();
  const pagination = parsePaginationQuery(query);

  const conditions = [eq(auditEvents.actorAgent, agentId)];

  if (query.action) {
    if (query.action.length > 100) return c.json({ error: "action filter too long", code: "INVALID_INPUT" }, 400);
    conditions.push(eq(auditEvents.action, query.action));
  }
  if (query.target_type) {
    if (query.target_type.length > 100) return c.json({ error: "target_type filter too long", code: "INVALID_INPUT" }, 400);
    conditions.push(eq(auditEvents.targetType, query.target_type));
  }
  if (query.target_id) {
    if (query.target_id.length > 100) return c.json({ error: "target_id filter too long", code: "INVALID_INPUT" }, 400);
    conditions.push(eq(auditEvents.targetId, query.target_id));
  }
  let afterDate: Date | undefined;
  if (query.after) {
    afterDate = new Date(query.after);
    if (isNaN(afterDate.getTime())) {
      return c.json({ error: "after must be a valid ISO 8601 date", code: "INVALID_INPUT" }, 400);
    }
    conditions.push(gte(auditEvents.createdAt, afterDate));
  }
  if (query.before) {
    const beforeDate = new Date(query.before);
    if (isNaN(beforeDate.getTime())) {
      return c.json({ error: "before must be a valid ISO 8601 date", code: "INVALID_INPUT" }, 400);
    }
    if (afterDate && beforeDate <= afterDate) {
      return c.json({ error: "before must be after the after date", code: "INVALID_INPUT" }, 400);
    }
    conditions.push(lte(auditEvents.createdAt, beforeDate));
  }

  if (pagination.cursor) {
    conditions.push(
      lt(auditEvents.createdAt, pagination.cursor.createdAt)
    );
  }

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt))
    .limit(pagination.limit + 1);

  const paginated = paginateResults(rows, pagination.limit);

  return c.json({
    events: paginated.items.map((e) => ({
      id: e.id,
      action: e.action,
      target_type: e.targetType,
      target_id: e.targetId,
      metadata: e.metadata,
      created_at: e.createdAt,
    })),
    next_cursor: paginated.next_cursor,
    has_more: paginated.has_more,
  });
});

export default app;
