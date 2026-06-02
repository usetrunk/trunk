import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db/index.js";
import { rateLimits } from "../db/schema.js";

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds?: number;
};

export async function checkRateLimit(scope: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const now = new Date();
  const [current] = await db
    .select()
    .from(rateLimits)
    .where(eq(rateLimits.scope, scope))
    .limit(1);

  if (!current || now.getTime() - current.windowStart.getTime() >= windowMs) {
    const resetAt = new Date(now.getTime() + windowMs);
    if (current) {
      await db
        .update(rateLimits)
        .set({ count: 1, windowStart: now, updatedAt: now })
        .where(eq(rateLimits.scope, scope));
    } else {
      await db.insert(rateLimits).values({ scope, count: 1, windowStart: now });
    }
    return { ok: true, limit, remaining: limit - 1, resetAt };
  }

  const resetAt = new Date(current.windowStart.getTime() + windowMs);

  if (current.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
    return { ok: false, limit, remaining: 0, resetAt, retryAfterSeconds };
  }

  const nextCount = current.count + 1;
  await db
    .update(rateLimits)
    .set({ count: nextCount, updatedAt: now })
    .where(eq(rateLimits.scope, scope));

  return { ok: true, limit, remaining: limit - nextCount, resetAt };
}

export function setRateLimitHeaders(c: Context, result: RateLimitResult): void {
  c.header("X-RateLimit-Limit", String(result.limit));
  c.header("X-RateLimit-Remaining", String(result.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(result.resetAt.getTime() / 1000)));
  if (!result.ok && result.retryAfterSeconds !== undefined) {
    c.header("Retry-After", String(result.retryAfterSeconds));
  }
}
