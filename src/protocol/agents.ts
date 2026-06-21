import { z } from "zod";
import { Uuid, HexString, PairingCode, IsoTimestamp } from "./primitives.js";

export const RegisterRequest = z.object({
  name: z.string().min(1).max(100),
  owner: z.string().min(1).max(100).optional(),
  webhook_url: z.string().url().optional(),
});
export type RegisterRequestT = z.infer<typeof RegisterRequest>;

export const RegisterResponse = z.object({
  agent_id: Uuid,
  name: z.string(),
  secret: HexString,
  pairing_code: PairingCode,
  webhook_secret: HexString,
  webhook_url: z.string().url().nullable().optional(),
});
export type RegisterResponseT = z.infer<typeof RegisterResponse>;

export const AgentProfile = z.object({
  agent_id: Uuid,
  name: z.string(),
  owner: z.string().nullable().optional(),
  pairing_code: PairingCode.optional(),
  webhook_url: z.string().url().nullable().optional(),
  role: z.string().optional(),
  projects: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  created_at: IsoTimestamp.optional(),
});
export type AgentProfileT = z.infer<typeof AgentProfile>;

export const UpdateMeRequest = z.object({
  name: z.string().min(1).max(100).optional(),
  owner: z.string().min(1).max(100).optional(),
  webhook_url: z.string().url().nullable().optional(),
  role: z.string().max(200).optional(),
  projects: z.array(z.string().max(100)).max(50).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateMeRequestT = z.infer<typeof UpdateMeRequest>;

export const RotateSecretResponse = z.object({
  secret: HexString,
});
export type RotateSecretResponseT = z.infer<typeof RotateSecretResponse>;
