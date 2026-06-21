/**
 * Scoped grant service.
 *
 * Manages long-lived scoped credentials. Each grant has a name, a list of
 * `GrantScope`s, optional audience (agent / workspace / room), optional
 * time bounds, and explicit revocation. A grant is authenticated by its
 * bearer token — the token id (a public identifier) is stored alongside a
 * hash of the secret material.
 *
 * This module is the single source of truth for issuing, validating, and
 * revoking grants. Routes wrap these primitives.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { scopedGrants, agents } from "../db/schema.js";
import { hashSecretAsync, generateSecret } from "../lib/auth.js";
import {
  CreateGrantRequest,
  GRANT_SCOPES,
  type CreateGrantRequestT,
  type GrantRecordT,
  type GrantScopeT,
} from "../protocol/grants.js";

const SCOPE_SET = new Set<string>(GRANT_SCOPES);

const grantTokenCache = new Map<string, Promise<ResolvedGrant | null>>();

export class GrantError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "GrantError";
    this.status = status;
  }
}

function rowToRecord(row: typeof scopedGrants.$inferSelect): GrantRecordT {
  const audience: GrantRecordT["audience"] = {};
  if (row.audienceAgentId) audience.agent_id = row.audienceAgentId;
  if (row.audienceWorkspaceId) audience.workspace_id = row.audienceWorkspaceId;
  if (row.roomId) audience.room_id = row.roomId;

  const validScopes = (row.scopes ?? []).filter((s): s is GrantScopeT => SCOPE_SET.has(s));

  return {
    id: row.id,
    owner_agent_id: row.ownerAgentId,
    name: row.name,
    description: row.description ?? null,
    token_id: row.tokenId,
    scopes: validScopes,
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    not_before: row.notBefore ? row.notBefore.toISOString() : null,
    audience: Object.keys(audience).length > 0 ? audience : undefined,
    revoked: row.revokedAt !== null,
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
    revoked_reason: row.revokedReason ?? null,
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    use_count: row.useCount,
    created_at: row.createdAt.toISOString(),
    created_by: row.createdBy ?? null,
    metadata: row.metadata ?? {},
  };
}

export async function createGrant(
  ownerAgentId: string,
  input: CreateGrantRequestT,
  createdBy: string | null,
): Promise<{ grant: GrantRecordT; secret: string }> {
  const parsed = CreateGrantRequest.safeParse(input);
  if (!parsed.success) {
    throw new GrantError(parsed.error.message, 400);
  }
  const data = parsed.data;

  if (data.audience_agent_id) {
    const [target] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, data.audience_agent_id)).limit(1);
    if (!target) throw new GrantError("audience_agent_id not found", 404);
  }

  const tokenId = `tg_${generateSecret().slice(0, 24)}`;
  const secretMaterial = generateSecret();
  const composite = `${tokenId}.${secretMaterial}`;
  const tokenHash = await hashSecretAsync(composite);

  const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new GrantError("expires_at must be a valid ISO timestamp", 400);
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new GrantError("expires_at must be in the future", 400);
  }
  const notBefore = data.not_before ? new Date(data.not_before) : null;
  if (notBefore && Number.isNaN(notBefore.getTime())) {
    throw new GrantError("not_before must be a valid ISO timestamp", 400);
  }

  const [row] = await db
    .insert(scopedGrants)
    .values({
      ownerAgentId,
      createdBy,
      name: data.name,
      description: data.description ?? null,
      tokenHash,
      tokenId,
      scopes: data.scopes,
      audienceAgentId: data.audience_agent_id ?? null,
      audienceWorkspaceId: data.audience_workspace_id ?? null,
      roomId: data.room_id ?? null,
      expiresAt,
      notBefore,
      metadata: data.metadata ?? {},
    })
    .returning();

  return { grant: rowToRecord(row), secret: composite };
}

export async function listGrants(ownerAgentId: string): Promise<GrantRecordT[]> {
  const rows = await db
    .select()
    .from(scopedGrants)
    .where(eq(scopedGrants.ownerAgentId, ownerAgentId))
    .orderBy(desc(scopedGrants.createdAt));
  return rows.map(rowToRecord);
}

export async function getGrant(ownerAgentId: string, id: string): Promise<GrantRecordT | null> {
  const [row] = await db
    .select()
    .from(scopedGrants)
    .where(and(eq(scopedGrants.id, id), eq(scopedGrants.ownerAgentId, ownerAgentId)))
    .limit(1);
  return row ? rowToRecord(row) : null;
}

export async function revokeGrant(
  ownerAgentId: string,
  id: string,
  reason?: string,
): Promise<GrantRecordT> {
  const existing = await getGrant(ownerAgentId, id);
  if (!existing) {
    throw new GrantError("Grant not found", 404);
  }
  if (existing.revoked) {
    return existing;
  }
  await db
    .update(scopedGrants)
    .set({ revokedAt: new Date(), revokedReason: reason ?? null })
    .where(and(eq(scopedGrants.id, id), eq(scopedGrants.ownerAgentId, ownerAgentId)));
  const refreshed = await getGrant(ownerAgentId, id);
  if (!refreshed) {
    throw new GrantError("Grant disappeared after revoke", 500);
  }
  return refreshed;
}

export type ResolvedGrant = {
  grant: GrantRecordT;
  agentId: string;
  scopes: GrantScopeT[];
};

export async function resolveGrantToken(token: string): Promise<ResolvedGrant | null> {
  if (!token.startsWith("tg_") || !token.includes(".")) return null;
  const cached = grantTokenCache.get(token);
  if (cached) {
    return await cached;
  }
  const promise = resolveGrantTokenUncached(token);
  grantTokenCache.set(token, promise);
  try {
    return await promise;
  } finally {
    grantTokenCache.delete(token);
  }
}

async function resolveGrantTokenUncached(token: string): Promise<ResolvedGrant | null> {
  const tokenHash = await hashSecretAsync(token);
  const [row] = await db
    .select()
    .from(scopedGrants)
    .where(eq(scopedGrants.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  if (row.notBefore && row.notBefore.getTime() > Date.now()) return null;

  await db
    .update(scopedGrants)
    .set({
      lastUsedAt: new Date(),
      useCount: row.useCount + 1,
    })
    .where(eq(scopedGrants.id, row.id));

  const grant = rowToRecord({ ...row, lastUsedAt: new Date(), useCount: row.useCount + 1 });
  const scopes: GrantScopeT[] = (row.scopes ?? []).filter((s): s is GrantScopeT => SCOPE_SET.has(s));
  return { grant, agentId: row.ownerAgentId, scopes };
}

export function grantHasScope(
  grant: GrantRecordT | ResolvedGrant | { scopes: GrantScopeT[] } | null | undefined,
  scope: GrantScopeT,
): boolean {
  if (!grant) return false;
  const scopes: GrantScopeT[] = "scopes" in grant
    ? (grant as { scopes: GrantScopeT[] }).scopes
    : (grant as ResolvedGrant).grant.scopes;
  return scopes.includes(scope);
}
