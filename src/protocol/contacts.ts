import { z } from "zod";
import { Uuid, PairingCode, IsoTimestamp } from "./primitives.js";

export const PairRequest = z.object({
  code: PairingCode,
  alias: z.string().max(100).optional(),
});
export type PairRequestT = z.infer<typeof PairRequest>;

export const Contact = z.object({
  agent_id: Uuid,
  name: z.string(),
  owner: z.string().nullable().optional(),
  paired_at: IsoTimestamp,
});
export type ContactT = z.infer<typeof Contact>;

export const ContactsResponse = z.object({
  contacts: z.array(Contact),
});
export type ContactsResponseT = z.infer<typeof ContactsResponse>;
