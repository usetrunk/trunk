/**
 * JSON Schema derivation from Zod.
 *
 * Uses zod-to-json-schema (already a transitive dep of @hono/zod-*)
 * to produce a stable JSON Schema document for every public protocol
 * surface. Consumers (CI, SDK generators, integration tests) read
 * `protocol/json-schema/*.json` to verify drift.
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import * as P from "./index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "..", "protocol", "json-schema");

type SchemaEntry = {
  name: string;
  schema: unknown;
};

function schemaFor(value: unknown, name: string): SchemaEntry {
  if (!value || typeof value !== "object" || !("_def" in (value as Record<string, unknown>))) {
    throw new Error(`Protocol export "${name}" is not a Zod schema`);
  }
  const json = zodToJsonSchema(value as Parameters<typeof zodToJsonSchema>[0], {
    $refStrategy: "none",
    target: "jsonSchema7",
    errorMessages: true,
  });
  return { name, schema: json };
}

const SCHEMAS: Array<{ name: string; schema: unknown }> = (
  [
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
    ["CreateDelegationRequest", P.CreateDelegationRequest],
    ["DelegationRecord", P.DelegationRecord],
    ["CreateDelegationResponse", P.CreateDelegationResponse],
    ["ClaimDelegationRequest", P.ClaimDelegationRequest],
    ["ClaimDelegationResponse", P.ClaimDelegationResponse],
    ["ListDelegationsResponse", P.ListDelegationsResponse],
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
  ] as const
).map(([name, schema]) => ({ name, schema }));

export function deriveJsonSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of SCHEMAS) {
    out[entry.name] = schemaFor(entry.schema, entry.name).schema;
  }
  return out;
}

export function writeJsonSchemas(targetDir = OUT_DIR): { count: number; dir: string } {
  mkdirSync(targetDir, { recursive: true });
  const all = deriveJsonSchemas();
  for (const [name, schema] of Object.entries(all)) {
    writeFileSync(join(targetDir, `${name}.json`), JSON.stringify(schema, null, 2));
  }
  writeFileSync(join(targetDir, "index.json"), JSON.stringify(all, null, 2));
  return { count: Object.keys(all).length, dir: targetDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = writeJsonSchemas();
  console.log(`Wrote ${result.count} JSON Schemas to ${result.dir}`);
}
