import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { resolveGrantToken, type ResolvedGrant } from "./grants.js";
import type { GrantScopeT } from "../protocol/grants.js";

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

    // Scoped grant tokens (tg_*) get validated against the grants table.
    // Bearer agent secrets keep their existing semantics.
    let resolvedGrant: ResolvedGrant | null = null;
    if (token.startsWith("tg_")) {
      resolvedGrant = await resolveGrantToken(token);
      if (!resolvedGrant) {
        return c.json({ error: "Invalid or expired grant token", code: "UNAUTHORIZED" }, 401);
      }
    }

    const lookupToken = resolvedGrant ? resolvedGrant.agentId : token;
    const tokenHash = await hashSecretAsync(resolvedGrant ? resolvedGrant.agentId : token);

    // For grants we look up the agent by id (since the secret material is the grant token,
    // not the agent secret). For bearer agent secrets we look up by secretHash.
    const [agent] = resolvedGrant
      ? await db.select().from(agents).where(eq(agents.id, lookupToken)).limit(1)
      : await db.select().from(agents).where(eq(agents.secretHash, tokenHash)).limit(1);

    if (!agent) {
      return c.json({ error: "Invalid token", code: "UNAUTHORIZED" }, 401);
    }

    c.set("agentId", agent.id);
    c.set("agent", agent);
    if (resolvedGrant) {
      c.set("grant", resolvedGrant.grant);
      c.set("grantScopes", resolvedGrant.scopes);
    }

    // Touch lastSeenAt for presence tracking — debounce to avoid DB contention
    const now = new Date();
    const staleThreshold = 30_000; // 30 seconds
    if (!agent.lastSeenAt || now.getTime() - new Date(agent.lastSeenAt).getTime() > staleThreshold) {
      await db.update(agents)
        .set({ lastSeenAt: now })
        .where(eq(agents.id, agent.id));
    }

    void lookupToken;

    await next();
  }
);

/**
 * Require that the authenticated request hold a grant (or bearer secret with
 * a `grant` for the requested scope). For pure bearer-secret calls this
 * passes through.
 */
export function requireScope(scope: GrantScopeT) {
  return async (c: { get: (key: string) => unknown; json: (body: unknown, status?: number) => unknown }, next: () => Promise<void>) => {
    const scopes = c.get("grantScopes") as GrantScopeT[] | undefined;
    if (!scopes) {
      // Bearer secret path — full agent access. Pass through.
      await next();
      return;
    }
    if (!scopes.includes(scope)) {
      return c.json({ error: `Missing required scope: ${scope}`, code: "INSUFFICIENT_SCOPE" }, 403);
    }
    await next();
  };
}
