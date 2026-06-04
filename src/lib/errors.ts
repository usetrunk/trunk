import type { Context, MiddlewareHandler } from "hono";

/** Structured error codes used across the Trunk API */
export const ErrorCode = {
  // Validation
  VALIDATION_ERROR: "VALIDATION_ERROR",
  MISSING_FIELD: "MISSING_FIELD",
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_FIELD: "INVALID_FIELD",

  // Authentication / Authorization
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",

  // Not found
  NOT_FOUND: "NOT_FOUND",
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  CONTACT_NOT_FOUND: "CONTACT_NOT_FOUND",
  MESSAGE_NOT_FOUND: "MESSAGE_NOT_FOUND",
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TEMPLATE_NOT_FOUND: "TEMPLATE_NOT_FOUND",
  DOCUMENT_NOT_FOUND: "DOCUMENT_NOT_FOUND",
  ATTACHMENT_NOT_FOUND: "ATTACHMENT_NOT_FOUND",

  // Conflict / state
  ALREADY_EXISTS: "ALREADY_EXISTS",
  ALREADY_PAIRED: "ALREADY_PAIRED",
  ALREADY_MEMBER: "ALREADY_MEMBER",
  ALREADY_DELIVERED: "ALREADY_DELIVERED",
  SELF_ACTION: "SELF_ACTION",
  BLOCKED: "BLOCKED",

  // Business logic
  EDIT_WINDOW_EXPIRED: "EDIT_WINDOW_EXPIRED",
  NOT_OWNER: "NOT_OWNER",
  NOT_MEMBER: "NOT_MEMBER",
  INSUFFICIENT_ROLE: "INSUFFICIENT_ROLE",

  // Rate limiting
  RATE_LIMITED: "RATE_LIMITED",

  // Server
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true if the string is a valid UUID v4 format */
export function isValidUUID(s: string): boolean {
  return UUID_RE.test(s);
}

/** Middleware that validates named path params are valid UUIDs */
export function requireValidUUIDs(...paramNames: string[]): MiddlewareHandler {
  return async (c, next) => {
    for (const name of paramNames) {
      const value = c.req.param(name as never);
      if (value && !isValidUUID(value)) {
        return c.json({ error: `Invalid ${name} format`, code: "INVALID_INPUT" }, 400);
      }
    }
    await next();
  };
}

const MAX_METADATA_BYTES = 10_000;
const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_KEYS = 50;
const MAX_PAYLOAD_DEPTH = 10;

function jsonDepth(value: unknown, current = 0, limit = MAX_METADATA_DEPTH): number {
  if (current > limit) return current;
  if (typeof value !== "object" || value === null) return current;
  let max = current + 1;
  for (const v of Object.values(value)) {
    max = Math.max(max, jsonDepth(v, current + 1, limit));
    if (max > limit) return max;
  }
  return max;
}

/**
 * Validate metadata: must be a plain object, within size/depth/key limits.
 * Returns null if valid, or an error string if invalid.
 */
export function validateMetadata(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return "metadata must be a plain object";
  }
  const keys = Object.keys(metadata);
  if (keys.length > MAX_METADATA_KEYS) {
    return `metadata must have ${MAX_METADATA_KEYS} or fewer keys`;
  }
  if (jsonDepth(metadata) > MAX_METADATA_DEPTH) {
    return `metadata nesting must not exceed ${MAX_METADATA_DEPTH} levels`;
  }
  if (JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
    return "metadata must not exceed 10KB";
  }
  return null;
}

/**
 * Validate message payload: must be a plain object within depth limits.
 * Size is checked separately via payloadSizeBytes.
 * Returns null if valid, or an error string if invalid.
 */
export function validatePayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "payload must be a plain object";
  }
  if (jsonDepth(payload, 0, MAX_PAYLOAD_DEPTH) > MAX_PAYLOAD_DEPTH) {
    return `payload nesting must not exceed ${MAX_PAYLOAD_DEPTH} levels`;
  }
  return null;
}

/** Return a structured JSON error response */
export function apiError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
  code: ErrorCodeValue,
  error: string,
) {
  return c.json({ error, code }, status);
}
