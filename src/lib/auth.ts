import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";

export async function hashSecretAsync(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generatePairingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 for readability
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

import type { AgentVariables } from "./types.js";

export const authMiddleware = createMiddleware<AgentVariables>(
  async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header", code: "UNAUTHORIZED" }, 401);
    }

    const token = authHeader.slice(7);
    const tokenHash = await hashSecretAsync(token);

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.secretHash, tokenHash))
      .limit(1);

    if (!agent) {
      return c.json({ error: "Invalid token", code: "UNAUTHORIZED" }, 401);
    }

    c.set("agentId", agent.id);
    c.set("agent", agent);

    // Touch lastSeenAt for presence tracking — debounce to avoid DB contention
    const now = new Date();
    const staleThreshold = 30_000; // 30 seconds
    if (!agent.lastSeenAt || now.getTime() - new Date(agent.lastSeenAt).getTime() > staleThreshold) {
      await db.update(agents)
        .set({ lastSeenAt: now })
        .where(eq(agents.id, agent.id));
    }

    await next();
  }
);
