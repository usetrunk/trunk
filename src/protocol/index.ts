/**
 * Trunk Protocol Spine
 *
 * Single source of truth for shared request/response shapes that flow across
 * the API, the SDK, the MCP surfaces, and the documentation.
 *
 * Conventions:
 *  - Snake-case at the wire (request/response fields).
 *  - Zod schemas double as runtime validators and TS types via z.infer.
 *  - JSON Schemas are derived from Zod and exported from `deriveJsonSchema.ts`.
 *  - OpenAPI is composed in `openapi.ts` referencing the same primitives.
 *
 * Anything that previously lived as ad-hoc `interface`/`type` definitions in
 * `src/sdk/index.ts` or inline in routes should migrate here so we stop
 * drifting between the SDK and the relay.
 */

export * from "./primitives.js";
export * from "./agents.js";
export * from "./messages.js";
export * from "./contacts.js";
export * from "./facts.js";
export * from "./grants.js";
export * from "./agent-cards.js";
export * from "./delegations.js";
export * from "./inspector.js";
