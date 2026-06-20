import { eq, lt } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db/index.js";
import { rateLimits } from "../db/schema.js";

const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let nextPruneAt = 0;

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds?: number;
};

export async function pruneStaleRateLimits(
  now = new Date(),
  retentionMs = RATE_LIMIT_RETENTION_MS
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionMs);
  const removed = await db
    .delete(rateLimits)
    .where(lt(rateLimits.updatedAt, cutoff))
    .returning({ scope: rateLimits.scope });

  return removed.length;
}

export async function checkRateLimit(scope: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const now = new Date();
  await maybePruneStaleRateLimits(now);

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

async function maybePruneStaleRateLimits(now: Date): Promise<void> {
  if (now.getTime() < nextPruneAt) return;
  nextPruneAt = now.getTime() + RATE_LIMIT_PRUNE_INTERVAL_MS;
  try {
    await pruneStaleRateLimits(now);
  } catch {
    // Rate limiting must not fail closed because a best-effort cleanup missed.
  }
}
