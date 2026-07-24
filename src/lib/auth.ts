import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { resolveGrantToken, type ResolvedGrant } from "./grants.js";
import type { GrantScopeT } from "../protocol/grants.js";
import { authorizationRequestForHttp, authorizeGrant } from "./authorization.js";
import {
  authorizeDelegation,
  delegationRequestForHttp,
  resolveDelegationCredential,
  type DelegationEnvelope,
} from "./delegation-authorization.js";
import {
  auditReasonForResponse,
  createAnonymousAuditExecutionContext,
  createAuditExecutionContext,
  provenanceFromRequest,
  recordAuthorizationDecision,
  runWithAuditContext,
  traceIdFromRequest,
  type AuditReasonCode,
} from "./audit.js";

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
      await recordUnauthenticatedHttpDenial(c.req.raw, "UNAUTHORIZED");
      return c.json({ error: "Missing or invalid Authorization header", code: "UNAUTHORIZED" }, 401);
    }

    const token = authHeader.slice(7);

    // Scoped grant tokens (tg_*) get validated against the grants table.
    // Bearer agent secrets keep their existing semantics.
    let resolvedGrant: ResolvedGrant | null = null;
    if (token.startsWith("tg_")) {
      resolvedGrant = await resolveGrantToken(token);
      if (!resolvedGrant) {
        await recordUnauthenticatedHttpDenial(c.req.raw, "INVALID_CREDENTIAL");
        return c.json({ error: "Invalid or expired grant token", code: "UNAUTHORIZED" }, 401);
      }
    }

    const credential = await resolveCredential(token, resolvedGrant);
    if (!credential) {
      await recordUnauthenticatedHttpDenial(c.req.raw, "INVALID_CREDENTIAL");
      return c.json({ error: "Invalid token", code: "UNAUTHORIZED" }, 401);
    }
    const { agent } = credential;
    const grantRequest = await authorizationRequestForHttp(c.req.raw, agent);
    const executionContext = await createAuditExecutionContext(credential, {
      requestId: c.req.header("X-Request-Id"),
      traceId: traceIdFromRequest(c.req.raw),
      provenance: provenanceFromRequest(c.req.raw),
    });

    return runWithAuditContext(executionContext, async () => {
      if (credential.grant) {
        const decision = authorizeGrant(
          { grant: credential.grant, scopes: credential.scopes ?? [] },
          grantRequest,
        );
        if (!decision.allowed) {
          await recordHttpAuthorization(agent.id, c.req.raw, grantRequest, "denied", decision.code);
          return c.json({ error: decision.message, code: decision.code }, 403);
        }
      }
      if (credential.delegation) {
        const request = await delegationRequestForHttp(c.req.raw, credential.delegation);
        const decision = request && "allowed" in request
          ? request
          : authorizeDelegation(credential.delegation, request);
        if (!decision.allowed) {
          await recordHttpAuthorization(agent.id, c.req.raw, grantRequest, "denied", decision.code);
          return c.json({ error: decision.message, code: decision.code }, 403);
        }
      }

      c.set("agentId", agent.id);
      c.set("agent", agent);
      if (credential.grant) {
        c.set("grant", credential.grant);
        c.set("grantScopes", credential.scopes);
      }
      if (credential.delegation) c.set("delegation", credential.delegation);

      // Touch lastSeenAt for presence tracking — debounce to avoid DB contention
      const now = new Date();
      const staleThreshold = 30_000; // 30 seconds
      if (!agent.lastSeenAt || now.getTime() - new Date(agent.lastSeenAt).getTime() > staleThreshold) {
        await db.update(agents)
          .set({ lastSeenAt: now })
          .where(eq(agents.id, agent.id));
      }
      await next();

      let responseCode: string | null = null;
      if (c.res.status === 401 || c.res.status === 403) {
        const responseBody = await c.res.clone().json().catch(() => null);
        if (isRecord(responseBody) && typeof responseBody.code === "string") {
          responseCode = responseBody.code;
        }
      }
      const result = auditReasonForResponse(c.res.status, responseCode);
      await recordHttpAuthorization(agent.id, c.req.raw, grantRequest, result.outcome, result.reasonCode);
    });
  }
);

export type ResolvedCredential = {
  agentId: string;
  agent: typeof agents.$inferSelect;
  grant?: ResolvedGrant["grant"];
  scopes?: GrantScopeT[];
  delegation?: DelegationEnvelope;
};

export async function resolveCredential(
  token: string,
  preResolvedGrant?: ResolvedGrant | null,
): Promise<ResolvedCredential | null> {
  const resolvedGrant = preResolvedGrant === undefined
    ? (token.startsWith("tg_") ? await resolveGrantToken(token) : null)
    : preResolvedGrant;
  if (token.startsWith("tg_") && !resolvedGrant) return null;

  const [agent] = resolvedGrant
    ? await db.select().from(agents).where(eq(agents.id, resolvedGrant.agentId)).limit(1)
    : await db.select().from(agents).where(eq(agents.secretHash, await hashSecretAsync(token))).limit(1);
  if (!agent) return null;

  const delegation = await resolveDelegationCredential(agent.id);
  if (delegation.kind === "invalid") return null;
  const credential: ResolvedCredential = resolvedGrant
    ? { agentId: agent.id, agent, grant: resolvedGrant.grant, scopes: resolvedGrant.scopes }
    : { agentId: agent.id, agent };
  if (delegation.kind === "active") credential.delegation = delegation.envelope;
  return credential;
}

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

async function recordHttpAuthorization(
  actorAgent: string,
  request: Request,
  authorizationRequest: Awaited<ReturnType<typeof authorizationRequestForHttp>>,
  outcome: "success" | "denied" | "failure",
  reasonCode: AuditReasonCode,
): Promise<void> {
  const target = authorizationRequest?.target;
  const targetType = target?.roomId
    ? "room"
    : target?.workspaceId
      ? "workspace"
      : target?.agentId
        ? "agent"
        : "http_route";
  const targetId = target?.roomId ?? target?.workspaceId ?? target?.agentId ?? new URL(request.url).pathname;
  await recordAuthorizationDecision({
    actorAgent,
    outcome,
    reasonCode,
    targetType,
    targetId,
    surface: "http",
    operation: authorizationRequest?.scope ?? `${request.method.toUpperCase()} ${new URL(request.url).pathname}`,
    scope: authorizationRequest?.scope,
    metadata: {
      method: request.method.toUpperCase(),
      path: new URL(request.url).pathname,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function recordUnauthenticatedHttpDenial(
  request: Request,
  reasonCode: "UNAUTHORIZED" | "INVALID_CREDENTIAL",
): Promise<void> {
  const url = new URL(request.url);
  const context = createAnonymousAuditExecutionContext({
    requestId: request.headers.get("X-Request-Id"),
    traceId: traceIdFromRequest(request),
    provenance: provenanceFromRequest(request),
  });
  await runWithAuditContext(context, () => recordAuthorizationDecision({
    actorAgent: null,
    outcome: "denied",
    reasonCode,
    targetType: "http_route",
    targetId: url.pathname,
    surface: "http",
    operation: `${request.method.toUpperCase()} ${url.pathname}`,
    metadata: {
      method: request.method.toUpperCase(),
      path: url.pathname,
    },
  }));
}
