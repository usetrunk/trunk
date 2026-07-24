import { describe, expect, it } from "vitest";
import {
  auditReasonForResponse,
  buildAuditExplanation,
  normalizeProvenance,
  sanitizeAuditMetadata,
  type AuditEventDetails,
} from "../src/lib/audit.js";

describe("audit provenance contract", () => {
  it("removes credential material recursively while preserving safe context", () => {
    const grantSecret = `tg_public.${"a".repeat(64)}`;
    const claimToken = `td_public.${"b".repeat(64)}`;
    const agentSecret = "c".repeat(64);
    const databaseUrl = "postgresql://trunk:password@example.com/prod";

    const sanitized = sanitizeAuditMetadata({
      operation: "messages.send",
      secret: agentSecret,
      nested: {
        authorization: `Bearer ${grantSecret}`,
        claim_token: claimToken,
        database_url: databaseUrl,
        safe_id: "00000000-0000-0000-0000-000000000001",
      },
      values: [grantSecret, `accidentally pasted ${claimToken} into a reason`, "safe"],
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(grantSecret);
    expect(serialized).not.toContain(claimToken);
    expect(serialized).not.toContain(agentSecret);
    expect(serialized).not.toContain(databaseUrl);
    expect(sanitized).toMatchObject({
      operation: "messages.send",
      secret: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        claim_token: "[REDACTED]",
        database_url: "[REDACTED]",
        safe_id: "00000000-0000-0000-0000-000000000001",
      },
      values: ["[REDACTED]", "[REDACTED]", "safe"],
    });
  });

  it("normalizes typed message, task, fact, and document origins without duplicates", () => {
    expect(normalizeProvenance([
      { kind: "message", id: "message-1", relation: "origin" },
      { kind: "task", id: "task-1", relation: "origin" },
      { kind: "fact", id: "room:room-1:release.phase", relation: "input" },
      { kind: "document", id: "document-1", relation: "input" },
      { kind: "message", id: "message-1", relation: "origin" },
    ])).toEqual([
      { kind: "message", id: "message-1", relation: "origin" },
      { kind: "task", id: "task-1", relation: "origin" },
      { kind: "fact", id: "room:room-1:release.phase", relation: "input" },
      { kind: "document", id: "document-1", relation: "input" },
    ]);
  });

  it("uses stable authorization decision reason codes", () => {
    expect(auditReasonForResponse(201)).toEqual({
      outcome: "success",
      reasonCode: "AUTHORIZED",
    });
    expect(auditReasonForResponse(403, "INSUFFICIENT_SCOPE")).toEqual({
      outcome: "denied",
      reasonCode: "INSUFFICIENT_SCOPE",
    });
    expect(auditReasonForResponse(403, "untrusted free-form explanation")).toEqual({
      outcome: "denied",
      reasonCode: "FORBIDDEN",
    });
  });

  it("builds a human-readable explanation from structured audit fields", () => {
    const event: AuditEventDetails = {
      id: "audit-1",
      actorAgent: "child-agent",
      action: "authorization.decision",
      targetType: "room",
      targetId: "room-1",
      outcome: "denied",
      reasonCode: "INSUFFICIENT_SCOPE",
      credentialType: "scoped_grant",
      credentialId: "grant-1",
      delegationId: "delegation-1",
      parentAgentId: "parent-agent",
      requestId: "request-1",
      traceId: null,
      provenance: [
        { kind: "message", id: "message-1", relation: "origin" },
        { kind: "task", id: "task-1", relation: "origin" },
      ],
      metadata: { operation: "rooms.write" },
      createdAt: new Date("2026-07-24T12:00:00.000Z"),
    };

    const explanation = buildAuditExplanation(event);

    expect(explanation).toContain("denied");
    expect(explanation).toContain("INSUFFICIENT_SCOPE");
    expect(explanation).toContain("scoped grant grant-1");
    expect(explanation).toContain("delegated by parent-agent");
    expect(explanation).toContain("message message-1");
    expect(explanation).toContain("task task-1");
  });
});
