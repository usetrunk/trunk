import { z } from "zod";
import { Uuid, IsoTimestamp, ScopedId } from "./primitives.js";

export const GRANT_SCOPES = [
  "messages:send",
  "messages:read",
  "facts:read",
  "facts:write",
  "tasks:read",
  "tasks:write",
  "rooms:read",
  "rooms:write",
  "contacts:read",
  "workspaces:read",
  "agent_card:read",
] as const;

export const GrantScope = z.enum(GRANT_SCOPES);
export type GrantScopeT = z.infer<typeof GrantScope>;

export const CreateGrantRequest = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  scopes: z.array(GrantScope).min(1).max(20),
  expires_at: IsoTimestamp.optional(),
  not_before: IsoTimestamp.optional(),
  audience_agent_id: Uuid.optional(),
  audience_workspace_id: Uuid.optional(),
  room_id: Uuid.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateGrantRequestT = z.infer<typeof CreateGrantRequest>;

export const GrantRecord = z.object({
  id: Uuid,
  owner_agent_id: Uuid,
  name: z.string(),
  description: z.string().nullable().optional(),
  token_id: z.string(),
  scopes: z.array(GrantScope),
  expires_at: IsoTimestamp.nullable().optional(),
  not_before: IsoTimestamp.nullable().optional(),
  audience: z
    .object({
      agent_id: Uuid.optional(),
      workspace_id: Uuid.optional(),
      room_id: Uuid.optional(),
    })
    .optional(),
  revoked: z.boolean(),
  revoked_at: IsoTimestamp.nullable().optional(),
  revoked_reason: z.string().nullable().optional(),
  last_used_at: IsoTimestamp.nullable().optional(),
  use_count: z.number().int().nonnegative(),
  created_at: IsoTimestamp,
  created_by: Uuid.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type GrantRecordT = z.infer<typeof GrantRecord>;

export const CreateGrantResponse = z.object({
  grant: GrantRecord,
  secret: z.string().min(1),
  warning: z.string().optional(),
});
export type CreateGrantResponseT = z.infer<typeof CreateGrantResponse>;

export const ListGrantsResponse = z.object({
  grants: z.array(GrantRecord),
  count: z.number().int().nonnegative(),
});
export type ListGrantsResponseT = z.infer<typeof ListGrantsResponse>;

export const RevokeGrantRequest = z.object({
  reason: z.string().max(500).optional(),
});
export type RevokeGrantRequestT = z.infer<typeof RevokeGrantRequest>;

export const AuthScheme = z.enum(["bearer", "grant"]);
export type AuthSchemeT = z.infer<typeof AuthScheme>;

export const AuthContext = z.object({
  scheme: AuthScheme,
  agent_id: Uuid,
  grant_id: Uuid.nullable().optional(),
  scopes: z.array(GrantScope).optional(),
  audience: z
    .object({
      agent_id: Uuid.optional(),
      workspace_id: Uuid.optional(),
      room_id: Uuid.optional(),
    })
    .optional(),
  scope: ScopedId.optional(),
});
export type AuthContextT = z.infer<typeof AuthContext>;
