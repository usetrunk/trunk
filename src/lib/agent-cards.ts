/**
 * Agent card service.
 *
 * Centralizes all reads/writes for `agent_cards` so the route layer stays
 * thin and the SDK can reuse the same logic.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentCards, agents } from "../db/schema.js";
import {
  AgentCard,
  type AgentCardT,
  type UpsertAgentCardRequestT,
} from "../protocol/agent-cards.js";
import { signTrunkWebhook } from "../lib/verify-webhook.js";

type AgentRow = typeof agents.$inferSelect;
type CardRow = typeof agentCards.$inferSelect;

const DEFAULT_POLICY = {
  pairing_open: true,
  accepts_bearer: true,
  accepts_scoped_grants: true,
};

function defaultProtocol(): string[] {
  return ["trunk/1"];
}

function defaultMessageTypes(agent: AgentRow): string[] {
  const types = (agent.metadata as { message_types?: unknown })?.message_types;
  if (Array.isArray(types)) {
    return types.filter((t): t is string => typeof t === "string");
  }
  return ["question", "decision", "review", "handoff", "update", "ack"];
}

function defaultCapabilities(): Array<Record<string, unknown>> {
  return [{ id: "messaging", description: "Send and receive Trunk messages" }];
}

function buildCard(agent: AgentRow, row: CardRow | null): AgentCardT {
  const policy = (row?.contactPolicy as Record<string, unknown> | undefined) ?? DEFAULT_POLICY;
  const policyRecord: Record<string, unknown> = { ...DEFAULT_POLICY, ...(policy as Record<string, unknown>) };
  const protocol: AgentCardT["protocol"] = (row?.protocol && row.protocol.length > 0)
    ? (row.protocol as AgentCardT["protocol"])
    : (defaultProtocol() as AgentCardT["protocol"]);
  const capabilities: AgentCardT["capabilities"] = (row?.capabilities && row.capabilities.length > 0)
    ? (row.capabilities as unknown as AgentCardT["capabilities"])
    : (defaultCapabilities() as unknown as AgentCardT["capabilities"]);
  const endpoints: AgentCardT["endpoints"] = row?.endpoints
    ? (row.endpoints as unknown as AgentCardT["endpoints"])
    : [];
  return {
    schema: "trunk.agent_card.v1",
    agent_id: agent.id,
    name: agent.name,
    owner: agent.owner ?? null,
    description: row?.description ?? undefined,
    pairing_code: agent.pairingCode,
    protocol,
    version: row?.version ?? "0.1.0",
    homepage_url: row?.homepageUrl ?? undefined,
    documentation_url: row?.documentationUrl ?? undefined,
    repository_url: row?.repositoryUrl ?? undefined,
    capabilities,
    message_types: (row?.messageTypes && row.messageTypes.length > 0) ? row.messageTypes : defaultMessageTypes(agent),
    endpoints,
    contact_policy: {
      pairing_open: typeof policyRecord.pairing_open === "boolean" ? policyRecord.pairing_open : true,
      accepts_bearer: typeof policyRecord.accepts_bearer === "boolean" ? policyRecord.accepts_bearer : true,
      accepts_scoped_grants: typeof policyRecord.accepts_scoped_grants === "boolean" ? policyRecord.accepts_scoped_grants : true,
      contact_policy_url: typeof policyRecord.contact_policy_url === "string" ? policyRecord.contact_policy_url : undefined,
      privacy_url: typeof policyRecord.privacy_url === "string" ? policyRecord.privacy_url : undefined,
      rate_limit: isRateLimit(policyRecord.rate_limit) ? policyRecord.rate_limit : undefined,
    },
    metadata: row?.metadata && Object.keys(row.metadata).length > 0 ? row.metadata : undefined,
    created_at: row?.createdAt?.toISOString() ?? agent.createdAt.toISOString(),
    updated_at: (row?.updatedAt ?? agent.createdAt).toISOString(),
  };
}

function isRateLimit(value: unknown): value is { requests_per_minute?: number; burst?: number } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.requests_per_minute !== undefined && (typeof v.requests_per_minute !== "number" || v.requests_per_minute <= 0)) {
    return false;
  }
  if (v.burst !== undefined && (typeof v.burst !== "number" || v.burst <= 0)) {
    return false;
  }
  return true;
}

export async function getCard(agentId: string): Promise<AgentCardT | null> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return null;
  const [row] = await db.select().from(agentCards).where(eq(agentCards.agentId, agentId)).limit(1);
  return buildCard(agent, row ?? null);
}

export async function upsertCard(
  agentId: string,
  input: UpsertAgentCardRequestT,
): Promise<{ card: AgentCardT; created: boolean }> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) {
    throw new CardError("agent not found", 404);
  }

  const [existing] = await db.select().from(agentCards).where(eq(agentCards.agentId, agentId)).limit(1);
  const now = new Date();
  const mergedPolicy = {
    ...DEFAULT_POLICY,
    ...((existing?.contactPolicy as Record<string, unknown> | undefined) ?? {}),
    ...(input.contact_policy ?? {}),
  };

  const values = {
    agentId,
    schema: "trunk.agent_card.v1",
    description: input.description ?? existing?.description ?? null,
    protocol: input.protocol ?? existing?.protocol ?? defaultProtocol(),
    version: input.version ?? existing?.version ?? "0.1.0",
    homepageUrl: input.homepage_url ?? existing?.homepageUrl ?? null,
    documentationUrl: input.documentation_url ?? existing?.documentationUrl ?? null,
    repositoryUrl: input.repository_url ?? existing?.repositoryUrl ?? null,
    capabilities: input.capabilities ?? existing?.capabilities ?? defaultCapabilities(),
    messageTypes: input.message_types ?? existing?.messageTypes ?? defaultMessageTypes(agent),
    endpoints: input.endpoints ?? existing?.endpoints ?? [],
    contactPolicy: mergedPolicy,
    metadata: input.metadata ?? existing?.metadata ?? {},
    updatedAt: now,
  };

  if (existing) {
    await db.update(agentCards).set(values).where(eq(agentCards.agentId, agentId));
  } else {
    await db.insert(agentCards).values({ ...values, createdAt: now });
  }

  const [updated] = await db.select().from(agentCards).where(eq(agentCards.agentId, agentId)).limit(1);
  return { card: buildCard(agent, updated), created: !existing };
}

export async function signCard(card: AgentCardT, signingKey: string | null): Promise<AgentCardT> {
  if (!signingKey) return card;
  const { signature: _omit, ...rest } = card;
  const payload = JSON.stringify(rest);
  const signature = await signTrunkWebhook(payload, signingKey);
  return { ...card, signature: { algorithm: "HMAC-SHA256", value: signature } };
}

export class CardError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CardError";
    this.status = status;
  }
}

export function validateCard(card: AgentCardT): void {
  const result = AgentCard.safeParse(card);
  if (!result.success) {
    throw new CardError(`agent card failed schema validation: ${result.error.message}`, 422);
  }
}
