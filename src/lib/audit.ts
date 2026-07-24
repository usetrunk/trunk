import { AsyncLocalStorage } from "node:async_hooks";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentDelegations, auditEvents } from "../db/schema.js";

export const AUDIT_OUTCOMES = ["success", "denied", "failure"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_REASON_CODES = [
  "AUTHORIZED",
  "ACTION_COMPLETED",
  "ACTION_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_CREDENTIAL",
  "GRANT_ACTION_NOT_ALLOWED",
  "INSUFFICIENT_SCOPE",
  "AUDIENCE_MISMATCH",
  "DELEGATION_ACTION_NOT_ALLOWED",
  "DELEGATION_SCOPE_MISMATCH",
  "DELEGATION_PRIVILEGE_ESCALATION",
  "NOT_MEMBER",
  "NOT_OWNER",
  "INSUFFICIENT_ROLE",
  "BLOCKED",
] as const;
export type AuditReasonCode = (typeof AUDIT_REASON_CODES)[number];

export const AUDIT_CREDENTIAL_TYPES = [
  "agent_secret",
  "scoped_grant",
  "delegation_claim",
  "webhook_signature",
  "system",
  "anonymous",
] as const;
export type AuditCredentialType = (typeof AUDIT_CREDENTIAL_TYPES)[number];

export const AUDIT_PROVENANCE_KINDS = ["message", "task", "fact", "document"] as const;
export type AuditProvenanceKind = (typeof AUDIT_PROVENANCE_KINDS)[number];

export const AUDIT_PROVENANCE_RELATIONS = ["origin", "input", "target", "derived_from"] as const;
export type AuditProvenanceRelation = (typeof AUDIT_PROVENANCE_RELATIONS)[number];

export type AuditProvenanceReference = {
  kind: AuditProvenanceKind;
  id: string;
  relation: AuditProvenanceRelation;
};

export type AuditEventDetails = {
  id: string;
  actorAgent: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: AuditOutcome;
  reasonCode: AuditReasonCode;
  credentialType: AuditCredentialType;
  credentialId: string | null;
  delegationId: string | null;
  parentAgentId: string | null;
  requestId: string;
  traceId: string | null;
  provenance: AuditProvenanceReference[];
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type AuditExecutionContext = {
  credentialType: AuditCredentialType;
  credentialId: string | null;
  delegationId: string | null;
  parentAgentId: string | null;
  requestId: string;
  traceId: string | null;
  provenance: AuditProvenanceReference[];
};

export type AuditCredentialContext = {
  agentId: string;
  grant?: { id: string };
  delegation?: { id: string; parentAgentId: string };
};

export type AuditWriteOptions = {
  outcome?: AuditOutcome;
  reasonCode?: AuditReasonCode;
  credentialType?: AuditCredentialType;
  credentialId?: string | null;
  delegationId?: string | null;
  parentAgentId?: string | null;
  requestId?: string;
  traceId?: string | null;
  provenance?: AuditProvenanceReference[];
};

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|secret|token|password|passphrase|api[_-]?key|private[_-]?key|database[_-]?url|connection[_-]?string|signature)(?:$|[_-])/i;
const BEARER_SECRET = /Bearer\s+\S+/i;
const TRUNK_TOKEN = /(?:tg|td)_[A-Za-z0-9_-]+\.[A-Za-z0-9._~-]+/;
const AGENT_SECRET = /(?:^|[^a-f0-9])[a-f0-9]{64}(?:$|[^a-f0-9])/i;
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const CREDENTIAL_QUERY = /[?&](?:access_token|token|secret|api[_-]?key|key)=[^&#\s]+/i;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;
const REASON_CODE_SET = new Set<string>(AUDIT_REASON_CODES);
const PROVENANCE_KIND_SET = new Set<string>(AUDIT_PROVENANCE_KINDS);
const PROVENANCE_RELATION_SET = new Set<string>(AUDIT_PROVENANCE_RELATIONS);
const auditContext = new AsyncLocalStorage<AuditExecutionContext>();

/**
 * Audit metadata is allowably descriptive but never a credential transport.
 * Redaction is recursive and defensive because several existing call sites
 * accept adapter metadata from outside the relay.
 */
export function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const sanitized = sanitizeAuditValue(metadata, seen, 0);
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizeAuditValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return isSecretValue(value) ? REDACTED : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return value.slice(0, 100).map((entry) => sanitizeAuditValue(entry, seen, depth + 1));
  }
  if (!isRecord(value)) return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    result[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : sanitizeAuditValue(entry, seen, depth + 1);
  }
  return result;
}

function isSecretValue(value: string): boolean {
  return BEARER_SECRET.test(value)
    || TRUNK_TOKEN.test(value)
    || AGENT_SECRET.test(value)
    || CREDENTIAL_URL.test(value)
    || CREDENTIAL_QUERY.test(value)
    || PRIVATE_KEY.test(value);
}

export function normalizeProvenance(
  references: ReadonlyArray<AuditProvenanceReference | null | undefined>,
): AuditProvenanceReference[] {
  const normalized: AuditProvenanceReference[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    if (!reference
      || !PROVENANCE_KIND_SET.has(reference.kind)
      || !PROVENANCE_RELATION_SET.has(reference.relation)
      || typeof reference.id !== "string"
      || reference.id.length === 0
      || reference.id.length > 500
    ) {
      continue;
    }
    const key = `${reference.kind}\u0000${reference.id}\u0000${reference.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...reference });
    if (normalized.length === 32) break;
  }
  return normalized;
}

export function auditReasonForResponse(
  status: number,
  responseCode?: string | null,
): { outcome: AuditOutcome; reasonCode: AuditReasonCode } {
  if (status === 401) {
    return {
      outcome: "denied",
      reasonCode: responseCode === "INVALID_CREDENTIAL" ? "INVALID_CREDENTIAL" : "UNAUTHORIZED",
    };
  }
  if (status === 403) {
    return {
      outcome: "denied",
      reasonCode: REASON_CODE_SET.has(responseCode ?? "")
        ? responseCode as AuditReasonCode
        : "FORBIDDEN",
    };
  }
  return { outcome: "success", reasonCode: "AUTHORIZED" };
}

export function buildAuditExplanation(event: AuditEventDetails): string {
  const actor = event.actorAgent ?? "an unauthenticated actor";
  const target = event.targetId
    ? `${event.targetType} ${event.targetId}`
    : event.targetType;
  const credential = event.credentialType === "scoped_grant"
    ? `scoped grant ${event.credentialId ?? "unknown"}`
    : event.credentialType.replaceAll("_", " ");
  const delegation = event.parentAgentId
    ? `, delegated by ${event.parentAgentId}`
    : "";
  const provenance = event.provenance.length > 0
    ? ` Origins: ${event.provenance.map((reference) => `${reference.kind} ${reference.id} (${reference.relation})`).join(", ")}.`
    : "";
  return `${actor} ${event.outcome} ${event.action} on ${target} using ${credential}${delegation}; reason ${event.reasonCode}; request ${event.requestId}.${provenance}`;
}

export async function createAuditExecutionContext(
  credential: AuditCredentialContext,
  input: {
    requestId?: string | null;
    traceId?: string | null;
    provenance?: AuditProvenanceReference[];
  } = {},
): Promise<AuditExecutionContext> {
  let delegationId = credential.delegation?.id ?? null;
  let parentAgentId = credential.delegation?.parentAgentId ?? null;
  if (!delegationId) {
    const [delegation] = await db
      .select()
      .from(agentDelegations)
      .where(eq(agentDelegations.childAgentId, credential.agentId))
      .orderBy(desc(agentDelegations.createdAt))
      .limit(1);
    if (delegation?.status === "claimed") {
      delegationId = delegation.id;
      parentAgentId = delegation.parentAgentId;
    }
  }

  return {
    credentialType: credential.grant ? "scoped_grant" : "agent_secret",
    credentialId: credential.grant?.id ?? credential.agentId,
    delegationId,
    parentAgentId,
    requestId: validCorrelationId(input.requestId) ?? crypto.randomUUID(),
    traceId: validTraceId(input.traceId),
    provenance: normalizeProvenance(input.provenance ?? []),
  };
}

export function createAnonymousAuditExecutionContext(
  input: {
    requestId?: string | null;
    traceId?: string | null;
    provenance?: AuditProvenanceReference[];
  } = {},
): AuditExecutionContext {
  return {
    credentialType: "anonymous",
    credentialId: null,
    delegationId: null,
    parentAgentId: null,
    requestId: validCorrelationId(input.requestId) ?? crypto.randomUUID(),
    traceId: validTraceId(input.traceId),
    provenance: normalizeProvenance(input.provenance ?? []),
  };
}

export function runWithAuditContext<T>(
  context: AuditExecutionContext,
  callback: () => T,
): T {
  return auditContext.run(context, callback);
}

export function currentAuditContext(): AuditExecutionContext | undefined {
  return auditContext.getStore();
}

export function provenanceFromRequest(request: Request): AuditProvenanceReference[] {
  const references: AuditProvenanceReference[] = [];
  addHeaderReference(references, request, "Trunk-Origin-Message-Id", "message");
  addHeaderReference(references, request, "Trunk-Origin-Task-Id", "task");
  addHeaderReference(references, request, "Trunk-Origin-Fact-Id", "fact");
  addHeaderReference(references, request, "Trunk-Origin-Document-Id", "document");
  return normalizeProvenance(references);
}

export function provenanceFromMcpArguments(args: Record<string, unknown>): AuditProvenanceReference[] {
  return normalizeProvenance([
    referenceFromString("message", args.source_message_id ?? args.message_id, "origin"),
    referenceFromString("task", args.source_task_id ?? args.task_id, "origin"),
    referenceFromString("fact", args.source_fact_id, "input"),
    referenceFromString("document", args.source_document_id ?? args.doc_id, "input"),
  ]);
}

export function traceIdFromRequest(request: Request): string | null {
  const traceparent = request.headers.get("traceparent");
  if (!traceparent) return null;
  const match = traceparent.match(/^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}(?:-|$)/i);
  return validTraceId(match?.[1]);
}

export async function recordAuthorizationDecision(input: {
  actorAgent: string | null;
  outcome: AuditOutcome;
  reasonCode: AuditReasonCode;
  targetType: string;
  targetId?: string | null;
  surface: "http" | "mcp";
  operation: string;
  scope?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await audit(
    input.actorAgent,
    "authorization.decision",
    input.targetType,
    input.targetId ?? null,
    {
      surface: input.surface,
      operation: input.operation,
      scope: input.scope ?? undefined,
      ...(input.metadata ?? {}),
    },
    { outcome: input.outcome, reasonCode: input.reasonCode },
  );
}

export async function audit(
  actorAgent: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown> = {},
  options: AuditWriteOptions = {},
): Promise<void> {
  const context = auditContext.getStore();
  const provenance = normalizeProvenance([
    ...(context?.provenance ?? []),
    ...(options.provenance ?? []),
    ...inferProvenance(targetType, targetId, metadata),
  ]);
  await db.insert(auditEvents).values({
    actorAgent: actorAgent ?? undefined,
    action,
    targetType,
    targetId: targetId ?? undefined,
    outcome: options.outcome ?? "success",
    reasonCode: options.reasonCode ?? "ACTION_COMPLETED",
    credentialType: options.credentialType ?? context?.credentialType ?? "system",
    credentialId: options.credentialId ?? context?.credentialId ?? undefined,
    delegationId: options.delegationId ?? context?.delegationId ?? undefined,
    parentAgentId: options.parentAgentId ?? context?.parentAgentId ?? undefined,
    requestId: options.requestId ?? context?.requestId ?? crypto.randomUUID(),
    traceId: options.traceId ?? context?.traceId ?? undefined,
    provenance,
    metadata: sanitizeAuditMetadata(metadata),
  });
}

function inferProvenance(
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown>,
): AuditProvenanceReference[] {
  const references: Array<AuditProvenanceReference | null> = [];
  if (targetId) {
    if (targetType === "message") references.push({ kind: "message", id: targetId, relation: "target" });
    if (targetType === "task") references.push({ kind: "task", id: targetId, relation: "target" });
    if (targetType === "shared_fact") references.push({ kind: "fact", id: targetId, relation: "target" });
    if (targetType === "shared_document") references.push({ kind: "document", id: targetId, relation: "target" });
  }
  references.push(
    referenceFromString("message", metadata.source_message_id ?? metadata.original_message_id ?? metadata.reply_to, "origin"),
    referenceFromString("task", metadata.source_task_id ?? metadata.task_id, "origin"),
    referenceFromString("fact", metadata.source_fact_id, "input"),
    referenceFromString("document", metadata.source_document_id ?? metadata.document_id, "input"),
  );
  return normalizeProvenance(references);
}

function addHeaderReference(
  references: AuditProvenanceReference[],
  request: Request,
  header: string,
  kind: AuditProvenanceKind,
): void {
  const id = request.headers.get(header);
  if (id && id.length <= 500 && !isSecretValue(id)) {
    references.push({ kind, id, relation: kind === "message" || kind === "task" ? "origin" : "input" });
  }
}

function referenceFromString(
  kind: AuditProvenanceKind,
  value: unknown,
  relation: AuditProvenanceRelation,
): AuditProvenanceReference | null {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && !isSecretValue(value)
    ? { kind, id: value, relation }
    : null;
}

function validCorrelationId(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function validTraceId(value: string | null | undefined): string | null {
  return value && /^[a-f0-9]{32}$/i.test(value) && !/^0+$/.test(value) ? value.toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
