import { z } from "zod";
import {
  Uuid,
  RecipientAddress,
  MessageType,
  MessageStatus,
  Urgency,
  Finality,
  IsoTimestamp,
} from "./primitives.js";

export const MessagePayload = z
  .object({
    content: z.string().min(1),
    context: z.string().optional(),
    urgency: Urgency.optional(),
    finality: Finality.optional(),
    artifacts: z.array(z.string()).optional(),
    question: z.string().optional(),
    updates_facts: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type MessagePayloadT = z.infer<typeof MessagePayload>;

export const SendMessageRequest = z.object({
  to: RecipientAddress,
  type: MessageType.or(z.string().min(1).max(50)),
  payload: MessagePayload,
  thread_id: Uuid.optional(),
  reply_to: Uuid.optional(),
  idempotency_key: z.string().optional(),
  scheduled_at: IsoTimestamp.optional(),
  expires_at: IsoTimestamp.optional(),
  ttl_seconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
  attachment_ids: z.array(Uuid).max(20).optional(),
});
export type SendMessageRequestT = z.infer<typeof SendMessageRequest>;

export const MessageReceipt = z.object({
  id: Uuid,
  thread_id: Uuid.nullable(),
  status: MessageStatus,
  created_at: IsoTimestamp,
  recipients: z.number().int().nonnegative().optional(),
  scheduled_at: IsoTimestamp.optional(),
  expires_at: IsoTimestamp.nullable().optional(),
});
export type MessageReceiptT = z.infer<typeof MessageReceipt>;

export const TrunkMessage = z.object({
  id: Uuid,
  from_agent: Uuid,
  to_agent: Uuid,
  to_workspace: Uuid.nullable().optional(),
  to_room: Uuid.nullable().optional(),
  thread_id: Uuid.nullable(),
  reply_to: Uuid.nullable().optional(),
  idempotency_key: z.string().nullable().optional(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.string(),
  created_at: IsoTimestamp,
  read_at: IsoTimestamp.nullable().optional(),
  delivered_at: IsoTimestamp.nullable().optional(),
  processed_at: IsoTimestamp.nullable().optional(),
  replied_at: IsoTimestamp.nullable().optional(),
  deleted_at: IsoTimestamp.nullable().optional(),
  edited_at: IsoTimestamp.nullable().optional(),
  pinned_at: IsoTimestamp.nullable().optional(),
  pinned_by: Uuid.nullable().optional(),
  scheduled_at: IsoTimestamp.nullable().optional(),
  expires_at: IsoTimestamp.nullable().optional(),
});
export type TrunkMessageT = z.infer<typeof TrunkMessage>;
