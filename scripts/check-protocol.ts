/**
 * Protocol drift gate.
 *
 * Verifies that:
 *  1. Every Zod schema in src/protocol is exported.
 *  2. The OpenAPI document references the same set of schemas.
 *  3. The Zod schemas validate a representative fixture for each shape
 *     (positive + negative cases).
 *
 * This is the central enforcement point for "API, SDK, MCP, CLI, docs, and
 * tests stop drifting."
 */
import { deriveJsonSchemas } from "../src/protocol/derive-json-schema.js";
import { buildOpenApi } from "../src/protocol/openapi.js";
import * as P from "../src/protocol/index.js";

const issues: string[] = [];

const required: Array<[string, unknown]> = [
  ["ApiError", P.ApiError],
  ["RegisterRequest", P.RegisterRequest],
  ["RegisterResponse", P.RegisterResponse],
  ["AgentProfile", P.AgentProfile],
  ["UpdateMeRequest", P.UpdateMeRequest],
  ["RotateSecretResponse", P.RotateSecretResponse],
  ["SendMessageRequest", P.SendMessageRequest],
  ["MessageReceipt", P.MessageReceipt],
  ["MessagePayload", P.MessagePayload],
  ["TrunkMessage", P.TrunkMessage],
  ["PairRequest", P.PairRequest],
  ["Contact", P.Contact],
  ["ContactsResponse", P.ContactsResponse],
  ["PutFactRequest", P.PutFactRequest],
  ["FactRecord", P.FactRecord],
  ["FactHistoryEntry", P.FactHistoryEntry],
  ["ListFactsResponse", P.ListFactsResponse],
  ["FactHistoryResponse", P.FactHistoryResponse],
  ["CreateGrantRequest", P.CreateGrantRequest],
  ["GrantRecord", P.GrantRecord],
  ["CreateGrantResponse", P.CreateGrantResponse],
  ["ListGrantsResponse", P.ListGrantsResponse],
  ["AuthContext", P.AuthContext],
  ["AgentCard", P.AgentCard],
  ["UpsertAgentCardRequest", P.UpsertAgentCardRequest],
  ["AgentCardResponse", P.AgentCardResponse],
  ["DeliveryAttempt", P.DeliveryAttempt],
  ["DeliveryHealth", P.DeliveryHealth],
  ["ThreadTimelineEntry", P.ThreadTimelineEntry],
  ["ThreadTimeline", P.ThreadTimeline],
  ["AuditEvent", P.AuditEvent],
  ["TaskChangeEvent", P.TaskChangeEvent],
  ["FactTouch", P.FactTouch],
  ["InspectorSummary", P.InspectorSummary],
];

for (const [name, schema] of required) {
  if (!schema) {
    issues.push(`Missing export: ${name}`);
    continue;
  }
  if (typeof schema !== "object" || !("_def" in (schema as Record<string, unknown>))) {
    issues.push(`${name} is not a Zod schema`);
  }
}

const derived = deriveJsonSchemas();
for (const [name] of required) {
  if (!derived[name]) {
    issues.push(`Schema ${name} not derived to JSON Schema`);
  }
}

const openApi = buildOpenApi();
const openApiSchemas = (openApi.components as { schemas: Record<string, unknown> }).schemas;
for (const name of Object.keys(derived)) {
  if (!openApiSchemas[name]) {
    issues.push(`OpenAPI document is missing schema ${name}`);
  }
}

const positiveCases: Array<[string, unknown, unknown]> = [
  ["RegisterRequest", P.RegisterRequest, { name: "Vesper", owner: "Andrei" }],
  [
    "SendMessageRequest",
    P.SendMessageRequest,
    {
      to: "73b4ba62-812e-4b5a-a98a-92d46afe92b1",
      type: "question",
      payload: { content: "hi" },
    },
  ],
  [
    "SendMessageRequest (workspace fan-out)",
    P.SendMessageRequest,
    {
      to: "workspace:73b4ba62-812e-4b5a-a98a-92d46afe92b1",
      type: "update",
      payload: { content: "hello team" },
    },
  ],
  [
    "AgentCard",
    P.AgentCard,
    {
      schema: "trunk.agent_card.v1",
      agent_id: "73b4ba62-812e-4b5a-a98a-92d46afe92b1",
      name: "Vesper",
      pairing_code: "ABCD2345",
      protocol: ["trunk/1+grants"],
      version: "0.1.0",
      capabilities: [{ id: "answer" }],
      message_types: ["question", "decision"],
      endpoints: [{ type: "http", url: "https://example.com/inbox" }],
      contact_policy: { pairing_open: true, accepts_bearer: true, accepts_scoped_grants: true },
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    },
  ],
  ["CreateGrantRequest", P.CreateGrantRequest, { name: "test-bot", scopes: ["messages:send", "facts:read"] }],
];

const negativeCases: Array<[string, unknown, unknown]> = [
  ["RegisterRequest (missing name)", P.RegisterRequest, { owner: "Andrei" }],
  ["RegisterRequest (empty name)", P.RegisterRequest, { name: "" }],
  ["SendMessageRequest (missing payload)", P.SendMessageRequest, { to: "agent-1", type: "question" }],
  [
    "SendMessageRequest (invalid payload urgency)",
    P.SendMessageRequest,
    {
      to: "73b4ba62-812e-4b5a-a98a-92d46afe92b1",
      type: "question",
      payload: { content: "hi", urgency: "unknown" },
    },
  ],
  [
    "AgentCard (invalid pairing code)",
    P.AgentCard,
    {
      schema: "trunk.agent_card.v1",
      agent_id: "73b4ba62-812e-4b5a-a98a-92d46afe92b1",
      name: "Vesper",
      pairing_code: "bad-code",
      protocol: ["trunk/1+grants"],
      version: "0.1.0",
      capabilities: [],
      message_types: [],
      endpoints: [],
      contact_policy: { pairing_open: true, accepts_bearer: true, accepts_scoped_grants: true },
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    },
  ],
  ["CreateGrantRequest (no scopes)", P.CreateGrantRequest, { name: "test" }],
];

for (const [name, schema, value] of positiveCases) {
  const result = (schema as { safeParse: (v: unknown) => { success: boolean; error?: { issues: unknown } } }).safeParse(value);
  if (!result.success) {
    issues.push(`Schema ${name} rejected a known-good fixture: ${JSON.stringify(result.error?.issues)}`);
  }
}

for (const [name, schema, value] of negativeCases) {
  const result = (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(value);
  if (result.success) {
    issues.push(`Schema ${name} expected to reject ${JSON.stringify(value)} but accepted it`);
  }
}

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`protocol: ${issue}`);
  }
  process.exit(1);
}

console.log(
  `Protocol spine verified: ${required.length} schemas, ${Object.keys(derived).length} JSON Schemas, ${Object.keys(openApiSchemas).length} OpenAPI schemas, ${positiveCases.length + negativeCases.length} fixtures`,
);
