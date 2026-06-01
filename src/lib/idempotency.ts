import { Context } from "hono";

export function requireIdempotencyKey(c: Context): string | Response {
  const key = c.req.header("Idempotency-Key")?.trim();
  if (!key) {
    return c.json({ error: "Idempotency-Key header is required" }, 400);
  }
  if (key.length > 128) {
    return c.json({ error: "Idempotency-Key must be 128 characters or fewer" }, 400);
  }
  return key;
}
