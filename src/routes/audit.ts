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
    conditions.push(eq(auditEvents.action, query.action));
  }
  if (query.target_type) {
    conditions.push(eq(auditEvents.targetType, query.target_type));
  }
  if (query.target_id) {
    conditions.push(eq(auditEvents.targetId, query.target_id));
  }
  if (query.after) {
    const after = new Date(query.after);
    if (!isNaN(after.getTime())) {
      conditions.push(gte(auditEvents.createdAt, after));
    }
  }
  if (query.before) {
    const before = new Date(query.before);
    if (!isNaN(before.getTime())) {
      conditions.push(lte(auditEvents.createdAt, before));
    }
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
