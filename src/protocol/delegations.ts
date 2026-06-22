import { z } from "zod";
import { IsoTimestamp, Uuid } from "./primitives.js";

export const DelegationStatus = z.enum(["open", "claimed", "revoked", "expired"]);
export type DelegationStatusT = z.infer<typeof DelegationStatus>;

export const CreateDelegationRequest = z.object({
  room_id: Uuid,
  task_id: Uuid.optional(),
  name: z.string().min(1).max(100),
  runtime: z.string().min(1).max(50).default("custom"),
  relationship: z.string().min(1).max(80).default("delegated_worker"),
  collaboration_role: z.string().min(1).max(100).optional(),
  ttl_seconds: z.number().int().positive().max(30 * 24 * 60 * 60).optional(),
  expires_at: IsoTimestamp.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateDelegationRequestT = z.infer<typeof CreateDelegationRequest>;

export const ClaimDelegationRequest = z.object({
  claim_token: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  owner: z.string().min(1).max(100).optional(),
  webhook_url: z.string().url().optional(),
  profile_role: z.string().min(1).max(200).optional(),
  runtime_session_ref: z.string().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ClaimDelegationRequestT = z.infer<typeof ClaimDelegationRequest>;

export const RevokeDelegationRequest = z.object({
  reason: z.string().max(500).optional(),
});
export type RevokeDelegationRequestT = z.infer<typeof RevokeDelegationRequest>;

export const DelegationRecord = z.object({
  id: Uuid,
  parent_agent_id: Uuid,
  child_agent_id: Uuid.nullable(),
  room_id: Uuid,
  task_id: Uuid.nullable(),
  relationship: z.string(),
  runtime: z.string(),
  name: z.string(),
  collaboration_role: z.string().nullable(),
  token_id: z.string(),
  status: DelegationStatus,
  expires_at: IsoTimestamp.nullable(),
  claimed_at: IsoTimestamp.nullable(),
  revoked_at: IsoTimestamp.nullable(),
  runtime_session_ref: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: IsoTimestamp,
});
export type DelegationRecordT = z.infer<typeof DelegationRecord>;

export const CreateDelegationResponse = z.object({
  delegation: DelegationRecord,
  claim_token: z.string().min(1),
  warning: z.string().optional(),
});
export type CreateDelegationResponseT = z.infer<typeof CreateDelegationResponse>;

export const ClaimDelegationResponse = z.object({
  delegation: DelegationRecord,
  agent: z.object({
    agent_id: Uuid,
    name: z.string(),
    owner: z.string().nullable().optional(),
    secret: z.string().min(1),
    pairing_code: z.string(),
    webhook_secret: z.string(),
    webhook_url: z.string().nullable().optional(),
  }),
});
export type ClaimDelegationResponseT = z.infer<typeof ClaimDelegationResponse>;

export const ListDelegationsResponse = z.object({
  delegations: z.array(DelegationRecord),
  count: z.number().int().nonnegative(),
});
export type ListDelegationsResponseT = z.infer<typeof ListDelegationsResponse>;
