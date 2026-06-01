import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { rateLimits } from "../db/schema.js";

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
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
    if (current) {
      await db
        .update(rateLimits)
        .set({ count: 1, windowStart: now, updatedAt: now })
        .where(eq(rateLimits.scope, scope));
    } else {
      await db.insert(rateLimits).values({ scope, count: 1, windowStart: now });
    }
    return { ok: true, limit, remaining: limit - 1 };
  }

  if (current.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now.getTime() - current.windowStart.getTime())) / 1000));
    return { ok: false, limit, remaining: 0, retryAfterSeconds };
  }

  const nextCount = current.count + 1;
  await db
    .update(rateLimits)
    .set({ count: nextCount, updatedAt: now })
    .where(eq(rateLimits.scope, scope));

  return { ok: true, limit, remaining: limit - nextCount };
}
