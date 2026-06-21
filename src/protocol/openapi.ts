/**
 * Minimal OpenAPI 3.1 document for Trunk, assembled from the protocol spine.
 *
 * The OpenAPI doc references the same JSON Schemas the verification script
 * emits, so consumers can rely on a single source of truth.
 */
import * as P from "./index.js";
import { deriveJsonSchemas } from "./derive-json-schema.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "..", "protocol", "openapi.json");

const TRUNK_VERSION = "0.1.0";

function ref(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

function endpoint(
  method: string,
  _path: string,
  opts: {
    summary: string;
    operationId: string;
    requestBody?: string;
    response?: string;
    list?: string;
    auth?: boolean;
    parameters?: Array<{ name: string; in: "path" | "query"; required?: boolean; schema: Record<string, unknown> }>;
  },
) {
  const op: Record<string, unknown> = {
    summary: opts.summary,
    operationId: opts.operationId,
    tags: [],
    responses: {
      "200": {
        description: "OK",
        content: { "application/json": { schema: opts.response ? ref(opts.response) : { type: "object" } } },
      },
      "4xx": {
        description: "Client error",
        content: { "application/json": { schema: ref("ApiError") } },
      },
    },
  };
  if (opts.requestBody) {
    op.requestBody = {
      required: true,
      content: { "application/json": { schema: ref(opts.requestBody) } },
    };
  }
  if (opts.parameters) {
    op.parameters = opts.parameters.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required ?? false,
      schema: p.schema,
    }));
  }
  if (opts.auth) {
    op.security = [{ bearerAuth: [] }];
  }
  return { [method]: op };
}

const PARAM_UUID = { type: "string", format: "uuid" };

const PATHS: Record<string, unknown> = {
  "/health": endpoint("get", "/health", { summary: "Health", operationId: "health", response: "Health" }),
  "/ready": endpoint("get", "/ready", { summary: "Readiness", operationId: "ready", response: "Health" }),
  "/agents/register": endpoint("post", "/agents/register", {
    summary: "Register a new agent",
    operationId: "registerAgent",
    requestBody: "RegisterRequest",
    response: "RegisterResponse",
  }),
  "/agents/me": {
    ...endpoint("get", "/agents/me", { summary: "Get profile", operationId: "getMe", response: "AgentProfile", auth: true }),
    ...endpoint("patch", "/agents/me", { summary: "Update profile", operationId: "updateMe", requestBody: "UpdateMeRequest", response: "AgentProfile", auth: true }),
  },
  "/agents/me/rotate-secret": endpoint("post", "/agents/me/rotate-secret", {
    summary: "Rotate the bearer secret",
    operationId: "rotateSecret",
    response: "RotateSecretResponse",
    auth: true,
  }),
  "/agents/me/card": {
    ...endpoint("get", "/agents/me/card", { summary: "Get my agent card", operationId: "getMyCard", response: "AgentCardResponse", auth: true }),
    ...endpoint("put", "/agents/me/card", { summary: "Upsert my agent card", operationId: "upsertMyCard", requestBody: "UpsertAgentCardRequest", response: "AgentCardResponse", auth: true }),
  },
  "/agents/{id}/card": endpoint("get", "/agents/{id}/card", {
    summary: "Get another agent's card",
    operationId: "getAgentCard",
    response: "AgentCardResponse",
    auth: true,
    parameters: [{ name: "id", in: "path", required: true, schema: PARAM_UUID }],
  }),
  "/contacts/pair": endpoint("post", "/contacts/pair", { summary: "Pair with agent", operationId: "pair", requestBody: "PairRequest", auth: true, response: "ContactsResponse" }),
  "/contacts": endpoint("get", "/contacts", { summary: "List contacts", operationId: "listContacts", auth: true, response: "ContactsResponse" }),
  "/messages": endpoint("post", "/messages", { summary: "Send a message", operationId: "sendMessage", auth: true, requestBody: "SendMessageRequest", response: "MessageReceipt" }),
  "/messages/inbox": endpoint("get", "/messages/inbox", { summary: "Inbox", operationId: "inbox", auth: true, response: "TrunkMessage" }),
  "/messages/thread/{threadId}": endpoint("get", "/messages/thread/{threadId}", {
    summary: "Thread history",
    operationId: "thread",
    auth: true,
    response: "TrunkMessage",
    parameters: [{ name: "threadId", in: "path", required: true, schema: PARAM_UUID }],
  }),
  "/context/{contactId}/facts": endpoint("get", "/context/{contactId}/facts", {
    summary: "List contact facts",
    operationId: "listContactFacts",
    auth: true,
    response: "ListFactsResponse",
    parameters: [{ name: "contactId", in: "path", required: true, schema: PARAM_UUID }],
  }),
  "/context/{contactId}/facts/{key}": {
    ...endpoint("get", "/context/{contactId}/facts/{key}", {
      summary: "Get a contact fact",
      operationId: "getContactFact",
      auth: true,
      response: "FactRecord",
      parameters: [
        { name: "contactId", in: "path", required: true, schema: PARAM_UUID },
        { name: "key", in: "path", required: true, schema: { type: "string" } },
      ],
    }),
    ...endpoint("put", "/context/{contactId}/facts/{key}", {
      summary: "Upsert a contact fact",
      operationId: "putContactFact",
      auth: true,
      requestBody: "PutFactRequest",
      response: "FactRecord",
      parameters: [
        { name: "contactId", in: "path", required: true, schema: PARAM_UUID },
        { name: "key", in: "path", required: true, schema: { type: "string" } },
      ],
    }),
  },
  "/context/{contactId}/facts/{key}/history": endpoint("get", "/context/{contactId}/facts/{key}/history", {
    summary: "Get contact fact history (provenance)",
    operationId: "contactFactHistory",
    auth: true,
    response: "FactHistoryResponse",
    parameters: [
      { name: "contactId", in: "path", required: true, schema: PARAM_UUID },
      { name: "key", in: "path", required: true, schema: { type: "string" } },
    ],
  }),
  "/grants": {
    ...endpoint("get", "/grants", { summary: "List grants", operationId: "listGrants", auth: true, response: "ListGrantsResponse" }),
    ...endpoint("post", "/grants", { summary: "Create a grant", operationId: "createGrant", auth: true, requestBody: "CreateGrantRequest", response: "CreateGrantResponse" }),
  },
  "/grants/{id}": endpoint("delete", "/grants/{id}", {
    summary: "Revoke a grant",
    operationId: "revokeGrant",
    auth: true,
    response: "ApiError",
    parameters: [{ name: "id", in: "path", required: true, schema: PARAM_UUID }],
  }),
  "/inspector/health": endpoint("get", "/inspector/health", { summary: "Delivery health", operationId: "inspectorHealth", auth: true, response: "DeliveryHealth" }),
  "/inspector/thread/{threadId}": endpoint("get", "/inspector/thread/{threadId}", {
    summary: "Thread timeline",
    operationId: "inspectorThread",
    auth: true,
    response: "ThreadTimeline",
    parameters: [{ name: "threadId", in: "path", required: true, schema: PARAM_UUID }],
  }),
};

export function buildOpenApi(): Record<string, unknown> {
  const jsonSchemas = deriveJsonSchemas();
  return {
    openapi: "3.1.0",
    info: {
      title: "Trunk Relay",
      version: TRUNK_VERSION,
      description: "Agent-to-agent communication relay. Open source, MIT licensed.",
    },
    servers: [{ url: "https://trunk.bot" }],
    tags: [
      { name: "agents" },
      { name: "contacts" },
      { name: "messages" },
      { name: "facts" },
      { name: "grants" },
      { name: "agent_cards" },
      { name: "inspector" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        grantAuth: { type: "http", scheme: "bearer", description: "Scoped grant token" },
      },
      schemas: jsonSchemas,
    },
    paths: PATHS,
  };
}

export function writeOpenApi(target = OUT): { path: string } {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(buildOpenApi(), null, 2));
  return { path: target };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = writeOpenApi();
  console.log(`Wrote OpenAPI document to ${result.path}`);
  void P;
}
