import { and, desc, eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentDelegations, agents, contacts, roomMembers, rooms, tasks } from "../db/schema.js";
import { generatePairingCode, generateSecret, hashSecretAsync } from "./auth.js";
import { validateMetadata } from "./errors.js";
import { validateWebhookUrl } from "./ssrf.js";
import {
  ClaimDelegationRequest,
  CreateDelegationRequest,
  type ClaimDelegationRequestT,
  type ClaimDelegationResponseT,
  type CreateDelegationRequestT,
  type CreateDelegationResponseT,
  type DelegationRecordT,
} from "../protocol/delegations.js";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const TOKEN_PREFIX = "td_";

export class DelegationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "DelegationError";
    this.status = status;
    this.code = code;
  }
}

export function delegationToRecord(row: typeof agentDelegations.$inferSelect): DelegationRecordT {
  const isExpired = row.status === "open" && row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
  return {
    id: row.id,
    parent_agent_id: row.parentAgentId,
    child_agent_id: row.childAgentId ?? null,
    room_id: row.roomId,
    task_id: row.taskId ?? null,
    relationship: row.relationship,
    runtime: row.runtime,
    name: row.name,
    collaboration_role: row.collaborationRole ?? null,
    token_id: row.tokenId,
    status: isExpired ? "expired" : row.status as DelegationRecordT["status"],
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    claimed_at: row.claimedAt ? row.claimedAt.toISOString() : null,
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
    runtime_session_ref: row.runtimeSessionRef ?? null,
    metadata: row.metadata ?? {},
    created_at: row.createdAt.toISOString(),
  };
}

export async function createDelegation(
  parentAgentId: string,
  input: CreateDelegationRequestT,
): Promise<CreateDelegationResponseT> {
  const parsed = CreateDelegationRequest.safeParse(input);
  if (!parsed.success) {
    throw new DelegationError(parsed.error.message, 400);
  }
  const data = parsed.data;

  if (data.metadata !== undefined) {
    const metadataError = validateMetadata(data.metadata);
    if (metadataError) throw new DelegationError(metadataError, 400, "INVALID_FIELD");
  }
  if (data.expires_at && data.ttl_seconds) {
    throw new DelegationError("Use either expires_at or ttl_seconds, not both", 400, "INVALID_FIELD");
  }

  const [room] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, data.room_id)).limit(1);
  if (!room) throw new DelegationError("Room not found", 404, "ROOM_NOT_FOUND");

  const [membership] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, data.room_id), eq(roomMembers.agentId, parentAgentId)))
    .limit(1);
  if (!membership) throw new DelegationError("Parent agent is not a member of this room", 403, "NOT_MEMBER");

  if (data.task_id) {
    const [task] = await db
      .select({ id: tasks.id, scope: tasks.scope })
      .from(tasks)
      .where(eq(tasks.id, data.task_id))
      .limit(1);
    if (!task || task.scope !== `room:${data.room_id}`) {
      throw new DelegationError("task_id must belong to the delegated room", 400, "INVALID_FIELD");
    }
  }

  const tokenId = `${TOKEN_PREFIX}${generateSecret().slice(0, 24)}`;
  const secretMaterial = generateSecret();
  const claimToken = `${tokenId}.${secretMaterial}`;
  const tokenHash = await hashSecretAsync(claimToken);
  const expiresAt = data.expires_at
    ? new Date(data.expires_at)
    : new Date(Date.now() + (data.ttl_seconds ?? DEFAULT_TTL_SECONDS) * 1000);

  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new DelegationError("expires_at must be in the future", 400, "INVALID_FIELD");
  }

  const [row] = await db.insert(agentDelegations).values({
    parentAgentId,
    roomId: data.room_id,
    taskId: data.task_id ?? null,
    relationship: data.relationship,
    runtime: data.runtime,
    name: data.name,
    collaborationRole: data.collaboration_role ?? null,
    tokenHash,
    tokenId,
    expiresAt,
    metadata: data.metadata ?? {},
  }).returning();

  return {
    delegation: delegationToRecord(row),
    claim_token: claimToken,
    warning: "Save this claim token now. It is returned once and becomes invalid after claim, revoke, or expiry.",
  };
}

export async function listDelegations(
  agentId: string,
  filters: { room_id?: string } = {},
): Promise<DelegationRecordT[]> {
  const baseCondition = or(
    eq(agentDelegations.parentAgentId, agentId),
    eq(agentDelegations.childAgentId, agentId),
  );
  const condition = filters.room_id
    ? and(baseCondition, eq(agentDelegations.roomId, filters.room_id))
    : baseCondition;

  const rows = await db
    .select()
    .from(agentDelegations)
    .where(condition)
    .orderBy(desc(agentDelegations.createdAt))
    .limit(100);
  return rows.map(delegationToRecord);
}

export async function listRoomDelegations(roomId: string): Promise<DelegationRecordT[]> {
  const rows = await db
    .select()
    .from(agentDelegations)
    .where(eq(agentDelegations.roomId, roomId))
    .orderBy(desc(agentDelegations.createdAt))
    .limit(100);
  return rows.map(delegationToRecord);
}

export async function claimDelegation(input: ClaimDelegationRequestT): Promise<ClaimDelegationResponseT> {
  const parsed = ClaimDelegationRequest.safeParse(input);
  if (!parsed.success) {
    throw new DelegationError(parsed.error.message, 400);
  }
  const data = parsed.data;

  if (!data.claim_token.startsWith(TOKEN_PREFIX) || !data.claim_token.includes(".")) {
    throw new DelegationError("Invalid claim token", 401, "UNAUTHORIZED");
  }
  if (data.metadata !== undefined) {
    const metadataError = validateMetadata(data.metadata);
    if (metadataError) throw new DelegationError(metadataError, 400, "INVALID_FIELD");
  }
  if (data.webhook_url) {
    const urlError = validateWebhookUrl(data.webhook_url);
    if (urlError) throw new DelegationError(urlError, 400, urlError.includes("private") ? "SSRF_BLOCKED" : "INVALID_FIELD");
  }

  const tokenHash = await hashSecretAsync(data.claim_token);
  const [existing] = await db
    .select()
    .from(agentDelegations)
    .where(eq(agentDelegations.tokenHash, tokenHash))
    .limit(1);

  if (!existing) throw new DelegationError("Invalid claim token", 401, "UNAUTHORIZED");
  if (existing.status === "claimed" || existing.childAgentId) {
    throw new DelegationError("Delegation already claimed", 409, "DELEGATION_CLAIMED");
  }
  if (existing.status === "revoked" || existing.revokedAt) {
    throw new DelegationError("Delegation revoked", 409, "DELEGATION_REVOKED");
  }
  if (existing.expiresAt && existing.expiresAt.getTime() <= Date.now()) {
    await db.update(agentDelegations).set({ status: "expired" }).where(eq(agentDelegations.id, existing.id));
    throw new DelegationError("Delegation expired", 409, "DELEGATION_EXPIRED");
  }

  const childSecret = generateSecret();
  const childSecretHash = await hashSecretAsync(childSecret);
  const pairingCode = generatePairingCode();
  const webhookSecret = generateSecret();
  const childName = data.name ?? existing.name;
  const childMetadata = {
    ...(data.metadata ?? {}),
    role: data.profile_role ?? `delegated ${existing.runtime} subagent`,
    parent_agent_id: existing.parentAgentId,
    delegation_id: existing.id,
    relationship: existing.relationship,
    runtime: existing.runtime,
    room_id: existing.roomId,
    task_id: existing.taskId ?? undefined,
    runtime_session_ref: data.runtime_session_ref ?? undefined,
  };

  return await db.transaction(async (tx) => {
    const [child] = await tx.insert(agents).values({
      name: childName,
      owner: data.owner ?? null,
      secretHash: childSecretHash,
      pairingCode,
      webhookUrl: data.webhook_url ?? null,
      webhookSecret,
      metadata: childMetadata,
    }).returning();

    await tx.insert(roomMembers).values({
      roomId: existing.roomId,
      agentId: child.id,
      role: "member",
      collaborationRole: existing.collaborationRole ?? null,
    });

    const existingContact = await tx
      .select()
      .from(contacts)
      .where(or(
        and(eq(contacts.agentA, existing.parentAgentId), eq(contacts.agentB, child.id)),
        and(eq(contacts.agentA, child.id), eq(contacts.agentB, existing.parentAgentId)),
      ))
      .limit(1);
    if (existingContact.length === 0) {
      await tx.insert(contacts).values({
        agentA: existing.parentAgentId,
        agentB: child.id,
        aliasB: existing.name,
      });
    }

    const [updated] = await tx.update(agentDelegations).set({
      childAgentId: child.id,
      status: "claimed",
      claimedAt: new Date(),
      runtimeSessionRef: data.runtime_session_ref ?? null,
      metadata: {
        ...(existing.metadata ?? {}),
        claim_metadata: data.metadata ?? {},
      },
    }).where(eq(agentDelegations.id, existing.id)).returning();

    return {
      delegation: delegationToRecord(updated),
      agent: {
        agent_id: child.id,
        name: child.name,
        owner: child.owner ?? null,
        secret: childSecret,
        pairing_code: child.pairingCode,
        webhook_secret: webhookSecret,
        webhook_url: child.webhookUrl ?? null,
      },
    };
  });
}

export async function revokeDelegation(
  agentId: string,
  delegationId: string,
  reason?: string,
): Promise<DelegationRecordT> {
  const [existing] = await db
    .select()
    .from(agentDelegations)
    .where(and(eq(agentDelegations.id, delegationId), eq(agentDelegations.parentAgentId, agentId)))
    .limit(1);

  if (!existing) throw new DelegationError("Delegation not found", 404, "NOT_FOUND");
  if (existing.status === "claimed") {
    throw new DelegationError("Claimed delegations cannot be revoked", 409, "DELEGATION_CLAIMED");
  }

  const [updated] = await db.update(agentDelegations).set({
    status: "revoked",
    revokedAt: new Date(),
    metadata: {
      ...(existing.metadata ?? {}),
      revoked_reason: reason ?? null,
    },
  }).where(eq(agentDelegations.id, delegationId)).returning();

  return delegationToRecord(updated);
}
