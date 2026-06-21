import { z } from "zod";
import { Uuid, ScopedId, IsoTimestamp } from "./primitives.js";

export const FactKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/, { message: "fact key must match [a-zA-Z0-9_.:-]" });

export const FactValue = z.unknown();

export const PutFactRequest = z.object({
  value: FactValue,
  reason: z.string().max(500).optional(),
  source_message_id: Uuid.optional(),
  source_thread_id: Uuid.optional(),
});
export type PutFactRequestT = z.infer<typeof PutFactRequest>;

export const FactRecord = z.object({
  key: FactKey,
  value: FactValue,
  version: z.number().int().nonnegative(),
  updated_by: Uuid,
  updated_at: IsoTimestamp,
  set_by: Uuid.optional(),
  reason: z.string().nullable().optional(),
  source_message_id: Uuid.nullable().optional(),
  source_thread_id: Uuid.nullable().optional(),
  superseded_by: z.string().nullable().optional(),
});
export type FactRecordT = z.infer<typeof FactRecord>;

export const FactHistoryEntry = z.object({
  version: z.number().int().nonnegative(),
  value: FactValue,
  set_by: Uuid,
  set_at: IsoTimestamp,
  reason: z.string().nullable().optional(),
  source_message_id: Uuid.nullable().optional(),
  source_thread_id: Uuid.nullable().optional(),
  superseded_at: IsoTimestamp.nullable().optional(),
  superseded_by: Uuid.nullable().optional(),
});
export type FactHistoryEntryT = z.infer<typeof FactHistoryEntry>;

export const ListFactsResponse = z.object({
  facts: z.array(FactRecord),
  scope: ScopedId.optional(),
  count: z.number().int().nonnegative(),
});
export type ListFactsResponseT = z.infer<typeof ListFactsResponse>;

export const FactHistoryResponse = z.object({
  scope: ScopedId,
  key: FactKey,
  current: FactRecord.nullable(),
  history: z.array(FactHistoryEntry),
  count: z.number().int().nonnegative(),
});
export type FactHistoryResponseT = z.infer<typeof FactHistoryResponse>;
