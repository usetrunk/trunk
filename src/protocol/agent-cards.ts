import { z } from "zod";
import { Uuid, IsoTimestamp, HexString } from "./primitives.js";

/**
 * A2A-style Agent Card.
 *
 * This is a pragmatic, A2A-inspired subset: identity, ownership, declared
 * endpoints, capabilities, supported message types, and contact policy.
 * It is NOT a full A2A implementation — but the field names follow the
 * same conventions where reasonable so a future compliance pass is a
 * focused change.
 */
export const AgentCardProtocol = z.enum([
  "trunk/1",
  "trunk/1+grants",
  "a2a/0.3",
  "openrpc/1",
]);
export type AgentCardProtocolT = z.infer<typeof AgentCardProtocol>;

export const AgentCardEndpoint = z.object({
  type: z.enum(["http", "websocket", "webhook", "stdio", "grpc"]),
  url: z.string().min(1).max(500),
  description: z.string().max(200).optional(),
  auth: z.enum(["none", "bearer", "hmac", "mtls", "oidc"]).optional(),
});
export type AgentCardEndpointT = z.infer<typeof AgentCardEndpoint>;

export const AgentCardCapability = z.object({
  id: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});
export type AgentCardCapabilityT = z.infer<typeof AgentCardCapability>;

export const AgentCardContactPolicy = z.object({
  pairing_open: z.boolean().default(true),
  accepts_bearer: z.boolean().default(true),
  accepts_scoped_grants: z.boolean().default(true),
  contact_policy_url: z.string().url().optional(),
  privacy_url: z.string().url().optional(),
  rate_limit: z
    .object({
      requests_per_minute: z.number().int().positive().optional(),
      burst: z.number().int().positive().optional(),
    })
    .optional(),
});
export type AgentCardContactPolicyT = z.infer<typeof AgentCardContactPolicy>;

export const AgentCard = z.object({
  schema: z.literal("trunk.agent_card.v1"),
  agent_id: Uuid,
  name: z.string(),
  owner: z.string().nullable().optional(),
  description: z.string().max(2000).optional(),
  pairing_code: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/),
  protocol: z.array(AgentCardProtocol).min(1),
  version: z.string().min(1).max(40),
  homepage_url: z.string().url().optional(),
  documentation_url: z.string().url().optional(),
  repository_url: z.string().url().optional(),
  capabilities: z.array(AgentCardCapability).max(100),
  message_types: z.array(z.string()).max(50),
  endpoints: z.array(AgentCardEndpoint).max(20),
  contact_policy: AgentCardContactPolicy,
  metadata: z.record(z.string(), z.unknown()).optional(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
  signature: z
    .object({
      algorithm: z.literal("HMAC-SHA256"),
      value: HexString,
      key_id: z.string().optional(),
    })
    .optional(),
});
export type AgentCardT = z.infer<typeof AgentCard>;

export const UpsertAgentCardRequest = z.object({
  schema: z.literal("trunk.agent_card.v1").default("trunk.agent_card.v1"),
  description: z.string().max(2000).optional(),
  protocol: z.array(AgentCardProtocol).min(1).max(10).optional(),
  version: z.string().min(1).max(40).optional(),
  homepage_url: z.string().url().optional(),
  documentation_url: z.string().url().optional(),
  repository_url: z.string().url().optional(),
  capabilities: z.array(AgentCardCapability).max(100).optional(),
  message_types: z.array(z.string().max(50)).max(50).optional(),
  endpoints: z.array(AgentCardEndpoint).max(20).optional(),
  contact_policy: AgentCardContactPolicy.partial().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpsertAgentCardRequestT = z.infer<typeof UpsertAgentCardRequest>;

export const AgentCardResponse = z.object({
  card: AgentCard,
  signed: z.boolean(),
});
export type AgentCardResponseT = z.infer<typeof AgentCardResponse>;
