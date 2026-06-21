import { z } from "zod";

/** ISO 8601 timestamp string. */
export const IsoTimestamp = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  { message: "must be a valid ISO 8601 timestamp" },
);

/** Hex string (used for agent id fragments, secrets, signatures). */
export const HexString = z.string().regex(/^[a-f0-9]+$/i, { message: "must be a hex string" });

/** Pairing code — 8 chars, no I/O/0/1. */
export const PairingCode = z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/, {
  message: "pairing code must be 8 chars (A-HJ-NP-Z2-9)",
});

/** UUID v4 string. */
export const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
  message: "must be a valid UUID",
});

/** Opaque cursor for cursor-paginated endpoints. */
export const Cursor = z.string().min(1);

/** Trunk scoped identifier (e.g., `workspace:abc`, `room:abc`, `contact:a-b`). */
export const ScopedId = z.string().min(1).max(256);

/** Recipient address — bare agent id or `workspace:<uuid>` / `room:<uuid>`. */
export const RecipientAddress = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => {
      if (value.startsWith("workspace:") || value.startsWith("room:")) {
        const id = value.slice(value.indexOf(":") + 1);
        return Uuid.safeParse(id).success;
      }
      return value.length > 0;
    },
    { message: "recipient must be agent id or workspace:<uuid> / room:<uuid>" },
  );

/** Free-form JSON value with size cap (10KB). */
export const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(10_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValue).max(200),
    z.record(z.string(), JsonValue),
  ]),
);

export const URGENCY_VALUES = ["sync", "async"] as const;
export const FINALITY_VALUES = ["proposed", "decided", "fyi"] as const;
export const PRIORITY_VALUES = ["critical", "high", "medium", "low"] as const;
export const TASK_STATUS_VALUES = ["open", "in-progress", "done", "blocked"] as const;
export const MESSAGE_STATUS_VALUES = [
  "pending",
  "delivered",
  "processed",
  "replied",
  "scheduled",
  "cancelled",
  "deleted",
  "undelivered",
] as const;
export const MESSAGE_TYPE_VALUES = [
  "question",
  "decision",
  "review",
  "handoff",
  "update",
  "ack",
] as const;

export const Urgency = z.enum(URGENCY_VALUES);
export const Finality = z.enum(FINALITY_VALUES);
export const Priority = z.enum(PRIORITY_VALUES);
export const TaskStatus = z.enum(TASK_STATUS_VALUES);
export const MessageStatus = z.enum(MESSAGE_STATUS_VALUES);
export const MessageType = z.enum(MESSAGE_TYPE_VALUES);

/** Structured error response used by every relay route. */
export const ApiError = z.object({
  error: z.string(),
  code: z.string().optional(),
  retry_after_seconds: z.number().int().nonnegative().optional(),
  current_version: z.number().int().nonnegative().optional(),
  member_count: z.number().int().nonnegative().optional(),
  message_id: z.string().optional(),
});
export type ApiErrorShape = z.infer<typeof ApiError>;

/** Generic paginated response envelope. */
export function paginatedResponse<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    messages: z.array(item),
    has_more: z.boolean().optional(),
    next_cursor: z.union([z.string(), z.null()]).optional(),
    total: z.number().int().nonnegative().optional(),
  });
}
