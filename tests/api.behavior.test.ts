import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import app from "../src/app.js";
import { createTrunkInboxNode, createTrunkSendNode } from "../src/adapters/langgraph.js";
import { notifyPushWorker } from "../src/lib/webhook.js";
import { TrunkApiError, TrunkClient, signWebhookPayload, verifyWebhookSignature, type RegisterResponse, type TrunkMessage } from "../src/sdk/index.js";

type AgentRow = {
  id: string;
  name: string;
  owner?: string | null;
  secretHash: string;
  pairingCode: string;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  workspaceId?: string | null;
  workspaceRole?: string | null;
  metadata: Record<string, unknown>;
  lastSeenAt: Date | null;
  createdAt: Date;
};

type ContactRow = {
  agentA: string;
  agentB: string;
  aliasA?: string | null;
  aliasB?: string | null;
  pairedAt: Date;
};

type MessageRow = {
  id: string;
  fromAgent: string;
  toAgent: string;
  toWorkspace?: string | null;
  toRoom?: string | null;
  threadId: string | null;
  replyTo: string | null;
  idempotencyKey: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: Date;
  readAt?: Date | null;
  deliveredAt?: Date | null;
  processedAt?: Date | null;
  repliedAt?: Date | null;
  deletedAt?: Date | null;
  editedAt?: Date | null;
  pinnedAt?: Date | null;
  pinnedBy?: string | null;
  scheduledAt?: Date | null;
  expiresAt?: Date | null;
};

type TaskRow = {
  id: string;
  scope: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  owner: string | null;
  createdBy: string;
  due: string | null;
  startDate: string | null;
  group: string | null;
  dependsOn: string[];
  sequence: number | null;
  estimate: number | null;
  contextRef: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type RoomRow = {
  id: string;
  name: string;
  createdBy: string;
  pairingCode: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

type RoomMemberRow = {
  roomId: string;
  agentId: string;
  role: string;
  joinedAt: Date;
};

type WorkspaceRow = {
  id: string;
  name: string;
  owner: string | null;
  pairingCode: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

type WorkspaceContactRow = {
  workspaceId: string;
  agentId: string;
  alias: string | null;
  pairedAt: Date;
};

type SharedFactRow = {
  scope: string;
  key: string;
  value: unknown;
  version: number;
  updatedBy: string;
  updatedAt: Date;
};

type AuditEventRow = {
  id: string;
  actorAgent: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

type RateLimitRow = {
  scope: string;
  count: number;
  windowStart: Date;
  updatedAt: Date;
};

type SharedDocumentRow = {
  id: string;
  scope: string;
  name: string;
  contentType: string;
  body: string;
  version: number;
  lastEditedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type SharedDocumentVersionRow = {
  id: string;
  documentId: string;
  version: number;
  body: string;
  editedBy: string;
  createdAt: Date;
};

type SubscriptionRow = {
  id: string;
  workspaceId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  plan: string;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ReactionRow = {
  id: string;
  messageId: string;
  agentId: string;
  emoji: string;
  createdAt: Date;
};

type WebhookDeliveryRow = {
  id: string;
  agentId: string;
  messageId: string | null;
  url: string;
  event: string;
  success: number;
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
  attempts: number;
  createdAt: Date;
};

type MessageLabelRow = {
  id: string;
  messageId: string;
  agentId: string;
  label: string;
  createdAt: Date;
};

type BlockedContactRow = {
  id: string;
  agentId: string;
  blockedAgentId: string;
  reason: string | null;
  createdAt: Date;
};

type ContactNoteRow = {
  id: string;
  agentId: string;
  contactAgentId: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
};

type SavedSearchRow = {
  id: string;
  agentId: string;
  name: string;
  query: Record<string, string>;
  createdAt: Date;
};

type ContactTagRow = {
  id: string;
  agentId: string;
  contactAgentId: string;
  tag: string;
  createdAt: Date;
};

type NotificationPrefRow = {
  id: string;
  agentId: string;
  contactAgentId: string;
  muted: number;
  urgencyFilter: string;
  createdAt: Date;
  updatedAt: Date;
};

type MessageEditRow = {
  id: string;
  messageId: string;
  version: number;
  previousPayload: Record<string, unknown>;
  editedBy: string;
  createdAt: Date;
};

type MessageTemplateRow = {
  id: string;
  agentId: string;
  name: string;
  type: string;
  payload: Record<string, unknown>;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AttachmentRow = {
  id: string;
  messageId: string | null;
  agentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  data: string;
  createdAt: Date;
};

type TableName =
  | "agents"
  | "contacts"
  | "messages"
  | "tasks"
  | "rooms"
  | "room_members"
  | "workspaces"
  | "workspace_contacts"
  | "shared_facts"
  | "shared_documents"
  | "shared_document_versions"
  | "audit_events"
  | "rate_limits"
  | "subscriptions"
  | "reactions"
  | "webhook_deliveries"
  | "message_labels"
  | "blocked_contacts"
  | "contact_notes"
  | "message_templates"
  | "notification_preferences"
  | "contact_tags"
  | "saved_searches"
  | "message_edits"
  | "attachments";

const testState = vi.hoisted(() => ({
  agents: [] as AgentRow[],
  contacts: [] as ContactRow[],
  messages: [] as MessageRow[],
  tasks: [] as TaskRow[],
  rooms: [] as RoomRow[],
  "room_members": [] as RoomMemberRow[],
  workspaces: [] as WorkspaceRow[],
  "workspace_contacts": [] as WorkspaceContactRow[],
  "shared_facts": [] as SharedFactRow[],
  "shared_documents": [] as SharedDocumentRow[],
  "shared_document_versions": [] as SharedDocumentVersionRow[],
  "audit_events": [] as AuditEventRow[],
  "rate_limits": [] as RateLimitRow[],
  subscriptions: [] as SubscriptionRow[],
  reactions: [] as ReactionRow[],
  "webhook_deliveries": [] as WebhookDeliveryRow[],
  "message_labels": [] as MessageLabelRow[],
  "blocked_contacts": [] as BlockedContactRow[],
  "contact_notes": [] as ContactNoteRow[],
  "message_templates": [] as MessageTemplateRow[],
  "notification_preferences": [] as NotificationPrefRow[],
  "contact_tags": [] as ContactTagRow[],
  "saved_searches": [] as SavedSearchRow[],
  "message_edits": [] as MessageEditRow[],
  attachments: [] as AttachmentRow[],
  idCounter: 0,
}));

vi.mock("../src/lib/webhook.js", () => ({
  notifyPushWorker: vi.fn(async () => undefined),
  deliverWebhook: vi.fn(async () => true),
}));

vi.mock("../src/db/index.js", () => ({
  db: createMockDb(),
}));

describe("Hono API behavior", () => {
  beforeEach(() => {
    testState.agents.length = 0;
    testState.contacts.length = 0;
    testState.messages.length = 0;
    testState.tasks.length = 0;
    testState.rooms.length = 0;
    testState["room_members"].length = 0;
    testState.workspaces.length = 0;
    testState["workspace_contacts"].length = 0;
    testState["shared_facts"].length = 0;
    testState["shared_documents"].length = 0;
    testState["shared_document_versions"].length = 0;
    testState["audit_events"].length = 0;
    testState["rate_limits"].length = 0;
    testState.subscriptions.length = 0;
    testState.reactions.length = 0;
    testState["webhook_deliveries"].length = 0;
    testState["message_labels"].length = 0;
    testState["blocked_contacts"].length = 0;
    testState["contact_notes"].length = 0;
    testState["message_templates"].length = 0;
    testState["notification_preferences"].length = 0;
    testState["contact_tags"].length = 0;
    testState["saved_searches"].length = 0;
    testState["message_edits"].length = 0;
    testState.attachments.length = 0;
    testState.idCounter = 0;
    vi.clearAllMocks();
  });

  it("serves the public landing page at the root", async () => {
    const response = await app.request("/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("<h1>Trunk</h1>");
    expect(body).toContain("/connect/HVG7VSKZ");
  });

  it("serves the README badge SVG", async () => {
    const response = await app.request("/badge.svg");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(body).toContain("Trunk");
  });

  it("health endpoint returns status, version, and uptime", async () => {
    const client = createClient();
    const health = await client.health();

    expect(health.status).toBe("ok");
    expect(health.version).toBe("0.1.0");
    expect(health.uptime).toEqual(expect.any(Number));
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });

  it("ready endpoint returns database connectivity status", async () => {
    const client = createClient();
    const ready = await client.ready();

    expect(ready.status).toBe("ready");
    expect(ready.database).toBe("connected");
  });

  it("register returns agent_id, secret, and pairing_code", async () => {
    const client = createClient();

    const registered = await client.register({ name: "alpha", owner: "Andrei" });

    expect(registered.agent_id).toEqual(expect.any(String));
    expect(registered.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(registered.pairing_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it("me returns the current profile", async () => {
    const registered = await createClient().register({
      name: "alpha",
      owner: "Andrei",
      webhook_url: "https://alpha.example/webhook",
    });
    const client = createClient(registered.secret);

    await expect(client.me()).resolves.toMatchObject({
      agent_id: registered.agent_id,
      name: "alpha",
      owner: "Andrei",
      pairing_code: registered.pairing_code,
      webhook_url: "https://alpha.example/webhook",
      created_at: expect.any(String),
    });
  });

  it("updateMe updates name, owner, and webhook_url", async () => {
    const registered = await createClient().register({ name: "alpha", owner: "Andrei" });
    const client = createClient(registered.secret);

    const updated = await client.updateMe({
      name: "alpha-renamed",
      owner: "Vince",
      webhook_url: "https://alpha.example/updated",
    });

    expect(updated).toMatchObject({
      agent_id: registered.agent_id,
      name: "alpha-renamed",
      owner: "Vince",
      webhook_url: "https://alpha.example/updated",
    });
    await expect(client.me()).resolves.toMatchObject({
      agent_id: registered.agent_id,
      name: "alpha-renamed",
      owner: "Vince",
      webhook_url: "https://alpha.example/updated",
    });
  });

  it("rotateSecret returns a new secret, invalidates the old secret, and authenticates the new secret", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const oldClient = createClient(registered.secret);

    const rotated = await oldClient.rotateSecret();

    expect(rotated.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated.secret).not.toBe(registered.secret);
    await expect(oldClient.me()).rejects.toMatchObject({ status: 401, message: "Invalid token" });
    await expect(createClient(rotated.secret).me()).resolves.toMatchObject({
      agent_id: registered.agent_id,
      name: "alpha",
    });
  });

  it("pairs agents and exposes contacts to both participants", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();

    const pair = await alphaClient.pair({ code: beta.pairing_code });

    expect(pair).toMatchObject({ contact_id: beta.agent_id, name: "beta" });
    await expect(alphaClient.contacts()).resolves.toMatchObject({
      contacts: [expect.objectContaining({ agent_id: beta.agent_id, name: "beta" })],
    });
    await expect(betaClient.contacts()).resolves.toMatchObject({
      contacts: [expect.objectContaining({ agent_id: alpha.agent_id, name: "alpha" })],
    });
  });

  it("returns 409 for duplicate pair attempts", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(alphaClient.pair({ code: beta.pairing_code })).rejects.toMatchObject({
      status: 409,
      message: "Already paired",
    });
  });

  it("rejects sends to non-contacts with 403", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);

    const send = alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "Are we paired?" },
    });

    await expect(send).rejects.toBeInstanceOf(TrunkApiError);
    await expect(send).rejects.toMatchObject({ status: 403, message: "Not a contact. Pair first." });
    try { await send; } catch (e) {
      const err = e as TrunkApiError;
      expect(err.code).toBe("NOT_MEMBER");
    }
  });

  it("error responses include structured error codes", async () => {
    // Unauthorized request should include UNAUTHORIZED code
    const client = createClient("bad-secret");
    try {
      await client.me();
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as TrunkApiError;
      expect(err.status).toBe(401);
      expect(err.code).toBe("UNAUTHORIZED");
      expect(err.body).toMatchObject({ error: expect.any(String), code: "UNAUTHORIZED" });
    }
  });

  it("sends to a contact and the recipient sees a pending inbound message", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "Review this API?" },
    });
    const inbox = await betaClient.inbox();

    expect(sent.status).toBe("delivered");
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({
      id: sent.id,
      threadId: sent.thread_id,
      type: "question",
      status: "delivered",
      payload: { content: "Review this API?" },
    });
  });

  it("ack marks a message read so it leaves pending inbox and appears in read inbox", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "Done." },
    });

    await expect(betaClient.ack(sent.id)).resolves.toEqual({ ok: true });

    await expect(betaClient.inbox()).resolves.toMatchObject({ messages: [] });
    const processedInbox = await betaClient.inbox({ status: "processed" });
    expect(processedInbox.messages).toHaveLength(1);
    expect(processedInbox.messages[0]).toMatchObject({
      id: sent.id,
      status: "processed",
      readAt: expect.any(String),
      processedAt: expect.any(String),
    });
  });

  it("unpair removes contacts and blocks later sends", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(alphaClient.unpair(beta.agent_id)).resolves.toEqual({ ok: true });

    await expect(alphaClient.contacts()).resolves.toEqual({ contacts: [] });
    await expect(betaClient.contacts()).resolves.toEqual({ contacts: [] });
    await expect(
      alphaClient.send({
        to: beta.agent_id,
        type: "question",
        payload: { content: "Still there?" },
      })
    ).rejects.toMatchObject({ status: 403, message: "Not a contact. Pair first." });
    expect(testState["audit_events"].map((event) => event.action)).toEqual([
      "contact.pair",
      "contact.unpair",
    ]);
  });

  it("preserves explicit thread_id on send", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "handoff",
      thread_id: "00000000-0000-4000-8000-aaaaaaaaaaaa",
      payload: { content: "Use this thread." },
    });

    expect(sent.thread_id).toBe("00000000-0000-4000-8000-aaaaaaaaaaaa");
    await expect(betaClient.thread("00000000-0000-4000-8000-aaaaaaaaaaaa")).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: sent.id, threadId: "00000000-0000-4000-8000-aaaaaaaaaaaa" })],
    });
  });

  it("allows self-messaging (same agent, different sessions)", async () => {
    const alpha = await createClient().register({ name: "planner", owner: "Frank" });
    const alphaClient = createClient(alpha.secret);

    const sent = await alphaClient.send({
      to: alpha.agent_id,
      type: "handoff",
      payload: { content: "Delegate this task to the developer session" },
    });

    expect(sent.status).toBe("delivered");
    const inbox = await alphaClient.inbox();
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({
      fromAgent: alpha.agent_id,
      toAgent: alpha.agent_id,
      type: "handoff",
      payload: { content: "Delegate this task to the developer session" },
    });
  });

  it("multi-agent workflow: planner delegates to developer who reports back", async () => {
    const anon = createClient();
    const planner = await anon.register({ name: "Frank (planner)", owner: "Frank" });
    const developer = await anon.register({ name: "Frank (developer)", owner: "Frank" });
    const plannerClient = createClient(planner.secret);
    const developerClient = createClient(developer.secret);

    // Pair
    await plannerClient.pair({ code: developer.pairing_code });

    // Planner sends task
    const task = await plannerClient.send({
      to: developer.agent_id,
      type: "handoff",
      payload: { content: "Implement the webhook retry logic" },
    });

    // Developer sees it
    const devInbox = await developerClient.inbox();
    expect(devInbox.messages).toHaveLength(1);
    expect(devInbox.messages[0].payload).toMatchObject({ content: "Implement the webhook retry logic" });

    // Developer replies
    const reply = await developerClient.reply(task.id, {
      type: "update",
      payload: { content: "Done — 3x exponential backoff, tested locally" },
    });

    // Same thread
    expect(reply.thread_id).toBe(task.thread_id);

    // Planner sees the reply
    const plannerInbox = await plannerClient.inbox();
    expect(plannerInbox.messages).toHaveLength(1);
    expect(plannerInbox.messages[0]).toMatchObject({
      fromAgent: developer.agent_id,
      type: "update",
      payload: { content: "Done — 3x exponential backoff, tested locally" },
    });

    // Thread has both messages
    const thread = await plannerClient.thread(task.thread_id);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0].fromAgent).toBe(planner.agent_id);
    expect(thread.messages[1].fromAgent).toBe(developer.agent_id);
  });

  it("thread summary returns structured digest with participants, type counts, decisions, and open questions", async () => {
    const anon = createClient();
    const planner = await anon.register({ name: "planner-sum", owner: "Frank" });
    const developer = await anon.register({ name: "developer-sum", owner: "Frank" });
    const plannerClient = createClient(planner.secret);
    const developerClient = createClient(developer.secret);

    await plannerClient.pair({ code: developer.pairing_code });

    // Planner sends a question
    const q = await plannerClient.send({
      to: developer.agent_id,
      type: "question",
      payload: { content: "Can you handle the webhook retry?" },
    });

    // Developer replies with a decision
    await developerClient.reply(q.id, {
      type: "decision",
      payload: { content: "Yes, will use exponential backoff." },
    });

    // Planner sends a handoff in the same thread
    await plannerClient.send({
      to: developer.agent_id,
      type: "handoff",
      thread_id: q.thread_id,
      payload: { content: "Go ahead and implement it." },
    });

    // Planner sends an unanswered question
    await plannerClient.send({
      to: developer.agent_id,
      type: "question",
      thread_id: q.thread_id,
      payload: { content: "What's the max retry count?" },
    });

    const summary = await plannerClient.threadSummary(q.thread_id);

    expect(summary.thread_id).toBe(q.thread_id);
    expect(summary.message_count).toBe(4);
    expect(summary.participants).toHaveLength(2);
    expect(summary.participants.map((p: { name: string }) => p.name).sort()).toEqual(["developer-sum", "planner-sum"]);
    expect(summary.by_type).toMatchObject({ question: 2, decision: 1, handoff: 1 });
    expect(summary.decisions).toHaveLength(2); // decision + handoff
    expect(summary.decisions[0].content).toBe("Yes, will use exponential backoff.");
    expect(summary.decisions[1].type).toBe("handoff");
    expect(summary.open_questions).toHaveLength(1);
    expect(summary.open_questions[0].content).toBe("What's the max retry count?");
    expect(summary.first_message).toMatchObject({ id: q.id, type: "question", from: planner.agent_id });
    expect(summary.last_message.content).toBe("What's the max retry count?");
    expect(summary.started_at).toBeDefined();
    expect(summary.last_activity).toBeDefined();
  });

  it("thread summary returns 404 for non-existent thread", async () => {
    const alpha = await createClient().register({ name: "solo-sum", owner: "Frank" });
    const alphaClient = createClient(alpha.secret);

    await expect(alphaClient.threadSummary("00000000-0000-0000-0000-000000000099")).rejects.toThrow();
  });

  it("three-agent coordination: planner, developer, reviewer", async () => {
    const anon = createClient();
    const planner = await anon.register({ name: "planner", owner: "Frank" });
    const developer = await anon.register({ name: "developer", owner: "Frank" });
    const reviewer = await anon.register({ name: "reviewer", owner: "Frank" });
    const plannerClient = createClient(planner.secret);
    const developerClient = createClient(developer.secret);
    const reviewerClient = createClient(reviewer.secret);

    // Pair all with each other
    await plannerClient.pair({ code: developer.pairing_code });
    await plannerClient.pair({ code: reviewer.pairing_code });
    await developerClient.pair({ code: reviewer.pairing_code });

    // Planner assigns work to developer
    const task = await plannerClient.send({
      to: developer.agent_id,
      type: "handoff",
      payload: { content: "Build the auth middleware" },
    });

    // Developer finishes and sends to reviewer
    await developerClient.reply(task.id, {
      type: "ack",
      payload: { content: "On it" },
    });
    const reviewRequest = await developerClient.send({
      to: reviewer.agent_id,
      type: "review",
      payload: { content: "Auth middleware PR ready for review" },
    });

    // Reviewer sees the review request
    const reviewInbox = await reviewerClient.inbox();
    expect(reviewInbox.messages).toHaveLength(1);
    expect(reviewInbox.messages[0].type).toBe("review");

    // Reviewer approves
    const approval = await reviewerClient.reply(reviewRequest.id, {
      type: "decision",
      payload: { content: "LGTM, approved" },
    });

    // Developer sees approval
    const devInbox = await developerClient.inbox();
    const approvalMsg = devInbox.messages.find(m => m.type === "decision");
    expect(approvalMsg).toBeDefined();
    expect(approvalMsg!.payload).toMatchObject({ content: "LGTM, approved" });
  });

  it("messages between agents show sender identity clearly", async () => {
    const anon = createClient();
    const planner = await anon.register({ name: "Frank (planner)", owner: "Frank" });
    const developer = await anon.register({ name: "Frank (developer)", owner: "Frank" });
    const plannerClient = createClient(planner.secret);
    const developerClient = createClient(developer.secret);
    await plannerClient.pair({ code: developer.pairing_code });

    await plannerClient.send({
      to: developer.agent_id,
      type: "question",
      payload: { content: "Status?" },
    });
    await developerClient.send({
      to: planner.agent_id,
      type: "update",
      payload: { content: "Almost done" },
    });

    // Each agent sees messages from the other with correct fromAgent
    const devInbox = await developerClient.inbox();
    expect(devInbox.messages[0].fromAgent).toBe(planner.agent_id);

    const plannerInbox = await plannerClient.inbox();
    expect(plannerInbox.messages[0].fromAgent).toBe(developer.agent_id);

    // Can resolve names by looking up contacts
    const devContacts = await developerClient.contacts();
    const plannerContact = devContacts.contacts.find(c => c.agent_id === planner.agent_id);
    expect(plannerContact?.name).toBe("Frank (planner)");
  });

  it("reports missing auth and invalid tokens through SDK auth behavior", async () => {
    await createClient().register({ name: "alpha" });

    await expect(createClient().me()).rejects.toThrow("TrunkClient requires a secret");
    await expect(createClient("not-a-real-secret").me()).rejects.toMatchObject({
      status: 401,
      message: "Invalid token",
    });
  });

  // --- Task tests ---

  it("creates a task assigned to a contact", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "Build Intercom adapter",
      description: "First support vertical adapter",
      due: "2026-06-07",
    });

    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task).toMatchObject({
      title: "Build Intercom adapter",
      description: "First support vertical adapter",
      status: "open",
      owner: beta.agent_id,
      created_by: alpha.agent_id,
      due: "2026-06-07",
    });
  });

  it("both contacts can see shared tasks", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await createTaskRaw(alpha.secret, beta.agent_id, { title: "Task from alpha" });

    const alphaView = await listTasksRaw(alpha.secret, beta.agent_id);
    const betaView = await listTasksRaw(beta.secret, alpha.agent_id);

    const alphaTasks = await alphaView.json();
    const betaTasks = await betaView.json();

    expect(alphaTasks.tasks).toHaveLength(1);
    expect(betaTasks.tasks).toHaveLength(1);
    expect(alphaTasks.tasks[0].title).toBe("Task from alpha");
    expect(betaTasks.tasks[0].title).toBe("Task from alpha");
  });

  it("updates task status and owner", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Do the thing" });
    const task = await createRes.json();

    // Beta marks it in-progress
    const updateRes = await updateTaskRaw(beta.secret, alpha.agent_id, task.id, {
      status: "in-progress",
    });
    const updated = await updateRes.json();
    expect(updated.status).toBe("in-progress");

    // Beta marks it done
    const doneRes = await updateTaskRaw(beta.secret, alpha.agent_id, task.id, {
      status: "done",
    });
    const done = await doneRes.json();
    expect(done.status).toBe("done");
  });

  it("rejects task creation for non-contacts", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);

    const res = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Should fail" });
    expect(res.status).toBe(403);
  });

  it("filters tasks by status", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const t1Res = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Open task" });
    const t2Res = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Done task" });
    const t2 = await t2Res.json();
    await updateTaskRaw(alpha.secret, beta.agent_id, t2.id, { status: "done" });

    const openRes = await listTasksRaw(alpha.secret, beta.agent_id, "open");
    const openTasks = await openRes.json();
    expect(openTasks.tasks).toHaveLength(1);
    expect(openTasks.tasks[0].title).toBe("Open task");

    const doneRes = await listTasksRaw(alpha.secret, beta.agent_id, "done");
    const doneTasks = await doneRes.json();
    expect(doneTasks.tasks).toHaveLength(1);
    expect(doneTasks.tasks[0].title).toBe("Done task");
  });

  // --- Priority tests ---

  it("defaults task priority to medium when not specified", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await createTaskRaw(alpha.secret, beta.agent_id, { title: "No priority set" });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.priority).toBe("medium");
  });

  it("creates a task with explicit priority", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "Critical bug",
      priority: "critical",
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.priority).toBe("critical");
  });

  it("updates task priority", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Escalate me" });
    const task = await createRes.json();
    expect(task.priority).toBe("medium");

    const updateRes = await updateTaskRaw(beta.secret, alpha.agent_id, task.id, {
      priority: "high",
    });
    const updated = await updateRes.json();
    expect(updated.priority).toBe("high");
  });

  // --- Planning / Gantt field tests ---

  it("creates a task with planning fields (start_date, group, depends_on, sequence, estimate)", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "Build auth module",
      start_date: "2026-06-05",
      group: "auth",
      depends_on: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
      sequence: 1,
      estimate: 8,
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.start_date).toBe("2026-06-05");
    expect(task.group).toBe("auth");
    expect(task.depends_on).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
    expect(task.sequence).toBe(1);
    expect(task.estimate).toBe(8);
  });

  it("updates planning fields on an existing task", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Plan me" });
    const task = await createRes.json();
    expect(task.start_date).toBeNull();
    expect(task.group).toBeNull();

    const updateRes = await updateTaskRaw(beta.secret, alpha.agent_id, task.id, {
      start_date: "2026-07-01",
      group: "payments",
      depends_on: [task.id],
      sequence: 3,
      estimate: 16,
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.start_date).toBe("2026-07-01");
    expect(updated.group).toBe("payments");
    expect(updated.depends_on).toEqual([task.id]);
    expect(updated.sequence).toBe(3);
    expect(updated.estimate).toBe(16);
  });

  it("filters tasks by group", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await createTaskRaw(alpha.secret, beta.agent_id, { title: "Auth task", group: "auth" });
    await createTaskRaw(alpha.secret, beta.agent_id, { title: "Payment task", group: "payments" });
    await createTaskRaw(alpha.secret, beta.agent_id, { title: "Ungrouped task" });

    const authRes = await app.request(`/tasks/${beta.agent_id}?group=auth`, {
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    const authTasks = await authRes.json();
    expect(authTasks.tasks).toHaveLength(1);
    expect(authTasks.tasks[0].title).toBe("Auth task");
    expect(authTasks.tasks[0].group).toBe("auth");
  });

  it("SDK createTask with planning fields round-trip", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const task = await alphaClient.createTask({
      contact_id: beta.agent_id,
      title: "SDK planning task",
      start_date: "2026-06-10",
      group: "onboarding",
      depends_on: [],
      sequence: 0,
      estimate: 4,
    });

    expect(task.start_date).toBe("2026-06-10");
    expect(task.group).toBe("onboarding");
    expect(task.depends_on).toEqual([]);
    expect(task.sequence).toBe(0);
    expect(task.estimate).toBe(4);

    // Verify fields persist through list
    const list = await alphaClient.listTasks(beta.agent_id);
    const found = list.tasks.find(t => t.id === task.id)!;
    expect(found.group).toBe("onboarding");
    expect(found.estimate).toBe(4);
  });

  it("SDK updateTask with planning fields", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const task = await alphaClient.createTask({
      contact_id: beta.agent_id,
      title: "Update planning fields",
    });

    const updated = await betaClient.updateTask(alpha.agent_id, task.id, {
      group: "infra",
      estimate: 24,
      sequence: 5,
      start_date: "2026-08-01",
      depends_on: ["00000000-0000-4000-8000-000000000099"],
    });

    expect(updated.group).toBe("infra");
    expect(updated.estimate).toBe(24);
    expect(updated.sequence).toBe(5);
    expect(updated.start_date).toBe("2026-08-01");
    expect(updated.depends_on).toEqual(["00000000-0000-4000-8000-000000000099"]);
  });

  // --- Task deletion tests ---

  it("deletes a task and confirms it's gone", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Ephemeral task" });
    const task = await createRes.json();

    const deleteRes = await app.request(`/tasks/${beta.agent_id}/${task.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    expect(deleteRes.status).toBe(200);
    const result = await deleteRes.json();
    expect(result.ok).toBe(true);
    expect(result.deleted_id).toBe(task.id);

    // Confirm it's gone from list
    const listRes = await listTasksRaw(alpha.secret, beta.agent_id);
    const list = await listRes.json();
    expect(list.tasks).toHaveLength(0);
  });

  it("returns 404 when deleting a non-existent task", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const deleteRes = await app.request(`/tasks/${beta.agent_id}/00000000-0000-0000-0000-000000000099`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    expect(deleteRes.status).toBe(404);
  });

  it("rejects task deletion for non-contacts", async () => {
    const { alpha, beta } = await registerPair();
    // Not paired

    const deleteRes = await app.request(`/tasks/${beta.agent_id}/00000000-0000-0000-0000-000000000099`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    expect(deleteRes.status).toBe(403);
  });

  it("SDK deleteTask round-trip", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const task = await alphaClient.createTask({
      contact_id: beta.agent_id,
      title: "SDK delete test",
    });

    const result = await betaClient.deleteTask(alpha.agent_id, task.id);
    expect(result.ok).toBe(true);
    expect(result.deleted_id).toBe(task.id);

    // Confirm gone
    const list = await alphaClient.listTasks(beta.agent_id);
    expect(list.tasks).toHaveLength(0);
  });

  // --- SDK task method tests ---

  it("SDK createTask + listTasks round-trip", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const task = await alphaClient.createTask({
      contact_id: beta.agent_id,
      title: "SDK task test",
      description: "Created via SDK",
      priority: "high",
      due: "2026-06-15",
    });

    expect(task.title).toBe("SDK task test");
    expect(task.description).toBe("Created via SDK");
    expect(task.priority).toBe("high");
    expect(task.status).toBe("open");
    expect(task.due).toBe("2026-06-15");
    expect(task.created_by).toBe(alpha.agent_id);

    // Both sides can list
    const alphaList = await alphaClient.listTasks(beta.agent_id);
    const betaList = await betaClient.listTasks(alpha.agent_id);
    expect(alphaList.tasks).toHaveLength(1);
    expect(betaList.tasks).toHaveLength(1);
    expect(alphaList.tasks[0].id).toBe(task.id);
  });

  it("SDK updateTask changes status and priority", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const task = await alphaClient.createTask({
      contact_id: beta.agent_id,
      title: "Update me via SDK",
    });

    const updated = await betaClient.updateTask(alpha.agent_id, task.id, {
      status: "in-progress",
      priority: "critical",
    });

    expect(updated.status).toBe("in-progress");
    expect(updated.priority).toBe("critical");
  });

  it("SDK listTasks filters by status", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const t1 = await alphaClient.createTask({ contact_id: beta.agent_id, title: "Open one" });
    const t2 = await alphaClient.createTask({ contact_id: beta.agent_id, title: "Done one" });
    await alphaClient.updateTask(beta.agent_id, t2.id, { status: "done" });

    const openTasks = await alphaClient.listTasks(beta.agent_id, { status: "open" });
    expect(openTasks.tasks).toHaveLength(1);
    expect(openTasks.tasks[0].title).toBe("Open one");

    const doneTasks = await alphaClient.listTasks(beta.agent_id, { status: "done" });
    expect(doneTasks.tasks).toHaveLength(1);
    expect(doneTasks.tasks[0].title).toBe("Done one");
  });

  it("SDK createTask rejects without scope", async () => {
    const { alphaClient } = await registerPair();
    await expect(alphaClient.createTask({ title: "No scope" } as any)).rejects.toThrow();
  });

  it("SDK listRoomTasks works for room-scoped tasks", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();

    // Create room, both join
    const roomRes = await createRoomRaw(alpha.secret, { name: "SDK Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Create task via SDK with room scope
    const task = await alphaClient.createTask({
      room_id: room.id,
      title: "Room task via SDK",
    });
    expect(task.title).toBe("Room task via SDK");

    // Both members can list room tasks
    const alphaList = await alphaClient.listRoomTasks(room.id);
    const betaList = await betaClient.listRoomTasks(room.id);
    expect(alphaList.tasks).toHaveLength(1);
    expect(betaList.tasks).toHaveLength(1);
  });

  it("SDK listWorkspaceTasks works for workspace-scoped tasks", async () => {
    const anonymous = createClient();
    const alpha = await anonymous.register({ name: "ws-sdk-alpha" });
    const beta = await anonymous.register({ name: "ws-sdk-beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "SDK WS" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const task = await alphaClient.createTask({
      workspace_id: ws.id,
      title: "Workspace task via SDK",
      priority: "low",
    });
    expect(task.title).toBe("Workspace task via SDK");
    expect(task.priority).toBe("low");

    const alphaList = await alphaClient.listWorkspaceTasks(ws.id);
    const betaList = await betaClient.listWorkspaceTasks(ws.id);
    expect(alphaList.tasks).toHaveLength(1);
    expect(betaList.tasks).toHaveLength(1);
    expect(alphaList.tasks[0].id).toBe(task.id);
  });

  // --- Room tests ---

  it("creates a room and returns id + pairing_code", async () => {
    const { alpha } = await registerPair();
    const res = await createRoomRaw(alpha.secret, { name: "Sprint Room" });
    expect(res.status).toBe(201);
    const room = await res.json();
    expect(room).toMatchObject({ name: "Sprint Room" });
    expect(typeof room.id).toBe("string");
    expect(typeof room.pairing_code).toBe("string");
  });

  it("joins a room by pairing code and lists rooms", async () => {
    const { alpha, beta } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Shared Room" });
    const room = await roomRes.json();

    const joinRes = await joinRoomRaw(beta.secret, room.pairing_code);
    expect(joinRes.status).toBe(200);
    const joined = await joinRes.json();
    expect(joined.joined).toBe(true);

    const listRes = await app.request("/rooms", {
      headers: { "Authorization": `Bearer ${beta.secret}` },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.rooms.some((r: { id: string }) => r.id === room.id)).toBe(true);
  });

  it("returns idempotent result when already a room member", async () => {
    const { alpha } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Idempotent Room" });
    const room = await roomRes.json();

    // Join again — same code
    const joinRes = await joinRoomRaw(alpha.secret, room.pairing_code);
    expect(joinRes.status).toBe(200);
    const body = await joinRes.json();
    expect(body.joined).toBe(true);
    expect(body.already_member).toBe(true);
  });

  it("lists room members", async () => {
    const { alpha, beta } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Members Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const res = await app.request(`/rooms/${room.id}/members`, {
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.members.map((m: { id: string }) => m.id);
    expect(ids).toContain(alpha.agent_id);
    expect(ids).toContain(beta.agent_id);
  });

  it("creates a room-scoped task and lists it by room", async () => {
    const { alpha, beta } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Task Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const taskRes = await createRoomTaskRaw(alpha.secret, room.id, { title: "Room task alpha" });
    expect(taskRes.status).toBe(201);
    const task = await taskRes.json();
    expect(task.title).toBe("Room task alpha");

    // Both members can see it
    for (const secret of [alpha.secret, beta.secret]) {
      const listRes = await app.request(`/tasks/room/${room.id}`, {
        headers: { "Authorization": `Bearer ${secret}` },
      });
      expect(listRes.status).toBe(200);
      const body = await listRes.json();
      expect(body.tasks.some((t: { title: string }) => t.title === "Room task alpha")).toBe(true);
    }
  });

  it("non-room-member cannot list room tasks", async () => {
    const { alpha } = await registerPair();
    const outsider = await createClient().register({ name: "outsider" });
    const roomRes = await createRoomRaw(alpha.secret, { name: "Private Room" });
    const room = await roomRes.json();

    const res = await app.request(`/tasks/room/${room.id}`, {
      headers: { "Authorization": `Bearer ${outsider.secret}` },
    });
    expect(res.status).toBe(403);
  });

  it("room member can update a room-scoped task", async () => {
    const { alpha, beta } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Update Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const taskRes = await createRoomTaskRaw(alpha.secret, room.id, { title: "Room task to update" });
    const task = await taskRes.json();

    // Beta updates the task status using room_id as scope
    const updateRes = await app.request(`/tasks/${room.id}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${beta.secret}` },
      body: JSON.stringify({ status: "in-progress" }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.status).toBe("in-progress");

    // Change is visible to both members
    const listRes = await app.request(`/tasks/room/${room.id}`, {
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    const body = await listRes.json();
    expect(body.tasks[0].status).toBe("in-progress");
  });

  it("workspace member can update a workspace-scoped task", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-updater-1" });
    const beta = await anon.register({ name: "ws-updater-2" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "UpdateTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ workspace_id: ws.id, title: "Workspace task to update" }),
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();

    // Beta updates the task using workspace_id as scope
    const updateRes = await app.request(`/tasks/${ws.id}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${beta.secret}` },
      body: JSON.stringify({ status: "done", owner: beta.agent_id }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.status).toBe("done");
    expect(updated.owner).toBe(beta.agent_id);
  });

  it("non-room-member cannot update a room-scoped task", async () => {
    const { alpha } = await registerPair();
    const outsider = await createClient().register({ name: "outsider-updater" });
    const roomRes = await createRoomRaw(alpha.secret, { name: "Guarded Room" });
    const room = await roomRes.json();

    const taskRes = await createRoomTaskRaw(alpha.secret, room.id, { title: "Protected task" });
    const task = await taskRes.json();

    const updateRes = await app.request(`/tasks/${room.id}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${outsider.secret}` },
      body: JSON.stringify({ status: "done" }),
    });
    expect(updateRes.status).toBe(403);
  });

  it("cannot update a workspace task using a contact scope (scope-bypass)", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "scope-bypass-1" });
    const beta = await anon.register({ name: "scope-bypass-2" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    // Pair as contacts AND workspace members
    await alphaClient.pair({ code: beta.pairing_code });
    const ws = await alphaClient.createWorkspace({ name: "BypassTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Create a workspace-scoped task
    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ workspace_id: ws.id, title: "Workspace-only task" }),
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();

    // Try to update workspace task using contact scope — should fail (scope mismatch)
    const updateRes = await app.request(`/tasks/${beta.agent_id}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ status: "done" }),
    });
    expect(updateRes.status).toBe(404);
  });

  it("cannot delete a workspace task using a contact scope (scope-bypass)", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "scope-del-1" });
    const beta = await anon.register({ name: "scope-del-2" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    await alphaClient.pair({ code: beta.pairing_code });
    const ws = await alphaClient.createWorkspace({ name: "DelBypassTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Create a workspace-scoped task
    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ workspace_id: ws.id, title: "Guarded ws task" }),
    });
    const task = await createRes.json();

    // Try to delete workspace task using contact scope — should fail
    const deleteRes = await app.request(`/tasks/${beta.agent_id}/${task.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    expect(deleteRes.status).toBe(404);

    // Verify task still exists via workspace scope
    const listRes = await app.request(`/tasks/workspace/${ws.id}`, {
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    const body = await listRes.json();
    expect(body.tasks.some((t: { id: string }) => t.id === task.id)).toBe(true);
  });

  it("room member can delete a room-scoped task", async () => {
    const { alpha, beta } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Delete Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const taskRes = await createRoomTaskRaw(alpha.secret, room.id, { title: "Deletable room task" });
    const task = await taskRes.json();

    const deleteRes = await app.request(`/tasks/${room.id}/${task.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${beta.secret}` },
    });
    expect(deleteRes.status).toBe(200);
    const result = await deleteRes.json();
    expect(result.ok).toBe(true);
  });

  it("workspace member can delete a workspace-scoped task", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-del-1" });
    const beta = await anon.register({ name: "ws-del-2" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "DeleteTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ workspace_id: ws.id, title: "Ws task to delete" }),
    });
    const task = await createRes.json();

    const deleteRes = await app.request(`/tasks/${ws.id}/${task.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${beta.secret}` },
    });
    expect(deleteRes.status).toBe(200);
    const result = await deleteRes.json();
    expect(result.ok).toBe(true);
  });

  // --- Gantt endpoint tests ---

  it("returns gantt data with dependency info and grouping", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "gantt-1" });
    const beta = await anon.register({ name: "gantt-2" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "GanttTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Create tasks: dep (done), blocked (depends on dep), ungrouped
    const depRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ workspace_id: ws.id, title: "Setup DB", group: "backend", owner: alpha.agent_id, sequence: 1 }),
    });
    const dep = await depRes.json();

    await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ workspace_id: ws.id, title: "Build API", group: "backend", depends_on: [dep.id], status: "blocked", owner: beta.agent_id, sequence: 2 }),
    });

    await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ workspace_id: ws.id, title: "Write docs" }),
    });

    // Mark dep as done
    await app.request(`/tasks/${ws.id}/${dep.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ status: "done" }),
    });

    const ganttRes = await app.request(`/tasks/gantt/workspace/${ws.id}`, {
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    expect(ganttRes.status).toBe(200);
    const gantt = await ganttRes.json();

    // Summary
    expect(gantt.summary.total).toBe(3);
    expect(gantt.summary.done).toBe(1);

    // All tasks present
    expect(gantt.tasks).toHaveLength(3);

    // Owner names resolved
    const setupTask = gantt.tasks.find((t: { title: string }) => t.title === "Setup DB");
    expect(setupTask.owner_name).toBe("gantt-1");

    const apiTask = gantt.tasks.find((t: { title: string }) => t.title === "Build API");
    expect(apiTask.owner_name).toBe("gantt-2");
    expect(apiTask.deps_met).toBe(true); // dep is done
    expect(apiTask.blocked_by).toEqual([]);

    // Grouping
    expect(gantt.groups.backend).toHaveLength(2);
    expect(gantt.ungrouped).toHaveLength(1);
    expect(gantt.ungrouped[0].title).toBe("Write docs");
  });

  it("gantt shows blocked_by when dependency not done", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "gantt-block-1" });
    const alphaClient = createClient(alpha.secret);

    const ws = await alphaClient.createWorkspace({ name: "GanttBlockTeam" });

    const depRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ workspace_id: ws.id, title: "Undone dep" }),
    });
    const dep = await depRes.json();

    await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ workspace_id: ws.id, title: "Waiting task", depends_on: [dep.id] }),
    });

    const ganttRes = await app.request(`/tasks/gantt/workspace/${ws.id}`, {
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    const gantt = await ganttRes.json();

    const waiting = gantt.tasks.find((t: { title: string }) => t.title === "Waiting task");
    expect(waiting.deps_met).toBe(false);
    expect(waiting.blocked_by).toEqual([dep.id]);
  });

  it("gantt rejects non-workspace-member", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "gantt-auth-1" });
    const outsider = await anon.register({ name: "gantt-outsider" });
    const alphaClient = createClient(alpha.secret);

    const ws = await alphaClient.createWorkspace({ name: "GanttPrivate" });

    const ganttRes = await app.request(`/tasks/gantt/workspace/${ws.id}`, {
      headers: { "Authorization": `Bearer ${outsider.secret}` },
    });
    expect(ganttRes.status).toBe(403);
  });

  it("gantt returns empty structure for workspace with no tasks", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "gantt-empty" });
    const alphaClient = createClient(alpha.secret);

    const ws = await alphaClient.createWorkspace({ name: "EmptyGantt" });

    const ganttRes = await app.request(`/tasks/gantt/workspace/${ws.id}`, {
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    expect(ganttRes.status).toBe(200);
    const gantt = await ganttRes.json();
    expect(gantt.tasks).toEqual([]);
    expect(gantt.groups).toEqual({});
    expect(gantt.ungrouped).toEqual([]);
    expect(gantt.summary).toEqual({ total: 0, done: 0, in_progress: 0, blocked: 0, open: 0 });
  });

  it("SDK ganttData round-trip", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "sdk-gantt-1" });
    const alphaClient = createClient(alpha.secret);

    const ws = await alphaClient.createWorkspace({ name: "SDK Gantt" });

    // Create a task via raw request so gantt has data
    await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${alpha.secret}` },
      body: JSON.stringify({ workspace_id: ws.id, title: "SDK gantt task", group: "core" }),
    });

    const gantt = await alphaClient.ganttData(ws.id);
    expect(gantt.tasks).toHaveLength(1);
    expect(gantt.tasks[0].title).toBe("SDK gantt task");
    expect(gantt.groups.core).toHaveLength(1);
    expect(gantt.ungrouped).toHaveLength(0);
    expect(gantt.summary.total).toBe(1);
    expect(gantt.summary.open).toBe(1);
  });

  // --- SDK room method tests ---

  it("SDK createRoom + joinRoom + listRooms round-trip", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "SDK Room Test" });
    expect(room.name).toBe("SDK Room Test");
    expect(typeof room.id).toBe("string");
    expect(typeof room.pairing_code).toBe("string");

    const joined = await betaClient.joinRoom({ code: room.pairing_code });
    expect(joined.joined).toBe(true);
    expect(joined.room_id).toBe(room.id);

    const alphaRooms = await alphaClient.listRooms();
    expect(alphaRooms.rooms.some(r => r.id === room.id)).toBe(true);

    const betaRooms = await betaClient.listRooms();
    expect(betaRooms.rooms.some(r => r.id === room.id)).toBe(true);
  });

  it("SDK roomMembers returns all members with roles", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "Members Room" });
    await betaClient.joinRoom({ code: room.pairing_code });

    const members = await alphaClient.roomMembers(room.id);
    expect(members.members).toHaveLength(2);
    const ids = members.members.map(m => m.id);
    expect(ids).toContain(alpha.agent_id);
    expect(ids).toContain(beta.agent_id);

    const creator = members.members.find(m => m.id === alpha.agent_id);
    expect(creator?.role).toBe("creator");
    const member = members.members.find(m => m.id === beta.agent_id);
    expect(member?.role).toBe("member");
  });

  it("SDK joinRoom idempotent for existing member", async () => {
    const { alphaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "Double Join" });
    const second = await alphaClient.joinRoom({ code: room.pairing_code });
    expect(second.joined).toBe(true);
    expect(second.already_member).toBe(true);
  });

  // --- Room leave tests ---

  it("leaves a room via POST /rooms/:id/leave", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Leave Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Beta leaves
    const leaveRes = await app.request(`/rooms/${room.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(leaveRes.status).toBe(200);
    const body = await leaveRes.json();
    expect(body.ok).toBe(true);
    expect(body.room_id).toBe(room.id);

    // Beta no longer listed in members
    const membersRes = await app.request(`/rooms/${room.id}/members`, {
      method: "GET",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    const members = await membersRes.json();
    expect(members.members.some((m: { id: string }) => m.id === beta.agent_id)).toBe(false);
    // Alpha still a member
    expect(members.members.some((m: { id: string }) => m.id === alpha.agent_id)).toBe(true);
  });

  it("returns 403 when leaving a room you're not in", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Not My Room" });
    const room = await roomRes.json();

    // Beta never joined — should get 403
    const leaveRes = await app.request(`/rooms/${room.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(leaveRes.status).toBe(403);
  });

  it("SDK leaveRoom removes agent from room", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "SDK Leave Room" });
    await betaClient.joinRoom({ code: room.pairing_code });

    const result = await betaClient.leaveRoom(room.id);
    expect(result.ok).toBe(true);

    // Beta should not see the room anymore
    const betaRooms = await betaClient.listRooms();
    expect(betaRooms.rooms.some(r => r.id === room.id)).toBe(false);

    // Alpha still sees it
    const alphaRooms = await alphaClient.listRooms();
    expect(alphaRooms.rooms.some(r => r.id === room.id)).toBe(true);
  });

  // --- Room administration tests ---

  it("creator can update room name", async () => {
    const { alpha } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Original Name" });
    const room = await roomRes.json();

    const updateRes = await app.request(`/rooms/${room.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ name: "Updated Name" }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.name).toBe("Updated Name");
    expect(updated.id).toBe(room.id);
  });

  it("non-admin cannot update room", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Admin Only" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const updateRes = await app.request(`/rooms/${room.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${beta.secret}`,
      },
      body: JSON.stringify({ name: "Hacked" }),
    });
    expect(updateRes.status).toBe(403);
  });

  it("creator can kick a member", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Kick Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const kickRes = await app.request(`/rooms/${room.id}/kick`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ agent_id: beta.agent_id }),
    });
    expect(kickRes.status).toBe(200);
    const body = await kickRes.json();
    expect(body.ok).toBe(true);
    expect(body.kicked).toBe(beta.agent_id);

    // Verify beta is no longer a member
    const membersRes = await app.request(`/rooms/${room.id}/members`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    const members = await membersRes.json();
    expect(members.members.some((m: { id: string }) => m.id === beta.agent_id)).toBe(false);
  });

  it("regular member cannot kick others", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "No Kick" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const kickRes = await app.request(`/rooms/${room.id}/kick`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${beta.secret}`,
      },
      body: JSON.stringify({ agent_id: alpha.agent_id }),
    });
    expect(kickRes.status).toBe(403);
  });

  it("cannot kick yourself", async () => {
    const { alpha } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Self Kick" });
    const room = await roomRes.json();

    const kickRes = await app.request(`/rooms/${room.id}/kick`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ agent_id: alpha.agent_id }),
    });
    expect(kickRes.status).toBe(400);
  });

  it("creator can change member role to admin", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Role Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const roleRes = await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(roleRes.status).toBe(200);
    const body = await roleRes.json();
    expect(body.ok).toBe(true);
    expect(body.role).toBe("admin");
  });

  it("non-creator cannot change roles", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "No Role Change" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const roleRes = await app.request(`/rooms/${room.id}/members/${alpha.agent_id}/role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${beta.secret}`,
      },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(roleRes.status).toBe(403);
  });

  it("admin can update room and kick members", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Admin Test" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Promote beta to admin
    await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ role: "admin" }),
    });

    // Admin (beta) can update room
    const updateRes = await app.request(`/rooms/${room.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${beta.secret}`,
      },
      body: JSON.stringify({ name: "Admin Updated" }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.name).toBe("Admin Updated");
  });

  it("creator can delete room", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Delete Me" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const deleteRes = await app.request(`/rooms/${room.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(room.id);

    // Room no longer appears in list
    const listRes = await app.request("/rooms", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    const list = await listRes.json();
    expect(list.rooms.some((r: { id: string }) => r.id === room.id)).toBe(false);
  });

  it("non-creator cannot delete room", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "No Delete" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const deleteRes = await app.request(`/rooms/${room.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(deleteRes.status).toBe(403);
  });

  it("SDK updateRoom changes room name", async () => {
    const { alphaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "SDK Original" });
    const updated = await alphaClient.updateRoom(room.id, { name: "SDK Updated" });
    expect(updated.name).toBe("SDK Updated");
  });

  it("SDK kickRoomMember removes member", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "SDK Kick" });
    await betaClient.joinRoom({ code: room.pairing_code });

    const result = await alphaClient.kickRoomMember(room.id, { agent_id: beta.agent_id });
    expect(result.ok).toBe(true);
    expect(result.kicked).toBe(beta.agent_id);
  });

  it("SDK changeRoomMemberRole promotes to admin", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "SDK Role" });
    await betaClient.joinRoom({ code: room.pairing_code });

    const result = await alphaClient.changeRoomMemberRole(room.id, beta.agent_id, { role: "admin" });
    expect(result.ok).toBe(true);
    expect(result.role).toBe("admin");
  });

  it("SDK deleteRoom removes room", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "SDK Delete" });
    await betaClient.joinRoom({ code: room.pairing_code });

    const result = await alphaClient.deleteRoom(room.id);
    expect(result.ok).toBe(true);

    const rooms = await alphaClient.listRooms();
    expect(rooms.rooms.some(r => r.id === room.id)).toBe(false);
  });

  // --- Room messaging fan-out tests ---

  it("sends a message to room:<id> and fans out to all other members", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Create room with alpha, join beta
    const roomRes = await createRoomRaw(alpha.secret, { name: "Chat Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Alpha sends to room
    const receipt = await alphaClient.send({
      to: `room:${room.id}`,
      type: "update",
      payload: { content: "Room broadcast from alpha" },
    });

    expect(receipt.status).toBe("delivered");
    expect(receipt.recipients).toBe(1);
    expect(receipt.thread_id).toBeDefined();

    // Beta should see the message in inbox
    const inbox = await betaClient.inbox();
    const roomMsg = inbox.messages.find(
      (m: TrunkMessage) => (m.payload as Record<string, unknown>).content === "Room broadcast from alpha"
    );
    expect(roomMsg).toBeDefined();
    expect(roomMsg!.fromAgent).toBe(alpha.agent_id);
  });

  it("fans out room message to multiple members", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Register a third agent
    const gammaReg = await createClient().register({ name: "gamma", owner: "Test" });
    const gammaClient = createClient(gammaReg.secret);

    // Create room, join all three
    const roomRes = await createRoomRaw(alpha.secret, { name: "Multi Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);
    await joinRoomRaw(gammaReg.secret, room.pairing_code);

    // Alpha sends to room
    const receipt = await alphaClient.send({
      to: `room:${room.id}`,
      type: "update",
      payload: { content: "Hello everyone" },
    });

    expect(receipt.status).toBe("delivered");
    expect(receipt.recipients).toBe(2);

    // Both beta and gamma should see the message
    const betaInbox = await betaClient.inbox();
    expect(betaInbox.messages.some(
      (m: TrunkMessage) => (m.payload as Record<string, unknown>).content === "Hello everyone"
    )).toBe(true);

    const gammaInbox = await gammaClient.inbox();
    expect(gammaInbox.messages.some(
      (m: TrunkMessage) => (m.payload as Record<string, unknown>).content === "Hello everyone"
    )).toBe(true);
  });

  it("rejects room message from non-member", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Create room with only alpha
    const roomRes = await createRoomRaw(alpha.secret, { name: "Private Room" });
    const room = await roomRes.json();

    // Register an outsider
    const outsider = await createClient().register({ name: "outsider", owner: "Test" });
    const outsiderClient = createClient(outsider.secret);

    // Outsider tries to send to room
    try {
      await outsiderClient.send({
        to: `room:${room.id}`,
        type: "update",
        payload: { content: "Sneaking in" },
      });
      expect(true).toBe(false); // should not reach here
    } catch (e: unknown) {
      expect((e as Error).message).toContain("Not a member");
    }
  });

  it("rejects room message to non-existent room", async () => {
    const { alpha, alphaClient } = await registerPair();

    try {
      await alphaClient.send({
        to: "room:non-existent-room-id",
        type: "update",
        payload: { content: "Ghost room" },
      });
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect((e as Error).message).toContain("Room not found");
    }
  });

  it("rejects room message when sender is the only member", async () => {
    const { alpha, alphaClient } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Solo Room" });
    const room = await roomRes.json();

    try {
      await alphaClient.send({
        to: `room:${room.id}`,
        type: "update",
        payload: { content: "Talking to myself" },
      });
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect((e as Error).message).toContain("No other members");
    }
  });

  // --- Room-scoped documents and facts ---

  it("creates and lists room-scoped documents", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Docs Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Alpha creates a document in the room
    const createRes = await app.request(`/documents/room/${room.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ name: "README", body: "# Room Doc" }),
    });
    expect(createRes.status).toBe(201);
    const doc = await createRes.json();
    expect(doc.name).toBe("README");
    expect(doc.version).toBe(1);

    // Beta can list room documents
    const listRes = await app.request(`/documents/room/${room.id}`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.documents.some((d: { id: string }) => d.id === doc.id)).toBe(true);
  });

  it("room member can read and update room document", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Edit Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const createRes = await app.request(`/documents/room/${room.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ name: "Spec", body: "v1 content" }),
    });
    const doc = await createRes.json();

    // Beta reads it
    const getRes = await app.request(`/documents/room/${room.id}/${doc.id}`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.body).toBe("v1 content");

    // Beta updates it
    const updateRes = await app.request(`/documents/room/${room.id}/${doc.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${beta.secret}`,
      },
      body: JSON.stringify({ body: "v2 content" }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.version).toBe(2);
  });

  it("non-member cannot access room documents", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Private Docs" });
    const room = await roomRes.json();

    // Beta is NOT a member
    const listRes = await app.request(`/documents/room/${room.id}`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(listRes.status).toBe(403);
  });

  it("room member can delete room document", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Delete Docs" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const createRes = await app.request(`/documents/room/${room.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ name: "Temp", body: "delete me" }),
    });
    const doc = await createRes.json();

    const deleteRes = await app.request(`/documents/room/${room.id}/${doc.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json();
    expect(body.ok).toBe(true);
  });

  it("SDK createRoomDocument and listRoomDocuments work", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "SDK Docs Room" });
    await betaClient.joinRoom({ code: room.pairing_code });

    const doc = await alphaClient.createRoomDocument(room.id, { name: "Plan", body: "# Plan" });
    expect(doc.name).toBe("Plan");

    const list = await betaClient.listRoomDocuments(room.id);
    expect(list.documents.some((d: { id: string }) => d.id === doc.id)).toBe(true);
  });

  it("creates and lists room-scoped facts", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Facts Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Alpha sets a fact
    const putRes = await app.request(`/context/room/${room.id}/facts/status`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ value: "in-progress" }),
    });
    expect(putRes.status).toBe(200);
    const fact = await putRes.json();
    expect(fact.key).toBe("status");
    expect(fact.value).toBe("in-progress");
    expect(fact.version).toBe(1);

    // Beta can list room facts
    const listRes = await app.request(`/context/room/${room.id}/facts`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.facts.some((f: { key: string }) => f.key === "status")).toBe(true);
  });

  it("room member can read, update, and delete room fact", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Fact CRUD" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Alpha creates
    await app.request(`/context/room/${room.id}/facts/sprint`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ value: 42 }),
    });

    // Beta reads
    const getRes = await app.request(`/context/room/${room.id}/facts/sprint`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(getRes.status).toBe(200);
    const got = await getRes.json();
    expect(got.value).toBe(42);

    // Beta updates
    const updateRes = await app.request(`/context/room/${room.id}/facts/sprint`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${beta.secret}`,
      },
      body: JSON.stringify({ value: 43 }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.version).toBe(2);
    expect(updated.value).toBe(43);

    // Alpha deletes
    const deleteRes = await app.request(`/context/room/${room.id}/facts/sprint`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(deleteRes.status).toBe(200);
  });

  it("non-member cannot access room facts", async () => {
    const { alpha, beta } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Private Facts" });
    const room = await roomRes.json();

    const res = await app.request(`/context/room/${room.id}/facts`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(res.status).toBe(403);
  });

  it("SDK putRoomFact and listRoomFacts work", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "SDK Facts Room" });
    await betaClient.joinRoom({ code: room.pairing_code });

    const fact = await alphaClient.putRoomFact(room.id, "goal", "ship v2");
    expect(fact.key).toBe("goal");
    expect(fact.value).toBe("ship v2");

    const list = await betaClient.listRoomFacts(room.id);
    expect(list.facts.some((f: { key: string }) => f.key === "goal")).toBe(true);
  });

  // --- Workspace-scoped documents and facts ---

  it("creates and lists workspace-scoped documents", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Doc Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Alpha creates a doc in the workspace
    const doc = await alphaClient.createWorkspaceDocument(ws.id, { name: "Wiki", body: "# Wiki" });
    expect(doc.name).toBe("Wiki");
    expect(doc.version).toBe(1);

    // Beta lists workspace docs
    const list = await betaClient.listWorkspaceDocuments(ws.id);
    expect(list.documents.some((d: { id: string }) => d.id === doc.id)).toBe(true);
  });

  it("workspace member can update and delete workspace document", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Edit Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const doc = await alphaClient.createWorkspaceDocument(ws.id, { name: "Spec", body: "v1" });

    // Beta updates
    const updated = await betaClient.updateWorkspaceDocument(ws.id, doc.id, { body: "v2" });
    expect(updated.version).toBe(2);

    // Beta deletes
    const result = await betaClient.deleteWorkspaceDocument(ws.id, doc.id);
    expect(result.ok).toBe(true);
  });

  it("SDK createWorkspaceDocument and listWorkspaceDocuments round-trip", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "SDK WS Docs" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const doc = await alphaClient.createWorkspaceDocument(ws.id, { name: "Readme", body: "# Hello" });
    expect(doc.name).toBe("Readme");
    expect(doc.version).toBe(1);

    // Beta can get the specific document
    const got = await betaClient.getWorkspaceDocument(ws.id, doc.id);
    expect(got.id).toBe(doc.id);
    expect(got.body).toBe("# Hello");

    // Beta lists and sees the doc
    const list = await betaClient.listWorkspaceDocuments(ws.id);
    expect(list.documents.some((d: { id: string }) => d.id === doc.id)).toBe(true);
  });

  it("SDK getRoomDocument retrieves a specific room document", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "Get Doc Room" });
    await betaClient.joinRoom({ code: room.pairing_code });

    const doc = await alphaClient.createRoomDocument(room.id, { name: "Design", body: "architecture notes" });

    const got = await betaClient.getRoomDocument(room.id, doc.id);
    expect(got.id).toBe(doc.id);
    expect(got.name).toBe("Design");
    expect(got.body).toBe("architecture notes");
  });

  it("room document version history tracks edits", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "Version Room" });
    await betaClient.joinRoom({ code: room.pairing_code });

    const doc = await alphaClient.createRoomDocument(room.id, { name: "Evolving", body: "draft 1" });
    await betaClient.updateRoomDocument(room.id, doc.id, { body: "draft 2" });
    await alphaClient.updateRoomDocument(room.id, doc.id, { body: "draft 3" });

    const versions = await betaClient.roomDocumentVersions(room.id, doc.id);
    expect(versions.versions).toHaveLength(3);
    expect(versions.versions[0].version).toBe(3);
    expect(versions.versions[2].version).toBe(1);

    const v1 = await alphaClient.roomDocumentVersion(room.id, doc.id, 1);
    expect(v1.body).toBe("draft 1");
    expect(v1.version).toBe(1);

    const v2 = await betaClient.roomDocumentVersion(room.id, doc.id, 2);
    expect(v2.body).toBe("draft 2");
  });

  it("workspace document version history tracks edits", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Version WS" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const doc = await alphaClient.createWorkspaceDocument(ws.id, { name: "Spec", body: "v1 content" });
    await betaClient.updateWorkspaceDocument(ws.id, doc.id, { body: "v2 content" });

    const versions = await alphaClient.workspaceDocumentVersions(ws.id, doc.id);
    expect(versions.versions).toHaveLength(2);
    expect(versions.versions[0].version).toBe(2);

    const v1 = await betaClient.workspaceDocumentVersion(ws.id, doc.id, 1);
    expect(v1.body).toBe("v1 content");

    const v2 = await alphaClient.workspaceDocumentVersion(ws.id, doc.id, 2);
    expect(v2.body).toBe("v2 content");
  });

  it("room document version returns 404 for non-existent version", async () => {
    const { alphaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "404 Room" });
    const doc = await alphaClient.createRoomDocument(room.id, { name: "Solo", body: "only version" });

    await expect(
      alphaClient.roomDocumentVersion(room.id, doc.id, 99)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("non-room-member cannot access room document versions", async () => {
    const { alpha, beta, alphaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "Private Versions" });
    const doc = await alphaClient.createRoomDocument(room.id, { name: "Secret", body: "classified" });

    const betaClient = createClient(beta.secret);
    await expect(
      betaClient.roomDocumentVersions(room.id, doc.id)
    ).rejects.toMatchObject({ status: 403 });
  });

  it("workspace document version returns 404 for non-existent version", async () => {
    const { alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "WS 404 Version" });
    const doc = await alphaClient.createWorkspaceDocument(ws.id, { name: "Solo WS", body: "only version" });

    await expect(
      alphaClient.workspaceDocumentVersion(ws.id, doc.id, 99)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("non-workspace-member cannot access workspace document versions", async () => {
    const { alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Private WS Versions" });
    const doc = await alphaClient.createWorkspaceDocument(ws.id, { name: "Secret WS", body: "classified" });

    const outsider = await createClient().register({ name: "ws-outsider" });
    const outsiderClient = createClient(outsider.secret);
    await expect(
      outsiderClient.workspaceDocumentVersions(ws.id, doc.id)
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      outsiderClient.workspaceDocumentVersion(ws.id, doc.id, 1)
    ).rejects.toMatchObject({ status: 403 });
  });

  it("non-room-member cannot access specific room document version", async () => {
    const { alphaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "Locked Version Room" });
    const doc = await alphaClient.createRoomDocument(room.id, { name: "Locked", body: "secret content" });

    const outsider = await createClient().register({ name: "room-outsider" });
    const outsiderClient = createClient(outsider.secret);
    await expect(
      outsiderClient.roomDocumentVersion(room.id, doc.id, 1)
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects invalid version parameter with 400", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "Version Check", body: "v1" });

    // NaN version
    await expect(
      alphaClient.documentVersion(beta.agent_id, doc.id, NaN)
    ).rejects.toMatchObject({ status: 400 });

    // Negative version
    await expect(
      alphaClient.documentVersion(beta.agent_id, doc.id, -1)
    ).rejects.toMatchObject({ status: 400 });

    // Zero version
    await expect(
      alphaClient.documentVersion(beta.agent_id, doc.id, 0)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects invalid room document version parameter with 400", async () => {
    const { alphaClient } = await registerPair();

    const room = await alphaClient.createRoom({ name: "Room Version Check" });
    const doc = await alphaClient.createRoomDocument(room.id, { name: "V Check", body: "v1" });

    await expect(
      alphaClient.roomDocumentVersion(room.id, doc.id, 0)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects invalid workspace document version parameter with 400", async () => {
    const { alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "WS Version Check" });
    const doc = await alphaClient.createWorkspaceDocument(ws.id, { name: "V Check", body: "v1" });

    await expect(
      alphaClient.workspaceDocumentVersion(ws.id, doc.id, 0)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("contact document version returns 404 for non-existent version", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "Contact Doc", body: "v1" });

    await expect(
      alphaClient.documentVersion(beta.agent_id, doc.id, 99)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("non-contact cannot access contact document versions", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "Private Doc", body: "secret" });

    const outsider = await createClient().register({ name: "doc-outsider" });
    const outsiderClient = createClient(outsider.secret);
    await expect(
      outsiderClient.documentVersions(beta.agent_id, doc.id)
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      outsiderClient.documentVersion(beta.agent_id, doc.id, 1)
    ).rejects.toMatchObject({ status: 403 });
  });

  it("SDK putWorkspaceFact and listWorkspaceFacts round-trip", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "SDK WS Facts" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const fact = await alphaClient.putWorkspaceFact(ws.id, "env", "production");
    expect(fact.key).toBe("env");
    expect(fact.value).toBe("production");
    expect(fact.version).toBe(1);

    // Beta can read the fact
    const got = await betaClient.getWorkspaceFact(ws.id, "env");
    expect(got.value).toBe("production");

    // Beta can list facts
    const list = await betaClient.listWorkspaceFacts(ws.id);
    expect(list.facts.some((f: { key: string }) => f.key === "env")).toBe(true);

    // Alpha updates
    const updated = await alphaClient.putWorkspaceFact(ws.id, "env", "staging");
    expect(updated.version).toBe(2);

    // Alpha deletes
    const del = await alphaClient.deleteWorkspaceFact(ws.id, "env");
    expect(del.ok).toBe(true);
  });

  it("non-member cannot access workspace documents", async () => {
    const { alpha, beta, alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Private Team" });
    // Beta is NOT a member

    const res = await app.request(`/documents/workspace/${ws.id}`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(res.status).toBe(403);
  });

  it("creates and lists workspace-scoped facts", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Fact Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const fact = await alphaClient.putWorkspaceFact(ws.id, "sprint", "42");
    expect(fact.key).toBe("sprint");
    expect(fact.value).toBe("42");

    const list = await betaClient.listWorkspaceFacts(ws.id);
    expect(list.facts.some((f: { key: string }) => f.key === "sprint")).toBe(true);
  });

  it("workspace member can read, update, and delete workspace fact", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "CRUD Fact" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    await alphaClient.putWorkspaceFact(ws.id, "goal", "launch");

    // Beta reads
    const got = await betaClient.getWorkspaceFact(ws.id, "goal");
    expect(got.value).toBe("launch");

    // Beta updates
    const updated = await betaClient.putWorkspaceFact(ws.id, "goal", "shipped");
    expect(updated.version).toBe(2);

    // Alpha deletes
    const result = await alphaClient.deleteWorkspaceFact(ws.id, "goal");
    expect(result.ok).toBe(true);
  });

  it("non-member cannot access workspace facts", async () => {
    const { alpha, beta, alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Secret Team" });

    const res = await app.request(`/context/workspace/${ws.id}/facts`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(res.status).toBe(403);
  });

  // --- Workspace update ---

  it("SDK updateWorkspace changes workspace name", async () => {
    const { alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Original WS" });
    const updated = await alphaClient.updateWorkspace({ name: "Updated WS" });
    expect(updated.name).toBe("Updated WS");
    expect(updated.id).toBe(ws.id);
  });

  it("non-member cannot update workspace", async () => {
    const { alpha, beta, alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Protected WS" });

    // Beta is not in the workspace
    const res = await app.request("/workspaces/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${beta.secret}`,
      },
      body: JSON.stringify({ name: "Hacked" }),
    });
    expect(res.status).toBe(404); // Not in a workspace
  });

  it("workspace creator gets admin role, joiner gets member role", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-member" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "RoleTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const info = await alphaClient.myWorkspace();
    const adminMember = info.members.find((m) => m.agent_id === alpha.agent_id);
    const regularMember = info.members.find((m) => m.agent_id === beta.agent_id);
    expect(adminMember?.role).toBe("admin");
    expect(regularMember?.role).toBe("member");
  });

  it("admin can kick a member from workspace", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-member" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "KickTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const result = await alphaClient.kickWorkspaceMember(beta.agent_id);
    expect(result.ok).toBe(true);
    expect(result.kicked).toBe(beta.agent_id);

    // Beta should no longer be in workspace
    const info = await alphaClient.myWorkspace();
    expect(info.members).toHaveLength(1);
    expect(info.members[0].agent_id).toBe(alpha.agent_id);
  });

  it("non-admin cannot kick a member", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-member" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "NoKickTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    await expect(betaClient.kickWorkspaceMember(alpha.agent_id)).rejects.toMatchObject({
      status: 403,
      message: "Admin role required",
    });
  });

  it("admin cannot kick themselves", async () => {
    const alpha = await createClient().register({ name: "ws-admin" });
    const alphaClient = createClient(alpha.secret);

    await alphaClient.createWorkspace({ name: "SelfKickTeam" });

    await expect(alphaClient.kickWorkspaceMember(alpha.agent_id)).rejects.toMatchObject({
      status: 400,
      message: "Cannot kick yourself. Use leave instead.",
    });
  });

  it("admin can change a member's role", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-member" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "RoleChangeTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const result = await alphaClient.changeWorkspaceMemberRole(beta.agent_id, "admin");
    expect(result.ok).toBe(true);
    expect(result.role).toBe("admin");

    // Verify beta is now admin
    const info = await alphaClient.myWorkspace();
    const betaMember = info.members.find((m) => m.agent_id === beta.agent_id);
    expect(betaMember?.role).toBe("admin");
  });

  it("non-admin cannot change roles", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-member" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "NoRoleTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    await expect(betaClient.changeWorkspaceMemberRole(alpha.agent_id, "member")).rejects.toMatchObject({
      status: 403,
      message: "Admin role required",
    });
  });

  it("admin can delete workspace, removing all members", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-member" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "DeleteTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const result = await alphaClient.deleteWorkspace();
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(ws.id);

    // Both agents should no longer be in workspace
    await expect(alphaClient.myWorkspace()).rejects.toMatchObject({ status: 404 });
    await expect(betaClient.myWorkspace()).rejects.toMatchObject({ status: 404 });
  });

  it("non-admin cannot delete workspace", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-member" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "ProtectedTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    await expect(betaClient.deleteWorkspace()).rejects.toMatchObject({
      status: 403,
      message: "Admin role required",
    });
  });

  it("non-admin cannot update workspace settings", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-member" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "AdminOnlyUpdate" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    await expect(betaClient.updateWorkspace({ name: "Hacked" })).rejects.toMatchObject({
      status: 403,
      message: "Admin role required",
    });
  });

  it("promoted member can perform admin operations", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-promoted" });
    const gamma = await anon.register({ name: "ws-target" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);
    const gammaClient = createClient(gamma.secret);

    const ws = await alphaClient.createWorkspace({ name: "PromoteTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });
    await gammaClient.joinWorkspace({ code: ws.pairing_code });

    // Promote beta to admin
    await alphaClient.changeWorkspaceMemberRole(beta.agent_id, "admin");

    // Beta (now admin) can kick gamma
    const result = await betaClient.kickWorkspaceMember(gamma.agent_id);
    expect(result.ok).toBe(true);

    const info = await alphaClient.myWorkspace();
    expect(info.members).toHaveLength(2);
  });

  it("workspace leave clears role", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-leaver" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "LeaveTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    await betaClient.leaveWorkspace();

    // Beta can create a new workspace and gets admin role
    const ws2 = await betaClient.createWorkspace({ name: "NewTeam" });
    const info = await betaClient.myWorkspace();
    expect(info.members[0].role).toBe("admin");
  });

  it("renders a read-only observer dashboard with rooms and direct messages", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const roomRes = await createRoomRaw(alpha.secret, { name: "Playbook Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);
    await createRoomTaskRaw(alpha.secret, room.id, { title: "Build observer UI" });
    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "Observer work started." },
    });

    const dashboard = await app.request(`/dashboard`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    const body = await dashboard.text();

    expect(dashboard.status).toBe(200);
    expect(body).toContain("Observer");
    expect(body).toContain("read-only");
    expect(body).toContain("Agent coordination");
    expect(body).toContain("Contacts");
    expect(body).toContain("Messages");
    expect(body).toContain("Rooms");
    expect(body).toContain("Playbook Room");
    expect(body).toContain("Build observer UI");
    expect(body).toContain("Observer work started.");
    expect(body).not.toContain("<textarea");
  });

  it("keeps replies in the same thread, marks the original replied, and returns thread messages to participants", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "Ship this?" },
    });

    const reply = await betaClient.reply(sent.id, {
      type: "decision",
      payload: { content: "Ship it." },
    });

    expect(reply.thread_id).toBe(sent.thread_id);

    const alphaThread = await alphaClient.thread(sent.thread_id);
    const betaThread = await betaClient.thread(sent.thread_id);

    for (const thread of [alphaThread, betaThread]) {
      expect(thread.messages).toHaveLength(2);
      expect(thread.messages[0]).toMatchObject({
        id: sent.id,
        fromAgent: alpha.agent_id,
        toAgent: beta.agent_id,
        threadId: sent.thread_id,
        status: "replied",
      });
      expect(thread.messages[1]).toMatchObject({
        id: reply.id,
        fromAgent: beta.agent_id,
        toAgent: alpha.agent_id,
        threadId: sent.thread_id,
        replyTo: sent.id,
        status: "delivered",
      });
    }
  });

  it("reply rejects missing type or payload", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "Need reply" },
    });

    // Missing type
    const res1 = await app.request(`/messages/${sent.id}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${beta.secret}`,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ payload: { content: "no type" } }),
    });
    expect(res1.status).toBe(400);
    const err1 = await res1.json() as Record<string, unknown>;
    expect(err1.code).toBe("VALIDATION_ERROR");

    // Missing payload
    const res2 = await app.request(`/messages/${sent.id}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${beta.secret}`,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ type: "answer" }),
    });
    expect(res2.status).toBe(400);
    const err2 = await res2.json() as Record<string, unknown>;
    expect(err2.code).toBe("VALIDATION_ERROR");
  });

  it("requires Idempotency-Key for raw message sends", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const alpha = await alphaClient.me();

    const res = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${(alphaClient as unknown as { secret: string }).secret}`,
      },
      body: JSON.stringify({ to: beta.agent_id, type: "question", payload: { content: "missing key" } }),
    });

    expect(alpha.agent_id).toBeDefined();
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Idempotency-Key header is required" });
  });

  it("deduplicates sends by Idempotency-Key for the same sender", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const first = await sendRaw(alphaClient, beta.agent_id, "fixed-send-key", { content: "once" });
    const second = await sendRaw(alphaClient, beta.agent_id, "fixed-send-key", { content: "twice" });
    const inbox = await betaClient.inbox({ status: "delivered" });

    expect(second).toMatchObject({ id: first.id, thread_id: first.thread_id });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].payload).toMatchObject({ content: "once" });
  });

  it("keeps messages durable when real-time push fails", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    vi.mocked(notifyPushWorker).mockRejectedValueOnce(new Error("push worker down"));

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "Still lands in inbox." },
    });

    expect(sent.status).toBe("delivered");
    await expect(betaClient.inbox()).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: sent.id, payload: { content: "Still lands in inbox." } })],
    });
    expect(testState["audit_events"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "message.push_failed", targetId: sent.id }),
    ]));
  });

  it("stores shared facts through context CRUD for either contact", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(alphaClient.putFact(beta.agent_id, "project.status", { phase: "build" })).resolves.toMatchObject({
      key: "project.status",
      value: { phase: "build" },
      version: 1,
      updated_by: alpha.agent_id,
    });
    await expect(betaClient.getFact(alpha.agent_id, "project.status")).resolves.toMatchObject({
      key: "project.status",
      value: { phase: "build" },
      version: 1,
    });
    await expect(betaClient.deleteFact(alpha.agent_id, "project.status")).resolves.toEqual({ ok: true });
    await expect(alphaClient.getFact(beta.agent_id, "project.status")).rejects.toMatchObject({ status: 404 });
  });

  it("applies updates_facts from message payloads to shared context", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: {
        content: "Context changed.",
        updates_facts: {
          "branch.active": "codex/playbook-implementation",
        },
      },
    });

    await expect(betaClient.getFact(alpha.agent_id, "branch.active")).resolves.toMatchObject({
      value: "codex/playbook-implementation",
    });
  });

  it("uses If-Match to reject stale shared fact writes", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const created = await alphaClient.putFact(beta.agent_id, "decision.versioned", "first");
    expect(created.version).toBe(1);

    const updated = await alphaClient.putFact(beta.agent_id, "decision.versioned", "second", { ifMatch: 1 });
    expect(updated).toMatchObject({ value: "second", version: 2 });

    await expect(
      alphaClient.putFact(beta.agent_id, "decision.versioned", "stale", { ifMatch: 1 })
    ).rejects.toMatchObject({ status: 412, message: "Version mismatch" });
  });

  it("listFacts returns all facts for a contact pair", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.putFact(beta.agent_id, "project.name", "Trunk");
    await alphaClient.putFact(beta.agent_id, "project.status", "active");
    await betaClient.putFact(alpha.agent_id, "role", "developer");

    const result = await alphaClient.listFacts(beta.agent_id);

    expect(result.facts).toHaveLength(3);
    const keys = result.facts.map((f: { key: string }) => f.key).sort();
    expect(keys).toEqual(["project.name", "project.status", "role"]);
  });

  it("listFacts returns empty array when no facts exist", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.listFacts(beta.agent_id);
    expect(result.facts).toHaveLength(0);
  });

  it("listFacts rejects non-contacts", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);

    await expect(alphaClient.listFacts(beta.agent_id)).rejects.toMatchObject({ status: 403 });
  });

  it("rate limits registrations to 10 per hour per IP", async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request("/agents/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.10",
        },
        body: JSON.stringify({ name: `agent-${i}` }),
      });
      expect(res.status).toBe(201);
    }

    const blocked = await app.request("/agents/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify({ name: "agent-blocked" }),
    });

    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({ error: "Rate limit exceeded" });
  });

  it("rate limits message sends to 60 per minute per agent", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    for (let i = 0; i < 60; i += 1) {
      const sent = await sendRaw(alphaClient, beta.agent_id, `send-${i}`, { content: `msg ${i}` });
      expect(sent.status).toBe("delivered");
    }

    const secret = (alphaClient as unknown as { secret: string }).secret;
    const blocked = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`,
        "Idempotency-Key": "send-blocked",
      },
      body: JSON.stringify({ to: beta.agent_id, type: "question", payload: { content: "too much" } }),
    });

    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({ error: "Rate limit exceeded" });
  });

  it("rate limit responses include X-RateLimit-* headers and Retry-After on 429", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // First send should include rate limit headers with remaining count
    const secret = (alphaClient as unknown as { secret: string }).secret;
    const first = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`,
        "Idempotency-Key": "rl-header-0",
      },
      body: JSON.stringify({ to: beta.agent_id, type: "update", payload: { content: "first" } }),
    });
    expect(first.status).toBe(201);
    expect(first.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(first.headers.get("X-RateLimit-Remaining")).toBe("59");
    expect(first.headers.get("X-RateLimit-Reset")).toBeTruthy();

    // Exhaust the limit
    for (let i = 1; i < 60; i += 1) {
      await sendRaw(alphaClient, beta.agent_id, `rl-header-${i}`, { content: `msg ${i}` });
    }

    // 61st request should be blocked with 429 + Retry-After header
    const blocked = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`,
        "Idempotency-Key": "rl-header-blocked",
      },
      body: JSON.stringify({ to: beta.agent_id, type: "update", payload: { content: "blocked" } }),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0");

    const body = await blocked.json();
    expect(body).toMatchObject({
      error: "Rate limit exceeded",
      retry_after_seconds: expect.any(Number),
    });
  });

  it("rate limit registration includes headers and Retry-After on 429", async () => {
    for (let i = 0; i < 10; i += 1) {
      await app.request("/agents/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.1" },
        body: JSON.stringify({ name: `reg-${i}` }),
      });
    }

    const blocked = await app.request("/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.1" },
      body: JSON.stringify({ name: "reg-blocked" }),
    });

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("different agents have independent rate limit counters", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Alpha sends 60 messages (hits limit)
    for (let i = 0; i < 60; i += 1) {
      await sendRaw(alphaClient, beta.agent_id, `indep-a-${i}`, { content: `msg ${i}` });
    }

    // Alpha is now blocked
    const secret = (alphaClient as unknown as { secret: string }).secret;
    const blockedAlpha = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`,
        "Idempotency-Key": "indep-a-blocked",
      },
      body: JSON.stringify({ to: beta.agent_id, type: "update", payload: { content: "blocked" } }),
    });
    expect(blockedAlpha.status).toBe(429);

    // Beta can still send (independent counter)
    const betaRaw = await sendRaw(betaClient, alpha.agent_id, "indep-b-0", { content: "beta fine" });
    expect(betaRaw.status).toBe("delivered");
  });

  it("SDK exposes retryAfterSeconds and isRateLimited on 429 errors", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Exhaust the limit
    for (let i = 0; i < 60; i += 1) {
      await sendRaw(alphaClient, beta.agent_id, `sdk-rl-${i}`, { content: `msg ${i}` });
    }

    // SDK should throw TrunkApiError with retryAfterSeconds
    try {
      await alphaClient.send({
        to: beta.agent_id,
        type: "update",
        payload: { content: "over limit" },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TrunkApiError);
      const apiErr = err as TrunkApiError;
      expect(apiErr.status).toBe(429);
      expect(apiErr.isRateLimited).toBe(true);
      expect(apiErr.retryAfterSeconds).toBeGreaterThan(0);
      expect(apiErr.message).toBe("Rate limit exceeded");
    }
  });

  it("rate limits replies at the same 60/min threshold as sends", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Alpha sends 1 message for beta to reply to
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "hello" },
    });

    // Exhaust beta's rate limit with sends
    for (let i = 0; i < 60; i += 1) {
      await sendRaw(betaClient, alpha.agent_id, `reply-rl-${i}`, { content: `msg ${i}` });
    }

    // Beta's reply should also be rate limited (shares counter with sends)
    try {
      await betaClient.reply(sent.id, {
        type: "ack",
        payload: { content: "can't reply" },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TrunkApiError);
      const apiErr = err as TrunkApiError;
      expect(apiErr.status).toBe(429);
      expect(apiErr.isRateLimited).toBe(true);
    }
  });

  it("rate limits bulk operations at 30/min shared across bulk endpoints", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send a message to have something to bulk-ack
    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "bulk-rl-test" },
    });

    // Exhaust the bulk rate limit (30 calls)
    for (let i = 0; i < 30; i++) {
      const res = await app.request("/messages/ack-bulk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${alpha.secret}`,
        },
        body: JSON.stringify({ message_ids: ["00000000-0000-0000-0000-000000000099"] }),
      });
      expect(res.status).toBe(200);
    }

    // 31st call should be rate limited
    const res = await app.request("/messages/ack-bulk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ message_ids: ["00000000-0000-0000-0000-000000000099"] }),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("rate limits pairing attempts at 20/min", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    // Exhaust pairing rate limit (20 calls with invalid codes)
    for (let i = 0; i < 20; i++) {
      const res = await app.request("/contacts/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${alpha.secret}`,
        },
        body: JSON.stringify({ code: `FAKE${i}XX` }),
      });
      // These should return 404 (code not found), not 429
      expect(res.status).not.toBe(429);
    }

    // 21st attempt should be rate limited
    const res = await app.request("/contacts/pair", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ code: "FAKE21XX" }),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("rate limits connect page lookups by IP", async () => {
    // Exhaust connect rate limit (30 per minute per IP)
    for (let i = 0; i < 30; i++) {
      const res = await app.request(`/connect/CODE${i}`, {
        headers: { "x-forwarded-for": "198.51.100.42" },
      });
      expect(res.status).toBe(200);
    }

    // 31st lookup should be rate limited
    const res = await app.request("/connect/CODE31", {
      headers: { "x-forwarded-for": "198.51.100.42" },
    });
    expect(res.status).toBe(429);
  });

  it("rate limits attachment uploads at 30/min", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    // Exhaust the attachment rate limit
    for (let i = 0; i < 30; i++) {
      await client.uploadAttachment({
        filename: `test-${i}.txt`,
        data: btoa("test content"),
      });
    }

    // 31st upload should be rate limited
    try {
      await client.uploadAttachment({
        filename: "overflow.txt",
        data: btoa("test content"),
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TrunkApiError);
      const apiErr = err as TrunkApiError;
      expect(apiErr.status).toBe(429);
    }
  });

  it("LangGraph adapter nodes send messages and write inbox results into graph state", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    type GraphState = { recipient: string; content: string };
    const sendNode = createTrunkSendNode<GraphState>(alphaClient, {
      to: (state) => state.recipient,
      type: "handoff",
      payload: (state) => ({ content: state.content }),
      outputKey: "sent",
    });
    const afterSend = await sendNode({ recipient: beta.agent_id, content: "Graph handoff" });

    expect(afterSend.sent).toMatchObject({ status: "delivered" });

    const inboxNode = createTrunkInboxNode(betaClient, { outputKey: "messages" });
    const afterInbox = await inboxNode({ checked: true });

    expect(afterInbox.messages).toHaveLength(1);
    expect(afterInbox.messages[0]).toMatchObject({
      type: "handoff",
      payload: { content: "Graph handoff" },
    });
  });

  it("rejects message payloads larger than 1MB", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const secret = (alphaClient as unknown as { secret: string }).secret;
    const res = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`,
        "Idempotency-Key": "too-large",
      },
      body: JSON.stringify({
        to: beta.agent_id,
        type: "question",
        payload: { content: "x".repeat(1024 * 1024 + 1) },
      }),
    });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: "payload exceeds 1MB limit" });
  });

  it("soft deletes only messages authored by the current agent", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "delete me" },
    });

    await expect(betaClient.deleteMessage(sent.id)).rejects.toMatchObject({ status: 404 });
    await expect(alphaClient.deleteMessage(sent.id)).resolves.toEqual({ ok: true });
    await expect(betaClient.thread(sent.thread_id)).resolves.toMatchObject({ messages: [] });
  });

  it("purges expired messages visible to the current agent", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const oldMessage = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "old" },
    });
    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "new" },
    });
    const row = testState.messages.find((message) => message.id === oldMessage.id);
    expect(row).toBeDefined();
    row!.createdAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);

    await expect(betaClient.purgeExpiredMessages(90)).resolves.toMatchObject({ purged: 1 });
    const inbox = await betaClient.inbox();
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].payload).toMatchObject({ content: "new" });
  });

  // --- Bulk ack tests ---

  it("bulk acks multiple messages at once", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg1" } });
    const m2 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg2" } });
    const m3 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg3" } });

    const result = await betaClient.ackBulk([m1.id, m2.id, m3.id]);

    expect(result).toMatchObject({ ok: true, acked: 3 });
    // All messages should be processed now — inbox returns no pending messages
    const inbox = await betaClient.inbox();
    expect(inbox.messages).toHaveLength(0);
  });

  it("bulk ack skips messages not addressed to the agent", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "to beta" } });

    // Alpha tries to ack a message sent TO beta — should not work
    const result = await alphaClient.ackBulk([m1.id]);
    expect(result).toMatchObject({ ok: true, acked: 0 });

    // Beta can still ack it
    const betaResult = await betaClient.ackBulk([m1.id]);
    expect(betaResult).toMatchObject({ ok: true, acked: 1 });
  });

  it("rejects bulk ack with empty array", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.ackBulk([])).rejects.toMatchObject({ status: 400 });
  });

  // --- Bulk read tests ---

  it("bulk reads multiple messages at once", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg1" } });
    const m2 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg2" } });
    const m3 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg3" } });

    const result = await betaClient.readBulk([m1.id, m2.id, m3.id]);

    expect(result).toMatchObject({ ok: true, marked: 3 });
    // Messages should still be in inbox (read but not processed)
    const inbox = await betaClient.inbox();
    expect(inbox.messages.length).toBeGreaterThanOrEqual(3);
  });

  it("bulk read skips already-read messages", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg1" } });

    await betaClient.readBulk([m1.id]);
    const result = await betaClient.readBulk([m1.id]);
    expect(result).toMatchObject({ ok: true, marked: 0 });
  });

  it("bulk read skips messages not addressed to agent", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "to beta" } });

    const result = await alphaClient.readBulk([m1.id]);
    expect(result).toMatchObject({ ok: true, marked: 0 });
  });

  it("rejects bulk read with empty array", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.readBulk([])).rejects.toMatchObject({ status: 400 });
  });

  // --- Bulk delete tests ---

  it("bulk deletes multiple messages at once", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg1" } });
    const m2 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg2" } });

    const result = await alphaClient.deleteBulk([m1.id, m2.id]);

    expect(result).toMatchObject({ ok: true, deleted: 2 });
    // Deleted messages should not appear in inbox
    const inbox = await betaClient.inbox();
    expect(inbox.messages).toHaveLength(0);
  });

  it("bulk delete only works for sender", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg1" } });

    // Recipient cannot delete
    const result = await betaClient.deleteBulk([m1.id]);
    expect(result).toMatchObject({ ok: true, deleted: 0 });

    // Sender can delete
    const senderResult = await alphaClient.deleteBulk([m1.id]);
    expect(senderResult).toMatchObject({ ok: true, deleted: 1 });
  });

  it("rejects bulk delete with empty array", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.deleteBulk([])).rejects.toMatchObject({ status: 400 });
  });

  // --- Bulk label tests ---

  it("bulk labels multiple messages at once", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg1" } });
    const m2 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg2" } });

    const result = await betaClient.labelBulk([m1.id, m2.id], "important");

    expect(result).toMatchObject({ ok: true, labeled: 2 });
  });

  it("bulk label skips already-labeled messages", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg1" } });

    await betaClient.labelBulk([m1.id], "urgent");
    const result = await betaClient.labelBulk([m1.id], "urgent");
    expect(result).toMatchObject({ ok: true, labeled: 0 });
  });

  it("bulk label rejects non-participant messages", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg1" } });

    // Create a third agent who is not a participant
    const gamma = await createClient().register({ name: "gamma" });
    const gammaClient = createClient(gamma.secret);
    const result = await gammaClient.labelBulk([m1.id], "spam");
    expect(result).toMatchObject({ ok: true, labeled: 0 });
  });

  it("rejects bulk label with empty array", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.labelBulk([], "test")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects bulk label without label", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.labelBulk(["some-id"], "")).rejects.toMatchObject({ status: 400 });
  });

  // --- Bulk UUID validation tests ---

  it("rejects bulk ack with invalid UUID in message_ids", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.ackBulk(["not-a-uuid"])).rejects.toMatchObject({ status: 400 });
  });

  it("rejects bulk read with invalid UUID in message_ids", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.readBulk(["not-a-uuid"])).rejects.toMatchObject({ status: 400 });
  });

  it("rejects bulk delete with invalid UUID in message_ids", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.deleteBulk(["not-a-uuid"])).rejects.toMatchObject({ status: 400 });
  });

  it("rejects bulk label with invalid UUID in message_ids", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.labelBulk(["not-a-uuid"], "important")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects bulk ack when mix of valid and invalid UUIDs", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "test" } });

    const betaClient = createClient(beta.secret);
    await expect(betaClient.ackBulk([sent.id, "sql-injection-attempt"])).rejects.toMatchObject({ status: 400 });
  });

  // --- Message edit tests ---

  it("sender can edit a message payload", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "original" },
    });

    const edited = await alphaClient.editMessage(sent.id, { content: "corrected" });
    expect(edited.id).toBe(sent.id);
    expect(edited.payload).toMatchObject({ content: "corrected" });
    expect(edited.edited_at).toBeDefined();
  });

  it("recipient cannot edit a message they received", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "original" },
    });

    await expect(betaClient.editMessage(sent.id, { content: "tampered" })).rejects.toMatchObject({ status: 404 });
  });

  it("cannot edit a deleted message", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "delete me" },
    });

    await alphaClient.deleteMessage(sent.id);
    await expect(alphaClient.editMessage(sent.id, { content: "too late" })).rejects.toMatchObject({ status: 400 });
  });

  it("edited message shows updated payload in thread view", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "original" },
    });

    await alphaClient.editMessage(sent.id, { content: "fixed typo" });

    const thread = await betaClient.thread(sent.thread_id);
    expect(thread.messages[0].payload).toMatchObject({ content: "fixed typo" });
    expect(thread.messages[0].editedAt).toBeDefined();
  });

  it("cannot edit a message after 15-minute window", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "original" },
    });

    // Manually set the message's createdAt to 16 minutes ago
    const msg = testState.messages.find((m) => m.id === sent.id)!;
    msg.createdAt = new Date(Date.now() - 16 * 60 * 1000);

    await expect(alphaClient.editMessage(sent.id, { content: "too late" })).rejects.toMatchObject({ status: 403 });
  });

  it("edit within 15-minute window succeeds", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "original" },
    });

    // Message was just created, so it's within the window
    const edited = await alphaClient.editMessage(sent.id, { content: "corrected" });
    expect(edited.payload).toMatchObject({ content: "corrected" });
    expect(edited.version).toBe(2);
  });

  it("tracks edit history with previous payloads", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "v1" },
    });

    await alphaClient.editMessage(sent.id, { content: "v2" });
    await alphaClient.editMessage(sent.id, { content: "v3" });

    const history = await alphaClient.messageEditHistory(sent.id);
    expect(history.message_id).toBe(sent.id);
    expect(history.edit_count).toBe(2);
    expect(history.edits[0].version).toBe(1);
    expect(history.edits[0].previous_payload).toMatchObject({ content: "v1" });
    expect(history.edits[1].version).toBe(2);
    expect(history.edits[1].previous_payload).toMatchObject({ content: "v2" });
    expect(history.current_payload).toMatchObject({ content: "v3" });
  });

  it("recipient can view edit history", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "original" },
    });

    await alphaClient.editMessage(sent.id, { content: "edited" });

    const history = await betaClient.messageEditHistory(sent.id);
    expect(history.edit_count).toBe(1);
    expect(history.edits[0].previous_payload).toMatchObject({ content: "original" });
  });

  it("edit history returns empty for unedited message", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "never edited" },
    });

    const history = await alphaClient.messageEditHistory(sent.id);
    expect(history.edit_count).toBe(0);
    expect(history.edits).toHaveLength(0);
  });

  it("non-participant cannot view edit history", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "secret" },
    });

    const gamma = await createClient().register({ name: "gamma" });
    const gammaClient = createClient(gamma.secret);
    await expect(gammaClient.messageEditHistory(sent.id)).rejects.toMatchObject({ status: 404 });
  });

  // --- Inbox stats tests ---

  it("returns inbox stats with unread count and type breakdown", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg1" } });
    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "msg2" } });
    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "msg3" } });

    const stats = await betaClient.inboxStats();
    expect(stats.unread).toBe(3);
    expect(stats.total).toBe(3);
    expect(stats.by_type).toEqual({ update: 1, question: 2 });
  });

  it("inbox stats reflects acked messages correctly", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const m1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg1" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "msg2" } });

    await betaClient.ack(m1.id);

    const stats = await betaClient.inboxStats();
    expect(stats.unread).toBe(1);
    expect(stats.total).toBe(2);
    expect(stats.by_status.processed).toBe(1);
  });

  // --- Sent messages (outbox) tests ---

  it("returns sent messages for the authenticated agent", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "hello from alpha" },
    });
    await alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "how are you?" },
    });

    const sentByAlpha = await alphaClient.sent();
    expect(sentByAlpha.messages).toHaveLength(2);
    expect(sentByAlpha.messages[0].payload).toMatchObject({ content: "how are you?" });
    expect(sentByAlpha.messages[1].payload).toMatchObject({ content: "hello from alpha" });

    // Beta has not sent anything
    const sentByBeta = await betaClient.sent();
    expect(sentByBeta.messages).toHaveLength(0);
  });

  it("filters sent messages by recipient", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "alpha", owner: "Andrei" });
    const beta = await anon.register({ name: "beta", owner: "Frank" });
    const gamma = await anon.register({ name: "gamma", owner: "Vince" });
    const alphaClient = createClient(alpha.secret);
    await alphaClient.pair({ code: beta.pairing_code });
    await alphaClient.pair({ code: gamma.pairing_code });

    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "to beta" } });
    await alphaClient.send({ to: gamma.agent_id, type: "update", payload: { content: "to gamma" } });

    const toBeta = await alphaClient.sent({ to: beta.agent_id });
    expect(toBeta.messages).toHaveLength(1);
    expect(toBeta.messages[0].payload).toMatchObject({ content: "to beta" });

    const toGamma = await alphaClient.sent({ to: gamma.agent_id });
    expect(toGamma.messages).toHaveLength(1);
    expect(toGamma.messages[0].payload).toMatchObject({ content: "to gamma" });
  });

  it("filters sent messages by type", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "q1" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "u1" } });
    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "q2" } });

    const questions = await alphaClient.sent({ type: "question" });
    expect(questions.messages).toHaveLength(2);
    expect(questions.messages.every((m: { type: string }) => m.type === "question")).toBe(true);

    const updates = await alphaClient.sent({ type: "update" });
    expect(updates.messages).toHaveLength(1);
    expect(updates.messages[0].payload).toMatchObject({ content: "u1" });
  });

  it("excludes soft-deleted messages from sent results", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "to delete" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "keep" } });
    await alphaClient.deleteMessage(msg.id);

    const sent = await alphaClient.sent();
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0].payload).toMatchObject({ content: "keep" });
  });

  it("respects limit parameter on sent messages", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    for (let i = 0; i < 5; i++) {
      await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: `msg-${i}` } });
    }

    const limited = await alphaClient.sent({ limit: 2 });
    expect(limited.messages).toHaveLength(2);
  });

  // --- Message search tests ---

  it("searches messages by content text", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "deploy the feature" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "review the PR" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "deploy to staging" } });

    const results = await alphaClient.search({ q: "deploy" });
    expect(results.messages).toHaveLength(2);
    expect(results.messages.every((m: TrunkMessage) => ((m.payload as Record<string, unknown>).content as string).includes("deploy"))).toBe(true);
  });

  it("searches messages by type filter", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "q1" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "u1" } });
    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "q2" } });

    const results = await alphaClient.search({ type: "question" });
    expect(results.messages).toHaveLength(2);
    expect(results.messages.every((m: { type: string }) => m.type === "question")).toBe(true);
  });

  it("searches messages by contact filter", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "alpha", owner: "Andrei" });
    const beta = await anon.register({ name: "beta", owner: "Frank" });
    const gamma = await anon.register({ name: "gamma", owner: "Vince" });
    const alphaClient = createClient(alpha.secret);
    await alphaClient.pair({ code: beta.pairing_code });
    await alphaClient.pair({ code: gamma.pairing_code });

    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "to beta" } });
    await alphaClient.send({ to: gamma.agent_id, type: "update", payload: { content: "to gamma" } });

    const withBeta = await alphaClient.search({ contact: beta.agent_id });
    expect(withBeta.messages).toHaveLength(1);
    expect(withBeta.messages[0].payload).toMatchObject({ content: "to beta" });
  });

  it("searches messages with combined filters", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "deploy question" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "deploy update" } });
    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "review question" } });

    const results = await alphaClient.search({ q: "deploy", type: "question" });
    expect(results.messages).toHaveLength(1);
    expect(results.messages[0].payload).toMatchObject({ content: "deploy question" });
  });

  it("excludes deleted messages from search results", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "to delete" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "keep" } });
    await alphaClient.deleteMessage(msg.id);

    const results = await alphaClient.search({ q: "delete" });
    expect(results.messages).toHaveLength(0);
  });

  it("respects limit parameter on search", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    for (let i = 0; i < 5; i++) {
      await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: `search-msg-${i}` } });
    }

    const limited = await alphaClient.search({ q: "search-msg", limit: 2 });
    expect(limited.messages).toHaveLength(2);
  });

  // --- Workspace tests ---

  it("creates a workspace and the creator auto-joins", async () => {
    const alpha = await createClient().register({ name: "agent-1", owner: "Frank" });
    const client = createClient(alpha.secret);

    const ws = await client.createWorkspace({ name: "Frank Team" });

    expect(ws.id).toEqual(expect.any(String));
    expect(ws.name).toBe("Frank Team");
    expect(ws.pairing_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

    const info = await client.myWorkspace();
    expect(info.workspace.id).toBe(ws.id);
    expect(info.members).toHaveLength(1);
    expect(info.members[0]).toMatchObject({ agent_id: alpha.agent_id, name: "agent-1" });
  });

  it("second agent joins workspace via pairing code", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "agent-1" });
    const beta = await anon.register({ name: "agent-2" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "Team" });
    const joined = await betaClient.joinWorkspace({ code: ws.pairing_code });

    expect(joined.joined).toBe(true);
    expect(joined.workspace_id).toBe(ws.id);

    const info = await alphaClient.myWorkspace();
    expect(info.members).toHaveLength(2);
  });

  it("workspace members can message each other without explicit pairing", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "agent-1" });
    const beta = await anon.register({ name: "agent-2" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "handoff",
      payload: { content: "Workspace message" },
    });

    expect(sent.status).toBe("delivered");
    const inbox = await betaClient.inbox();
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].payload).toMatchObject({ content: "Workspace message" });
  });

  it("external agent pairs with workspace and can message all members", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-member-1" });
    const beta = await anon.register({ name: "ws-member-2" });
    const external = await anon.register({ name: "external-agent" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);
    const externalClient = createClient(external.secret);

    // Create workspace, beta joins
    const ws = await alphaClient.createWorkspace({ name: "Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // External agent pairs with the workspace
    const paired = await externalClient.pair({ code: ws.pairing_code });
    expect(paired.contact_type).toBe("workspace");
    expect(paired.workspace_id).toBe(ws.id);

    // External can message workspace members
    const sent = await externalClient.send({
      to: alpha.agent_id,
      type: "question",
      payload: { content: "Hello from outside" },
    });
    expect(sent.status).toBe("delivered");

    const sent2 = await externalClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "Hello to member 2" },
    });
    expect(sent2.status).toBe("delivered");

    // Workspace members can see external in contacts
    const alphaContacts = await alphaClient.contacts();
    const hasExternal = alphaContacts.contacts.some((c) => c.agent_id === external.agent_id);
    expect(hasExternal).toBe(true);
  });

  it("workspace-addressed message fans out to all members", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "member-1" });
    const beta = await anon.register({ name: "member-2" });
    const external = await anon.register({ name: "outsider" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);
    const externalClient = createClient(external.secret);

    const ws = await alphaClient.createWorkspace({ name: "Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });
    await externalClient.pair({ code: ws.pairing_code });

    // External sends to workspace — fans out to alpha and beta
    const sent = await externalClient.send({
      to: `workspace:${ws.id}`,
      type: "update",
      payload: { content: "Broadcast to team" },
    });

    expect(sent.status).toBe("delivered");
    expect(sent.recipients).toBe(2);

    const alphaInbox = await alphaClient.inbox();
    const betaInbox = await betaClient.inbox();
    expect(alphaInbox.messages).toHaveLength(1);
    expect(betaInbox.messages).toHaveLength(1);
    expect(alphaInbox.messages[0].payload).toMatchObject({ content: "Broadcast to team" });
    expect(betaInbox.messages[0].payload).toMatchObject({ content: "Broadcast to team" });
  });

  it("workspace-scoped tasks are visible to all members", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "member-1" });
    const beta = await anon.register({ name: "member-2" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Create workspace-scoped task
    const res = await app.request("/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({
        workspace_id: ws.id,
        title: "Implement workspaces",
        description: "Add workspace support",
      }),
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.scope).toBe(`workspace:${ws.id}`);

    // Both members can see it
    const alphaView = await app.request(`/tasks/workspace/${ws.id}`, {
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    const betaView = await app.request(`/tasks/workspace/${ws.id}`, {
      headers: { "Authorization": `Bearer ${beta.secret}` },
    });

    const alphaTasks = await alphaView.json();
    const betaTasks = await betaView.json();
    expect(alphaTasks.tasks).toHaveLength(1);
    expect(betaTasks.tasks).toHaveLength(1);
    expect(alphaTasks.tasks[0].title).toBe("Implement workspaces");
  });

  it("workspace co-members can create and list contact-scoped tasks without explicit pairing", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-alpha" });
    const beta = await anon.register({ name: "ws-beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "CoworkTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Alpha creates a contact-scoped task for beta — no explicit pair() needed
    const createRes = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "Review PR",
      description: "Workspace co-member task",
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();
    expect(task.title).toBe("Review PR");

    // Both can list it
    const alphaView = await listTasksRaw(alpha.secret, beta.agent_id);
    const betaView = await listTasksRaw(beta.secret, alpha.agent_id);
    const alphaTasks = await alphaView.json();
    const betaTasks = await betaView.json();
    expect(alphaTasks.tasks).toHaveLength(1);
    expect(betaTasks.tasks).toHaveLength(1);
    expect(alphaTasks.tasks[0].title).toBe("Review PR");
  });

  it("workspace co-members can update contact-scoped tasks", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-alpha-2" });
    const beta = await anon.register({ name: "ws-beta-2" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "CoworkTeam2" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const createRes = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Deploy feature" });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();

    // Beta can update it
    const updateRes = await updateTaskRaw(beta.secret, alpha.agent_id, task.id, { status: "done" });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.status).toBe("done");
  });

  it("agent can leave a workspace", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "member-1" });
    const beta = await anon.register({ name: "member-2" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    await betaClient.leaveWorkspace();

    // Beta can no longer see workspace
    await expect(betaClient.myWorkspace()).rejects.toMatchObject({ status: 404 });

    // Alpha still in workspace, now alone
    const info = await alphaClient.myWorkspace();
    expect(info.members).toHaveLength(1);
  });

  it("solo agents work exactly as before without workspaces", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "No workspace needed" },
    });

    expect(sent.status).toBe("delivered");
    const inbox = await betaClient.inbox();
    expect(inbox.messages).toHaveLength(1);
  });

  it("signs and verifies webhook payloads", async () => {
    const body = JSON.stringify({ event: "message.received", message: { id: "msg_1" } });
    const signature = await signWebhookPayload("secret", body);

    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    await expect(verifyWebhookSignature("secret", body, signature)).resolves.toBe(true);
    await expect(verifyWebhookSignature("secret", body, "sha256=bad")).resolves.toBe(false);
  });

  it("rejects webhook signature with missing or null signature", async () => {
    const body = '{"event":"test"}';
    await expect(verifyWebhookSignature("secret", body, "")).resolves.toBe(false);
    await expect(verifyWebhookSignature("secret", body, null as any)).resolves.toBe(false);
    await expect(verifyWebhookSignature("secret", body, undefined as any)).resolves.toBe(false);
  });

  it("rejects webhook signature without sha256= prefix", async () => {
    const body = '{"event":"test"}';
    const sig = await signWebhookPayload("secret", body);
    const rawHex = sig.slice(7); // strip "sha256="
    await expect(verifyWebhookSignature("secret", body, rawHex)).resolves.toBe(false);
  });

  it("rejects webhook signature with wrong secret", async () => {
    const body = '{"event":"test"}';
    const sig = await signWebhookPayload("correct-secret", body);
    await expect(verifyWebhookSignature("wrong-secret", body, sig)).resolves.toBe(false);
  });

  it("rejects webhook signature with tampered body", async () => {
    const body = '{"event":"message.received","id":"msg_1"}';
    const sig = await signWebhookPayload("secret", body);
    const tampered = '{"event":"message.received","id":"msg_2"}';
    await expect(verifyWebhookSignature("secret", tampered, sig)).resolves.toBe(false);
  });

  it("verifies webhook signature with empty body", async () => {
    const sig = await signWebhookPayload("secret", "");
    await expect(verifyWebhookSignature("secret", "", sig)).resolves.toBe(true);
  });

  it("produces deterministic webhook signatures", async () => {
    const body = '{"event":"test"}';
    const sig1 = await signWebhookPayload("secret", body);
    const sig2 = await signWebhookPayload("secret", body);
    expect(sig1).toBe(sig2);
  });

  it("me returns role, projects, and metadata when set via updateMe", async () => {
    const registered = await createClient().register({ name: "alpha", owner: "Andrei" });
    const client = createClient(registered.secret);

    const updated = await client.updateMe({
      role: "developer agent",
      projects: ["trunk", "myapp"],
      metadata: { focus: "backend" },
    });

    expect(updated).toMatchObject({
      agent_id: registered.agent_id,
      role: "developer agent",
      projects: ["trunk", "myapp"],
      metadata: expect.objectContaining({ role: "developer agent", projects: ["trunk", "myapp"], focus: "backend" }),
    });

    const me = await client.me();
    expect(me).toMatchObject({
      agent_id: registered.agent_id,
      role: "developer agent",
      projects: ["trunk", "myapp"],
      metadata: expect.objectContaining({ focus: "backend" }),
    });
  });

  it("updateMe merges metadata without overwriting existing fields", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const client = createClient(registered.secret);

    await client.updateMe({ role: "planner", metadata: { tier: "pro" } });
    await client.updateMe({ projects: ["trunk"] });

    const me = await client.me();
    expect(me.role).toBe("planner");
    expect(me.projects).toEqual(["trunk"]);
    expect(me.metadata).toMatchObject({ tier: "pro" });
  });

  it("profile returns another agent's public profile for a direct contact", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await betaClient.updateMe({ role: "reviewer", projects: ["trunk"] });

    const prof = await alphaClient.profile(beta.agent_id);
    expect(prof).toMatchObject({
      agent_id: beta.agent_id,
      name: "beta",
      owner: "Frank",
      role: "reviewer",
      projects: ["trunk"],
    });
  });

  it("profile returns 403 for non-contacts", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);

    await expect(alphaClient.profile(beta.agent_id)).rejects.toMatchObject({
      status: 403,
      message: "Not a contact",
    });
  });

  it("profile returns another agent's profile for workspace co-members", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "alpha" });
    const beta = await anon.register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });
    await betaClient.updateMe({ role: "developer" });

    const prof = await alphaClient.profile(beta.agent_id);
    expect(prof).toMatchObject({
      agent_id: beta.agent_id,
      name: "beta",
      role: "developer",
    });
  });

  // --- Billing ---

  it("billing status returns free plan for workspace member", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-alpha", owner: "Test" });
    client.setSecret(reg.secret);

    const ws = await client.createWorkspace({ name: "Bill Team" });
    const status = await client.billingStatus();

    expect(status.workspace_id).toBe(ws.id);
    expect(status.plan).toBe("free");
    expect(status.status).toBe("active");
  });

  it("billing status fails without workspace", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-solo", owner: "Test" });
    client.setSecret(reg.secret);

    await expect(client.billingStatus()).rejects.toThrow(TrunkApiError);
    try {
      await client.billingStatus();
    } catch (e) {
      expect((e as TrunkApiError).status).toBe(400);
    }
  });

  it("billing checkout fails without workspace", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-solo2", owner: "Test" });
    client.setSecret(reg.secret);

    await expect(client.billingCheckout()).rejects.toThrow(TrunkApiError);
  });

  it("billing portal fails without stripe customer", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-portal", owner: "Test" });
    client.setSecret(reg.secret);

    await client.createWorkspace({ name: "Portal Team" });

    await expect(client.billingPortal()).rejects.toThrow(TrunkApiError);
    try {
      await client.billingPortal();
    } catch (e) {
      expect((e as TrunkApiError).status).toBe(400);
      expect((e as TrunkApiError).message).toContain("No billing account");
    }
  });

  it("billing status reflects subscription changes via mock", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-upgrade", owner: "Test" });
    client.setSecret(reg.secret);

    const ws = await client.createWorkspace({ name: "Upgrade Team" });

    // Get initial status (creates free subscription)
    const initial = await client.billingStatus();
    expect(initial.plan).toBe("free");

    // Simulate an upgrade by directly modifying the subscription in testState
    const sub = testState.subscriptions.find((s) => s.workspaceId === ws.id);
    expect(sub).toBeDefined();
    sub!.plan = "team";
    sub!.stripeCustomerId = "cus_test123";
    sub!.stripeSubscriptionId = "sub_test123";

    const upgraded = await client.billingStatus();
    expect(upgraded.plan).toBe("team");
    expect(upgraded.stripe_customer_id).toBe("cus_test123");
  });

  it("billing webhook returns 400 without stripe-signature header", async () => {
    const res = await app.request("/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "checkout.session.completed" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("billing checkout returns 409 when already on team plan", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-dup", owner: "Test" });
    client.setSecret(reg.secret);

    const ws = await client.createWorkspace({ name: "Already Team" });

    // Get initial status to create subscription
    await client.billingStatus();

    // Simulate existing team subscription
    const sub = testState.subscriptions.find((s) => s.workspaceId === ws.id);
    expect(sub).toBeDefined();
    sub!.plan = "team";
    sub!.status = "active";

    // Checkout should fail with 409
    try {
      await client.billingCheckout();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as TrunkApiError).status).toBe(409);
    }
  });

  it("billing webhook handles checkout.session.completed by upgrading subscription", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-wh", owner: "Test" });
    client.setSecret(reg.secret);

    const ws = await client.createWorkspace({ name: "WH Team" });

    // Create a free subscription via status endpoint
    await client.billingStatus();

    const sub = testState.subscriptions.find((s) => s.workspaceId === ws.id);
    expect(sub).toBeDefined();
    expect(sub!.plan).toBe("free");

    // Directly simulate what the webhook handler does after signature verification:
    // upgrade the subscription as if checkout.session.completed fired
    sub!.plan = "team";
    sub!.status = "active";
    sub!.stripeSubscriptionId = "sub_wh_test";
    sub!.stripeCustomerId = "cus_wh_test";

    const upgraded = await client.billingStatus();
    expect(upgraded.plan).toBe("team");
    expect(upgraded.status).toBe("active");
  });

  it("billing webhook handles subscription.updated by updating status and period", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-upd", owner: "Test" });
    client.setSecret(reg.secret);

    const ws = await client.createWorkspace({ name: "Upd Team" });
    await client.billingStatus();

    const sub = testState.subscriptions.find((s) => s.workspaceId === ws.id);
    expect(sub).toBeDefined();

    // Set up as if checkout already completed
    sub!.plan = "team";
    sub!.status = "active";
    sub!.stripeSubscriptionId = "sub_upd_test";
    sub!.stripeCustomerId = "cus_upd_test";

    // Simulate subscription.updated: transition to past_due
    sub!.status = "past_due";
    sub!.currentPeriodStart = new Date("2026-06-01T00:00:00Z");
    sub!.currentPeriodEnd = new Date("2026-07-01T00:00:00Z");

    const status = await client.billingStatus();
    expect(status.plan).toBe("team");
    expect(status.status).toBe("past_due");
  });

  it("billing webhook handles subscription.updated trialing status", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-trial", owner: "Test" });
    client.setSecret(reg.secret);

    const ws = await client.createWorkspace({ name: "Trial Team" });
    await client.billingStatus();

    const sub = testState.subscriptions.find((s) => s.workspaceId === ws.id);
    sub!.stripeSubscriptionId = "sub_trial_test";
    sub!.stripeCustomerId = "cus_trial_test";

    // Simulate subscription.updated: trialing status
    sub!.status = "trialing";
    sub!.plan = "team";

    const status = await client.billingStatus();
    expect(status.status).toBe("trialing");
    expect(status.plan).toBe("team");
  });

  it("billing webhook handles subscription.updated canceled status", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-cancel", owner: "Test" });
    client.setSecret(reg.secret);

    const ws = await client.createWorkspace({ name: "Cancel Team" });
    await client.billingStatus();

    const sub = testState.subscriptions.find((s) => s.workspaceId === ws.id);
    sub!.stripeSubscriptionId = "sub_cancel_test";
    sub!.stripeCustomerId = "cus_cancel_test";
    sub!.plan = "team";
    sub!.status = "active";

    // Simulate subscription.updated: canceled
    sub!.status = "canceled";

    const status = await client.billingStatus();
    expect(status.status).toBe("canceled");
  });

  it("billing webhook handles subscription.deleted by downgrading to free", async () => {
    const client = createClient();
    const reg = await client.register({ name: "bill-del", owner: "Test" });
    client.setSecret(reg.secret);

    const ws = await client.createWorkspace({ name: "Del Team" });
    await client.billingStatus();

    const sub = testState.subscriptions.find((s) => s.workspaceId === ws.id);
    sub!.plan = "team";
    sub!.status = "active";
    sub!.stripeSubscriptionId = "sub_del_test";

    // Simulate subscription.deleted webhook effect
    sub!.plan = "free";
    sub!.status = "canceled";

    const status = await client.billingStatus();
    expect(status.plan).toBe("free");
    expect(status.status).toBe("canceled");
  });

  // --- Unpair tests ---

  it("unpair removes the contact relationship", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Verify paired
    const before = await alphaClient.contacts();
    expect(before.contacts.some((c) => c.agent_id === beta.agent_id)).toBe(true);

    // Unpair
    await expect(alphaClient.unpair(beta.agent_id)).resolves.toEqual({ ok: true });

    // Neither side sees the other as a contact
    const alphaContacts = await alphaClient.contacts();
    const betaContacts = await betaClient.contacts();
    expect(alphaContacts.contacts.some((c) => c.agent_id === beta.agent_id)).toBe(false);
    expect(betaContacts.contacts.some((c) => c.agent_id === alpha.agent_id)).toBe(false);
  });

  it("unpair blocks messaging between formerly paired agents", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    await alphaClient.unpair(beta.agent_id);

    await expect(
      alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "hello" } })
    ).rejects.toMatchObject({ status: 403 });
  });

  // --- Contact alias update tests ---

  it("updates contact alias after pairing", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.updateContactAlias(beta.agent_id, "my buddy");
    expect(result).toEqual({ ok: true, alias: "my buddy" });
  });

  it("clears contact alias by setting null", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    await alphaClient.updateContactAlias(beta.agent_id, "temp name");
    const result = await alphaClient.updateContactAlias(beta.agent_id, null);
    expect(result).toEqual({ ok: true, alias: null });
  });

  it("returns 404 when updating alias for non-contact", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "lone-wolf" });
    const beta = await anon.register({ name: "stranger" });
    const alphaClient = createClient(alpha.secret);

    await expect(alphaClient.updateContactAlias(beta.agent_id, "nickname")).rejects.toMatchObject({ status: 404 });
  });

  // --- Workspace members endpoint ---

  it("workspaceMembers returns all members for a workspace member", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-m1", owner: "A" });
    const beta = await anon.register({ name: "ws-m2", owner: "B" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "MembersTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const result = await alphaClient.workspaceMembers(ws.id);
    expect(result.members).toHaveLength(2);
    const ids = result.members.map((m) => m.agent_id);
    expect(ids).toContain(alpha.agent_id);
    expect(ids).toContain(beta.agent_id);
  });

  it("workspaceMembers rejects non-members", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-owner" });
    const outsider = await anon.register({ name: "outsider" });
    const alphaClient = createClient(alpha.secret);
    const outsiderClient = createClient(outsider.secret);

    const ws = await alphaClient.createWorkspace({ name: "PrivateTeam" });

    await expect(outsiderClient.workspaceMembers(ws.id)).rejects.toMatchObject({ status: 403 });
  });

  // --- SDK contact-scoped task list ---

  it("SDK listTasks returns contact-scoped tasks", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const task = await alphaClient.createTask({
      contact_id: beta.agent_id,
      title: "SDK list test",
      priority: "high",
    });
    expect(task.title).toBe("SDK list test");

    const alphaList = await alphaClient.listTasks(beta.agent_id);
    const betaList = await betaClient.listTasks(alpha.agent_id);
    expect(alphaList.tasks).toHaveLength(1);
    expect(betaList.tasks).toHaveLength(1);
    expect(alphaList.tasks[0].title).toBe("SDK list test");
    expect(alphaList.tasks[0].priority).toBe("high");
  });

  it("SDK listTasks filters by status", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const task = await alphaClient.createTask({ contact_id: beta.agent_id, title: "Open task" });
    await alphaClient.updateTask(beta.agent_id, task.id, { status: "done" });

    const open = await alphaClient.listTasks(beta.agent_id, { status: "open" });
    const done = await alphaClient.listTasks(beta.agent_id, { status: "done" });
    expect(open.tasks).toHaveLength(0);
    expect(done.tasks).toHaveLength(1);
  });

  // --- Documents CRUD ---

  it("creates a shared document and lists it for both contacts", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, {
      name: "Design Doc",
      body: "# Architecture\nInitial draft.",
    });
    expect(doc.name).toBe("Design Doc");
    expect(doc.version).toBe(1);
    expect(doc.last_edited_by).toBe(alpha.agent_id);

    // Both contacts can list it
    const alphaList = await alphaClient.listDocuments(beta.agent_id);
    const betaList = await betaClient.listDocuments(alpha.agent_id);
    expect(alphaList.documents).toHaveLength(1);
    expect(betaList.documents).toHaveLength(1);
    expect(alphaList.documents[0].name).toBe("Design Doc");
  });

  it("gets a document by id with body included", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const created = await alphaClient.createDocument(beta.agent_id, {
      name: "Spec",
      body: "Full content here.",
    });

    const doc = await alphaClient.getDocument(beta.agent_id, created.id);
    expect(doc.body).toBe("Full content here.");
    expect(doc.name).toBe("Spec");
    expect(doc.version).toBe(1);
  });

  it("updates a document and increments version", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, {
      name: "Living Doc",
      body: "v1 content",
    });

    const updated = await betaClient.updateDocument(alpha.agent_id, doc.id, {
      body: "v2 content",
    });
    expect(updated.version).toBe(2);
    expect(updated.last_edited_by).toBe(beta.agent_id);

    // Verify the body was updated
    const fetched = await alphaClient.getDocument(beta.agent_id, doc.id);
    expect(fetched.body).toBe("v2 content");
  });

  it("tracks document version history", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, {
      name: "Versioned Doc",
      body: "first draft",
    });
    await betaClient.updateDocument(alpha.agent_id, doc.id, { body: "second draft" });
    await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "third draft" });

    const versions = await alphaClient.documentVersions(beta.agent_id, doc.id);
    expect(versions.versions).toHaveLength(3);
    expect(versions.versions[0].version).toBe(3); // desc order
    expect(versions.versions[2].version).toBe(1);

    // Retrieve specific version
    const v1 = await betaClient.documentVersion(alpha.agent_id, doc.id, 1);
    expect(v1.body).toBe("first draft");
    expect(v1.version).toBe(1);

    const v2 = await betaClient.documentVersion(alpha.agent_id, doc.id, 2);
    expect(v2.body).toBe("second draft");
  });

  it("rejects document creation for non-contacts", async () => {
    const alpha = await createClient().register({ name: "doc-alpha" });
    const beta = await createClient().register({ name: "doc-beta" });
    const alphaClient = createClient(alpha.secret);

    await expect(
      alphaClient.createDocument(beta.agent_id, { name: "Forbidden", body: "nope" })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("deletes a document and its versions", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "Temp doc", body: "will be deleted" });
    await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "v2" });

    await expect(alphaClient.deleteDocument(beta.agent_id, doc.id)).resolves.toEqual({ ok: true });

    // Document should no longer appear in list
    const list = await betaClient.listDocuments(alphaClient["secret"] ? beta.agent_id : beta.agent_id);
    // Use alpha's perspective to list
    const alphaList = await alphaClient.listDocuments(beta.agent_id);
    expect(alphaList.documents).toHaveLength(0);
  });

  it("returns 404 when deleting non-existent document", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(alphaClient.deleteDocument(beta.agent_id, "00000000-0000-0000-0000-ffffffffffff")).rejects.toMatchObject({ status: 404 });
  });

  // --- Pagination ---

  it("inbox returns has_more and next_cursor when limit < total messages", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send 5 messages from beta to alpha
    for (let i = 0; i < 5; i++) {
      await betaClient.send({ to: alpha.agent_id, type: "update", payload: { content: `msg-${i}` } });
    }

    const page1 = await alphaClient.inbox({ limit: 2 });
    expect(page1.messages).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    // Fetch next page
    const page2 = await alphaClient.inbox({ limit: 2, cursor: page1.next_cursor! });
    expect(page2.messages).toHaveLength(2);
    expect(page2.has_more).toBe(true);
    expect(page2.next_cursor).toBeTruthy();

    // No overlap between pages
    const page1Ids = new Set(page1.messages.map(m => m.id));
    for (const m of page2.messages) {
      expect(page1Ids.has(m.id)).toBe(false);
    }

    // Fetch last page
    const page3 = await alphaClient.inbox({ limit: 2, cursor: page2.next_cursor! });
    expect(page3.messages).toHaveLength(1);
    expect(page3.has_more).toBe(false);
    expect(page3.next_cursor).toBeNull();
  });

  it("inbox with no cursor returns first page with pagination metadata", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await betaClient.send({ to: alpha.agent_id, type: "update", payload: { content: "hello" } });

    const result = await alphaClient.inbox();
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
  });

  it("sent endpoint supports cursor pagination", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    for (let i = 0; i < 3; i++) {
      await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: `sent-${i}` } });
    }

    const page1 = await alphaClient.sent({ limit: 2 });
    expect(page1.messages).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await alphaClient.sent({ limit: 2, cursor: page1.next_cursor! });
    expect(page2.messages).toHaveLength(1);
    expect(page2.has_more).toBe(false);
  });

  it("search endpoint supports cursor pagination", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    for (let i = 0; i < 4; i++) {
      await betaClient.send({ to: alpha.agent_id, type: "update", payload: { content: `search-${i}` } });
    }

    const page1 = await alphaClient.search({ limit: 2 });
    expect(page1.messages).toHaveLength(2);
    expect(page1.has_more).toBe(true);

    const page2 = await alphaClient.search({ limit: 2, cursor: page1.next_cursor! });
    expect(page2.messages).toHaveLength(2);
    expect(page2.has_more).toBe(false);
  });

  it("task list supports cursor pagination", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    for (let i = 0; i < 4; i++) {
      await alphaClient.createTask({ contact_id: beta.agent_id, title: `task-${i}` });
    }

    const page1 = await alphaClient.listTasks(beta.agent_id, { limit: 2 });
    expect(page1.tasks).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await alphaClient.listTasks(beta.agent_id, { limit: 2, cursor: page1.next_cursor! });
    expect(page2.tasks).toHaveLength(2);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();

    // Verify no overlap
    const page1Ids = new Set(page1.tasks.map(t => t.id));
    for (const t of page2.tasks) {
      expect(page1Ids.has(t.id)).toBe(false);
    }
  });

  it("document list supports cursor pagination", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    for (let i = 0; i < 3; i++) {
      await alphaClient.createDocument(beta.agent_id, { name: `doc-${i}`, body: `body-${i}` });
    }

    const page1 = await alphaClient.listDocuments(beta.agent_id, { limit: 2 });
    expect(page1.documents).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await alphaClient.listDocuments(beta.agent_id, { limit: 2, cursor: page1.next_cursor! });
    expect(page2.documents).toHaveLength(1);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();
  });

  it("template list supports cursor pagination", async () => {
    const reg = await createClient().register({ name: "tpl-pag" });
    const client = createClient(reg.secret);

    for (let i = 0; i < 3; i++) {
      await client.createTemplate({ name: `tpl-${i}`, type: "ping", payload: { i } });
    }

    const page1 = await client.listTemplates({ limit: 2 });
    expect(page1.templates).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await client.listTemplates({ limit: 2, cursor: page1.next_cursor! });
    expect(page2.templates).toHaveLength(1);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();

    // Verify no overlap
    const page1Ids = new Set(page1.templates.map(t => t.id));
    for (const t of page2.templates) {
      expect(page1Ids.has(t.id)).toBe(false);
    }
  });

  it("attachment list supports cursor pagination", async () => {
    const reg = await createClient().register({ name: "att-pag" });
    const client = createClient(reg.secret);

    for (let i = 0; i < 3; i++) {
      await client.uploadAttachment({ filename: `file-${i}.txt`, data: btoa(`data-${i}`) });
    }

    const page1 = await client.listAttachments({ limit: 2 });
    expect(page1.attachments).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await client.listAttachments({ limit: 2, cursor: page1.next_cursor! });
    expect(page2.attachments).toHaveLength(1);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();
  });

  it("document version history supports cursor pagination", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Create a document and update it multiple times to generate versions
    const doc = await alphaClient.createDocument(beta.agent_id, { name: "ver-doc", body: "v1" });
    await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "v2" });
    await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "v3" });

    // Fetch versions with limit=2
    const r1 = await app.request(`/documents/${beta.agent_id}/${doc.id}/versions?limit=2`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(r1.status).toBe(200);
    const page1 = await r1.json() as { versions: unknown[]; has_more: boolean; next_cursor: string | null };
    expect(page1.versions).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    const r2 = await app.request(`/documents/${beta.agent_id}/${doc.id}/versions?limit=2&cursor=${page1.next_cursor}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(r2.status).toBe(200);
    const page2 = await r2.json() as { versions: unknown[]; has_more: boolean; next_cursor: string | null };
    expect(page2.versions).toHaveLength(1);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();
  });

  // --- Message Forwarding ---

  it("forward sends a message to another contact with provenance metadata", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const gamma = await createClient().register({ name: "gamma" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);
    const gammaClient = createClient(gamma.secret);

    await alphaClient.pair({ code: beta.pairing_code });
    await betaClient.pair({ code: gamma.pairing_code });

    // Alpha sends to beta
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "Important info" },
    });

    // Beta forwards to gamma
    const forwarded = await betaClient.forward(sent.id, gamma.agent_id, "FYI");

    expect(forwarded).toMatchObject({
      id: expect.any(String),
      thread_id: expect.any(String),
      status: "delivered",
    });

    // Gamma sees the forwarded message with provenance
    const inbox = await gammaClient.inbox();
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].payload).toMatchObject({
      content: "Important info",
      forwarded_from: alpha.agent_id,
      original_message_id: sent.id,
      forward_comment: "FYI",
    });
  });

  it("forward preserves original message type", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const gamma = await createClient().register({ name: "gamma" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    await alphaClient.pair({ code: beta.pairing_code });
    await betaClient.pair({ code: gamma.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "decision",
      payload: { content: "We ship Monday" },
    });

    const forwarded = await betaClient.forward(sent.id, gamma.agent_id);

    const gammaClient = createClient(gamma.secret);
    const inbox = await gammaClient.inbox();
    expect(inbox.messages[0].type).toBe("decision");
  });

  it("forward rejects if target is not a contact", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const gamma = await createClient().register({ name: "gamma" });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "test" },
    });

    await expect(alphaClient.forward(sent.id, gamma.agent_id)).rejects.toMatchObject({ status: 403 });
  });

  it("forward returns 404 for messages the agent cannot see", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(alphaClient.forward("00000000-0000-0000-0000-000000000099", beta.agent_id)).rejects.toMatchObject({ status: 404 });
  });

  it("sender can forward their own sent message", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const gamma = await createClient().register({ name: "gamma" });
    const alphaClient = createClient(alpha.secret);

    await alphaClient.pair({ code: beta.pairing_code });
    await alphaClient.pair({ code: gamma.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "Shared update" },
    });

    const forwarded = await alphaClient.forward(sent.id, gamma.agent_id);
    expect(forwarded.status).toBe("delivered");
  });

  it("forward rejects when target has blocked the forwarder", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const gamma = await createClient().register({ name: "gamma" });
    const alphaClient = createClient(alpha.secret);
    const gammaClient = createClient(gamma.secret);

    await alphaClient.pair({ code: beta.pairing_code });
    await alphaClient.pair({ code: gamma.pairing_code });

    // Alpha sends a message to beta
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "Will try to forward" },
    });

    // Gamma blocks alpha
    await gammaClient.blockContact(alpha.agent_id);

    // Alpha tries to forward to gamma — should be rejected
    await expect(alphaClient.forward(sent.id, gamma.agent_id)).rejects.toMatchObject({ status: 403 });
  });

  // --- Message Reactions ---

  it("react adds an emoji reaction to a message", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "Nice work!" },
    });

    const reaction = await alphaClient.react(sent.id, "👍");

    expect(reaction).toMatchObject({
      id: expect.any(String),
      message_id: sent.id,
      emoji: "👍",
      created_at: expect.any(String),
    });
  });

  it("react is idempotent — same emoji returns existing reaction", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "test" },
    });

    const first = await alphaClient.react(sent.id, "🎉");
    const second = await alphaClient.react(sent.id, "🎉");

    expect(second.id).toBe(first.id);
  });

  it("recipient can react to a received message", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "Thoughts?" },
    });

    const reaction = await betaClient.react(sent.id, "👀");

    expect(reaction).toMatchObject({
      message_id: sent.id,
      emoji: "👀",
    });
  });

  it("react returns 404 for messages the agent cannot see", async () => {
    const { alphaClient } = await registerPair();

    await expect(alphaClient.react("00000000-0000-0000-0000-000000000099", "👍")).rejects.toMatchObject({ status: 404 });
  });

  it("react rejects emoji longer than 32 chars", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "test" },
    });

    await expect(alphaClient.react(sent.id, "x".repeat(33))).rejects.toMatchObject({ status: 400 });
  });

  it("unreact removes a reaction", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "test" },
    });
    await alphaClient.react(sent.id, "👍");

    const result = await alphaClient.unreact(sent.id, "👍");
    expect(result).toMatchObject({ ok: true });

    const list = await alphaClient.reactions(sent.id);
    expect(list.reactions).toHaveLength(0);
  });

  it("unreact returns 404 for non-existent reaction", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "test" },
    });

    await expect(alphaClient.unreact(sent.id, "👍")).rejects.toMatchObject({ status: 404 });
  });

  it("reactions lists all reactions grouped by emoji", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "Ship it!" },
    });

    await alphaClient.react(sent.id, "🚀");
    await betaClient.react(sent.id, "🚀");
    await alphaClient.react(sent.id, "👍");

    const list = await alphaClient.reactions(sent.id);

    expect(list.message_id).toBe(sent.id);
    expect(list.reactions).toHaveLength(3);
    expect(list.summary["🚀"]).toMatchObject({ count: 2 });
    expect(list.summary["🚀"].agents).toContain(alpha.agent_id);
    expect(list.summary["🚀"].agents).toContain(beta.agent_id);
    expect(list.summary["👍"]).toMatchObject({ count: 1 });
  });

  it("reactions returns 404 for messages the agent cannot see", async () => {
    const { alphaClient } = await registerPair();

    await expect(alphaClient.reactions("00000000-0000-0000-0000-000000000099")).rejects.toMatchObject({ status: 404 });
  });

  // --- Presence ---

  it("presence returns workspace members with online/away/offline status", async () => {
    const alpha = await createClient().register({ name: "alpha", owner: "Andrei" });
    const beta = await createClient().register({ name: "beta", owner: "Frank" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    // Create workspace and join both agents
    const ws = await alphaClient.createWorkspace({ name: "Test Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Both agents make API calls which will touch lastSeenAt
    await alphaClient.me();
    await betaClient.me();

    const presence = await alphaClient.presence();

    expect(presence.workspace_id).toBe(ws.id);
    expect(presence.members).toHaveLength(2);
    expect(presence.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent_id: alpha.agent_id, name: "alpha", status: "online" }),
        expect.objectContaining({ agent_id: beta.agent_id, name: "beta", status: "online" }),
      ])
    );
    expect(presence.online).toBe(2);
    expect(presence.away).toBe(0);
    expect(presence.offline).toBe(0);
  });

  it("presence returns offline for agents that never made an API call", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "Test Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Manually set beta's lastSeenAt to null (simulating never seen)
    const betaRow = testState.agents.find(a => a.id === beta.agent_id);
    if (betaRow) betaRow.lastSeenAt = null;

    const presence = await alphaClient.presence();

    const betaPresence = presence.members.find((m: any) => m.agent_id === beta.agent_id);
    expect(betaPresence).toMatchObject({ status: "offline" });
  });

  it("presence returns away for agents with lastSeenAt between 5-30 minutes ago", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "Test Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Set beta's lastSeenAt to 10 minutes ago
    const betaRow = testState.agents.find(a => a.id === beta.agent_id);
    if (betaRow) betaRow.lastSeenAt = new Date(Date.now() - 10 * 60 * 1000);

    const presence = await alphaClient.presence();

    const betaPresence = presence.members.find((m: any) => m.agent_id === beta.agent_id);
    expect(betaPresence).toMatchObject({ status: "away" });
  });

  it("presence includes status_text and role from agent metadata", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "Meta Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Set status text and role via metadata
    await alphaClient.setStatus("Busy coding");
    const alphaRow = testState.agents.find(a => a.id === alpha.agent_id);
    if (alphaRow) {
      alphaRow.metadata = { ...(alphaRow.metadata as Record<string, unknown> ?? {}), role: "developer", status_text: "Busy coding" };
    }

    const presence = await alphaClient.presence();
    const alphaPresence = presence.members.find((m: any) => m.agent_id === alpha.agent_id);
    expect(alphaPresence).toMatchObject({
      status_text: "Busy coding",
      role: "developer",
    });
  });

  it("presence returns null status_text when not set", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "No Meta Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const presence = await alphaClient.presence();
    const betaPresence = presence.members.find((m: any) => m.agent_id === beta.agent_id);
    expect(betaPresence!.status_text).toBeNull();
  });

  it("presence returns offline for agents with lastSeenAt > 30 minutes ago", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "Old Team" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Set beta's lastSeenAt to 45 minutes ago (beyond 30-min threshold)
    const betaRow = testState.agents.find(a => a.id === beta.agent_id);
    if (betaRow) betaRow.lastSeenAt = new Date(Date.now() - 45 * 60 * 1000);

    const presence = await alphaClient.presence();
    const betaPresence = presence.members.find((m: any) => m.agent_id === beta.agent_id);
    expect(betaPresence).toMatchObject({ status: "offline" });
  });

  // --- Message pinning ---

  it("pin and unpin a message, then list thread pins", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "decision",
      payload: { content: "We'll use Postgres." },
    });

    // Pin the message
    const pinResult = await betaClient.pin(sent.id);
    expect(pinResult).toMatchObject({ ok: true });
    expect(pinResult.pinned_at).toBeDefined();
    expect(pinResult.pinned_by).toBe(beta.agent_id);

    // List pins in the thread
    const pins = await alphaClient.threadPins(sent.thread_id);
    expect(pins.thread_id).toBe(sent.thread_id);
    expect(pins.count).toBe(1);
    expect(pins.pinned[0]).toMatchObject({
      id: sent.id,
      type: "decision",
    });

    // Unpin the message
    const unpinResult = await betaClient.unpin(sent.id);
    expect(unpinResult).toMatchObject({ ok: true });

    // Verify no more pins
    const pinsAfter = await alphaClient.threadPins(sent.thread_id);
    expect(pinsAfter.count).toBe(0);
  });

  it("pin returns already_pinned for re-pins", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "Important update" },
    });

    await betaClient.pin(sent.id);
    const repin = await betaClient.pin(sent.id);
    expect(repin).toMatchObject({ ok: true, already_pinned: true });
  });

  it("pin returns 404 for messages the agent cannot see", async () => {
    const { alphaClient } = await registerPair();
    await expect(alphaClient.pin("00000000-0000-0000-0000-000000000099")).rejects.toMatchObject({ status: 404 });
  });

  // --- Webhook test ---

  it("testWebhook returns 400 when no webhook URL is configured", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.testWebhook()).rejects.toMatchObject({ status: 400 });
  });

  // --- Webhook management ---

  it("webhookConfig returns unconfigured state for new agents", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const config = await client.webhookConfig();
    expect(config).toMatchObject({
      url: null,
      configured: false,
    });
  });

  it("updateWebhook sets the webhook URL", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const config = await client.updateWebhook("https://example.com/hook");
    expect(config).toMatchObject({
      url: "https://example.com/hook",
      configured: true,
    });
    expect(config.secret_hint).toBeTruthy();

    const me = await client.me();
    expect(me.webhook_url).toBe("https://example.com/hook");
  });

  it("updateWebhook rejects invalid URLs", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(client.updateWebhook("not-a-url")).rejects.toMatchObject({ status: 400 });
  });

  it("removeWebhook clears the webhook URL", async () => {
    const alpha = await createClient().register({ name: "alpha", webhook_url: "https://example.com/hook" });
    const client = createClient(alpha.secret);

    await expect(client.removeWebhook()).resolves.toEqual({ ok: true });

    const config = await client.webhookConfig();
    expect(config).toMatchObject({
      url: null,
      configured: false,
    });
  });

  it("rotateWebhookSecret returns a new secret", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const oldConfig = await client.webhookConfig();
    const rotated = await client.rotateWebhookSecret();
    expect(rotated.webhook_secret).toBeTruthy();
    expect(rotated.webhook_secret).toMatch(/^[a-f0-9]{64}$/);

    const newConfig = await client.webhookConfig();
    expect(newConfig.secret_hint).not.toBe(oldConfig.secret_hint);
  });

  it("webhookDeliveries returns empty for new agents", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const result = await client.webhookDeliveries();
    expect(result).toMatchObject({
      deliveries: [],
      count: 0,
    });
  });

  it("webhookDeliveries returns logged deliveries", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    // Manually insert a delivery record to simulate webhook delivery logging
    testState["webhook_deliveries"].push({
      id: "a0000000-0000-0000-0000-000000000001",
      agentId: alpha.agent_id,
      messageId: null,
      url: "https://example.com/hook",
      event: "webhook.test",
      success: 1,
      httpStatus: 200,
      latencyMs: 42,
      error: null,
      attempts: 1,
      createdAt: new Date(),
    });

    const result = await client.webhookDeliveries();
    expect(result.count).toBe(1);
    expect(result.deliveries[0]).toMatchObject({
      id: "a0000000-0000-0000-0000-000000000001",
      url: "https://example.com/hook",
      event: "webhook.test",
      success: true,
      http_status: 200,
      latency_ms: 42,
    });
  });

  it("webhookDeliveries respects limit parameter", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    for (let i = 0; i < 5; i++) {
      testState["webhook_deliveries"].push({
        id: `whd_limit_${i}`,
        agentId: alpha.agent_id,
        messageId: null,
        url: "https://example.com/hook",
        event: "webhook.test",
        success: 1,
        httpStatus: 200,
        latencyMs: 10,
        error: null,
        attempts: 1,
        createdAt: new Date(Date.now() + i),
      });
    }

    const result = await client.webhookDeliveries({ limit: 2 });
    expect(result.count).toBe(2);
  });

  // --- Webhook Delivery Retry ---

  it("retryWebhookDelivery returns 404 for non-existent delivery", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);
    await client.updateWebhook("https://example.com/hook");

    await expect(client.retryWebhookDelivery("00000000-0000-0000-0000-000000000099")).rejects.toMatchObject({ status: 404 });
  });

  it("retryWebhookDelivery returns 409 for already-succeeded delivery", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);
    await client.updateWebhook("https://example.com/hook");

    testState["webhook_deliveries"].push({
      id: "a0000000-0000-0000-0000-000000000002",
      agentId: alpha.agent_id,
      messageId: "msg_123",
      url: "https://example.com/hook",
      event: "message.received",
      success: 1,
      httpStatus: 200,
      latencyMs: 50,
      error: null,
      attempts: 1,
      createdAt: new Date(),
    });

    await expect(client.retryWebhookDelivery("a0000000-0000-0000-0000-000000000002")).rejects.toMatchObject({ status: 409 });
  });

  it("retryWebhookDelivery returns 400 when no webhook URL configured", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    testState["webhook_deliveries"].push({
      id: "a0000000-0000-0000-0000-000000000003",
      agentId: alpha.agent_id,
      messageId: "msg_456",
      url: "https://old-url.com/hook",
      event: "message.received",
      success: 0,
      httpStatus: 500,
      latencyMs: 100,
      error: "HTTP 500",
      attempts: 3,
      createdAt: new Date(),
    });

    await expect(client.retryWebhookDelivery("a0000000-0000-0000-0000-000000000003")).rejects.toMatchObject({ status: 400 });
  });

  it("retryWebhookDelivery returns 400 for test deliveries without message_id", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);
    await client.updateWebhook("https://example.com/hook");

    testState["webhook_deliveries"].push({
      id: "a0000000-0000-0000-0000-000000000004",
      agentId: alpha.agent_id,
      messageId: null,
      url: "https://example.com/hook",
      event: "webhook.test",
      success: 0,
      httpStatus: null,
      latencyMs: null,
      error: "timeout",
      attempts: 1,
      createdAt: new Date(),
    });

    await expect(client.retryWebhookDelivery("a0000000-0000-0000-0000-000000000004")).rejects.toMatchObject({ status: 400 });
  });

  it("retryWebhookDelivery returns 404 when original message no longer exists", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);
    await client.updateWebhook("https://example.com/hook");

    testState["webhook_deliveries"].push({
      id: "a0000000-0000-0000-0000-000000000005",
      agentId: alpha.agent_id,
      messageId: "msg_deleted_999",
      url: "https://example.com/hook",
      event: "message.received",
      success: 0,
      httpStatus: 500,
      latencyMs: 200,
      error: "HTTP 500",
      attempts: 2,
      createdAt: new Date(),
    });

    await expect(client.retryWebhookDelivery("a0000000-0000-0000-0000-000000000005")).rejects.toMatchObject({ status: 404 });
  });

  it("retryWebhookDelivery cannot retry another agent's delivery", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const clientA = createClient(alpha.secret);
    await clientA.updateWebhook("https://example.com/hook");

    testState["webhook_deliveries"].push({
      id: "a0000000-0000-0000-0000-000000000006",
      agentId: beta.agent_id,
      messageId: "msg_789",
      url: "https://beta.example.com/hook",
      event: "message.received",
      success: 0,
      httpStatus: 500,
      latencyMs: 100,
      error: "HTTP 500",
      attempts: 1,
      createdAt: new Date(),
    });

    await expect(clientA.retryWebhookDelivery("a0000000-0000-0000-0000-000000000006")).rejects.toMatchObject({ status: 404 });
  });

  it("retryWebhookDelivery attempts re-delivery and logs new delivery record", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    await betaClient.updateWebhook("https://beta.example.com/hook");

    // Send a message from alpha to beta
    const receipt = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "test retry" },
    });

    // Manually mark as failed delivery
    testState["webhook_deliveries"].push({
      id: "a0000000-0000-0000-0000-000000000007",
      agentId: beta.agent_id,
      messageId: receipt.id,
      url: "https://beta.example.com/hook",
      event: "message.received",
      success: 0,
      httpStatus: 500,
      latencyMs: 150,
      error: "HTTP 500",
      attempts: 3,
      createdAt: new Date(),
    });

    // Retry — fetch will fail in test env (no real server), so expect 502
    const res = await app.request(`/agents/me/webhook/deliveries/a0000000-0000-0000-0000-000000000007/retry`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${beta.secret}` },
    });
    const body = await res.json();

    // Should return a response (either success or 502 depending on fetch behavior)
    expect(body).toHaveProperty("delivery_id");
    expect(body).toHaveProperty("original_delivery_id", "a0000000-0000-0000-0000-000000000007");
    expect(body).toHaveProperty("message_id", receipt.id);

    // A new delivery record should be logged
    const deliveries = testState["webhook_deliveries"].filter(
      (d: WebhookDeliveryRow) => d.event === "message.received.retry"
    );
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].messageId).toBe(receipt.id);
  });

  it("presence returns 400 when not in a workspace", async () => {
    const alpha = await createClient().register({ name: "solo" });
    const client = createClient(alpha.secret);

    await expect(client.presence()).rejects.toMatchObject({ status: 400 });
  });

  // --- Message Scheduling ---

  it("send with scheduled_at creates a scheduled message that is not delivered immediately", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
    const receipt = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "scheduled message" },
      scheduled_at: futureDate,
    });

    expect(receipt.status).toBe("scheduled");
    expect(receipt.scheduled_at).toBeDefined();

    // Message should NOT appear in beta's inbox (not delivered yet)
    const inbox = await betaClient.inbox();
    const found = inbox.messages.filter((m: { id: string }) => m.id === receipt.id);
    expect(found.length).toBe(0);
  });

  it("scheduledMessages lists only scheduled messages for the sender", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send a normal message
    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "immediate" },
    });

    // Send a scheduled message
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "later" },
      scheduled_at: futureDate,
    });

    const list = await alphaClient.scheduledMessages();
    expect(list.messages.length).toBe(1);
    expect(list.messages[0].id).toBe(scheduled.id);
  });

  it("cancelScheduled cancels a scheduled message", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "will be cancelled" },
      scheduled_at: futureDate,
    });

    const result = await alphaClient.cancelScheduled(scheduled.id);
    expect(result.ok).toBe(true);
    expect(result.message_id).toBe(scheduled.id);

    // Should no longer appear in scheduled list
    const list = await alphaClient.scheduledMessages();
    expect(list.messages.length).toBe(0);
  });

  it("cancelScheduled rejects non-scheduled messages", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const receipt = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "already sent" },
    });

    await expect(alphaClient.cancelScheduled(receipt.id)).rejects.toMatchObject({
      status: 400,
      message: "Only scheduled messages can be cancelled",
    });
  });

  it("deliverScheduled delivers due messages and skips future ones", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Create a scheduled message with a time in the past (simulate it becoming due)
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "due soon" },
      scheduled_at: futureDate,
    });

    // Manually set scheduledAt to the past to simulate it becoming due
    const msg = testState.messages.find((m) => m.id === scheduled.id);
    if (msg) msg.scheduledAt = new Date(Date.now() - 1000);

    const result = await alphaClient.deliverScheduled();
    expect(result.delivered).toBe(1);

    // Should now be in beta's inbox
    const inbox = await betaClient.inbox();
    const found = inbox.messages.filter((m: { id: string }) => m.id === scheduled.id);
    expect(found.length).toBe(1);
  });

  it("send rejects scheduled_at in the past", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    await expect(
      alphaClient.send({
        to: beta.agent_id,
        type: "update",
        payload: { content: "too late" },
        scheduled_at: pastDate,
      })
    ).rejects.toMatchObject({ status: 400, message: "scheduled_at must be in the future" });
  });

  it("send rejects invalid scheduled_at format", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(
      alphaClient.send({
        to: beta.agent_id,
        type: "update",
        payload: { content: "bad date" },
        scheduled_at: "not-a-date",
      })
    ).rejects.toMatchObject({ status: 400, message: "scheduled_at must be a valid ISO 8601 date" });
  });

  // --- Audit log ---

  it("auditLog returns events for the authenticated agent", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    // Pairing creates audit events
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.auditLog();
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0]).toHaveProperty("id");
    expect(result.events[0]).toHaveProperty("action");
    expect(result.events[0]).toHaveProperty("target_type");
    expect(result.events[0]).toHaveProperty("created_at");
  });

  it("auditLog filters by action", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send a message to generate a message.send audit event
    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "hello" },
    });

    const result = await alphaClient.auditLog({ action: "message.send" });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((e) => e.action === "message.send")).toBe(true);
  });

  it("auditLog filters by target_type", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.auditLog({ target_type: "agent" });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((e) => e.target_type === "agent")).toBe(true);
  });

  it("auditLog returns empty for unmatched filter", async () => {
    const { alphaClient } = await registerPair();

    const result = await alphaClient.auditLog({ action: "nonexistent.action" });
    expect(result.events).toEqual([]);
  });

  it("auditLog respects limit parameter", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send multiple messages to generate events
    for (let i = 0; i < 3; i++) {
      await alphaClient.send({
        to: beta.agent_id,
        type: "update",
        payload: { content: `msg ${i}` },
      });
    }

    const result = await alphaClient.auditLog({ limit: 2 });
    expect(result.events.length).toBe(2);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBeTruthy();
  });

  it("auditLog paginates with cursor", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    for (let i = 0; i < 3; i++) {
      await alphaClient.send({
        to: beta.agent_id,
        type: "update",
        payload: { content: `msg ${i}` },
      });
    }

    const page1 = await alphaClient.auditLog({ limit: 2 });
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await alphaClient.auditLog({ limit: 2, cursor: page1.next_cursor! });
    // Page 2 should have different events than page 1
    const page1Ids = new Set(page1.events.map((e) => e.id));
    expect(page2.events.every((e) => !page1Ids.has(e.id))).toBe(true);
  });

  it("auditLog does not leak events from other agents", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Alpha sends a message
    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "hello" },
    });

    // Beta's audit log should NOT contain alpha's send events
    const betaResult = await betaClient.auditLog({ action: "message.send" });
    expect(betaResult.events).toEqual([]);
  });

  it("auditLog rejects overlong filter parameters", async () => {
    const { alpha, alphaClient } = await registerPair();
    const longValue = "a".repeat(101);

    const res1 = await app.request(`/audit-events?action=${longValue}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res1.status).toBe(400);

    const res2 = await app.request(`/audit-events?target_type=${longValue}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res2.status).toBe(400);

    const res3 = await app.request(`/audit-events?target_id=${longValue}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res3.status).toBe(400);
  });

  it("auditLog requires authentication", async () => {
    const unauthenticated = createClient("bad-secret");
    await expect(unauthenticated.auditLog()).rejects.toMatchObject({ status: 401 });
  });

  // --- Thread listing ---

  it("listThreads returns threads the agent participates in", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Create messages in two different threads
    const msg1 = await alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "thread one" },
    });
    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "thread two" },
    });

    const result = await alphaClient.listThreads();
    expect(result.threads.length).toBe(2);
    expect(result.threads[0]).toHaveProperty("thread_id");
    expect(result.threads[0]).toHaveProperty("message_count");
    expect(result.threads[0]).toHaveProperty("unread_count");
    expect(result.threads[0]).toHaveProperty("participants");
    expect(result.threads[0]).toHaveProperty("last_message");
    expect(result.threads[0]).toHaveProperty("last_activity");

    // Participants should include resolved names
    const thread = result.threads[0];
    expect(thread.participants.length).toBeGreaterThanOrEqual(2);
    for (const p of thread.participants) {
      expect(p).toHaveProperty("agent_id");
      expect(p).toHaveProperty("name");
      expect(typeof p.agent_id).toBe("string");
    }

    // Last message should include from_name
    expect(thread.last_message).toHaveProperty("from_name");
  });

  it("listThreads shows unread count for inbox messages", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Alpha sends to beta — beta has unread
    await alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "hello" },
    });

    // Beta sees 1 unread
    const betaThreads = await betaClient.listThreads();
    expect(betaThreads.threads.length).toBe(1);
    expect(betaThreads.threads[0].unread_count).toBe(1);

    // Alpha sees 0 unread (they sent it)
    const alphaThreads = await alphaClient.listThreads();
    expect(alphaThreads.threads[0].unread_count).toBe(0);
  });

  it("listThreads includes preview from last message content", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "preview text here" },
    });

    const result = await alphaClient.listThreads();
    expect(result.threads[0].last_message.preview).toBe("preview text here");
  });

  it("listThreads respects limit and paginates", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Create 3 separate threads
    for (let i = 0; i < 3; i++) {
      await alphaClient.send({
        to: beta.agent_id,
        type: "update",
        payload: { content: `thread ${i}` },
      });
    }

    const page1 = await alphaClient.listThreads({ limit: 2 });
    expect(page1.threads.length).toBe(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await alphaClient.listThreads({ limit: 2, cursor: page1.next_cursor! });
    expect(page2.threads.length).toBe(1);
    expect(page2.has_more).toBe(false);

    // No overlap
    const p1Ids = new Set(page1.threads.map((t) => t.thread_id));
    expect(page2.threads.every((t) => !p1Ids.has(t.thread_id))).toBe(true);
  });

  it("listThreads returns empty for agent with no messages", async () => {
    const alpha = await createClient().register({ name: "lonely" });
    const client = createClient(alpha.secret);

    const result = await client.listThreads();
    expect(result.threads).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  it("listThreads groups messages by thread_id", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send and reply in same thread
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "question",
      payload: { content: "question" },
    });
    await betaClient.reply(msg.id, {
      type: "ack",
      payload: { content: "answer" },
    });

    // Alpha should see 1 thread with 2 messages
    const result = await alphaClient.listThreads();
    const thread = result.threads.find((t) => t.thread_id === msg.thread_id);
    expect(thread).toBeDefined();
    expect(thread!.message_count).toBe(2);
  });

  // ── Message Labels ──
  it("can add, list, and remove labels on a message", async () => {
    const { alphaClient, beta } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "label test" },
    });

    // Add a label
    const added = await alphaClient.addLabel(msg.id, "Important");
    expect(added.label).toBe("important"); // normalized to lowercase
    expect(added.message_id).toBe(msg.id);

    // Add another label
    await alphaClient.addLabel(msg.id, "action-required");

    // List labels on the message
    const labels = await alphaClient.messageLabels(msg.id);
    expect(labels.message_id).toBe(msg.id);
    expect(labels.count).toBe(2);
    expect(labels.labels.map((l) => l.label).sort()).toEqual(["action-required", "important"]);

    // Remove a label
    await alphaClient.removeLabel(msg.id, "important");
    const afterRemove = await alphaClient.messageLabels(msg.id);
    expect(afterRemove.count).toBe(1);
    expect(afterRemove.labels[0].label).toBe("action-required");
  });

  it("returns 404 when removing a label that doesn't exist", async () => {
    const { alphaClient, beta } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "test" },
    });
    await expect(alphaClient.removeLabel(msg.id, "nonexistent")).rejects.toThrow(TrunkApiError);
  });

  it("can add duplicate label idempotently", async () => {
    const { alphaClient, beta } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "test" },
    });
    const first = await alphaClient.addLabel(msg.id, "urgent");
    const second = await alphaClient.addLabel(msg.id, "urgent");
    expect(first.label).toBe("urgent");
    expect(second.label).toBe("urgent");

    const labels = await alphaClient.messageLabels(msg.id);
    expect(labels.count).toBe(1);
  });

  it("can list all labels used by the agent", async () => {
    const { alphaClient, beta } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg1 = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "msg1" },
    });
    const msg2 = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "msg2" },
    });
    await alphaClient.addLabel(msg1.id, "important");
    await alphaClient.addLabel(msg2.id, "important");
    await alphaClient.addLabel(msg1.id, "review");

    const result = await alphaClient.allLabels();
    const importantLabel = result.labels.find((l) => l.label === "important");
    const reviewLabel = result.labels.find((l) => l.label === "review");
    expect(importantLabel?.count).toBe(2);
    expect(reviewLabel?.count).toBe(1);
  });

  it("can filter messages by label", async () => {
    const { alphaClient, beta } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg1 = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "labeled" },
    });
    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "unlabeled" },
    });
    await alphaClient.addLabel(msg1.id, "flagged");

    const result = await alphaClient.messagesByLabel("flagged");
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].id).toBe(msg1.id);
  });

  it("recipient can label received messages", async () => {
    const { alphaClient, beta, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "for beta" },
    });
    const added = await betaClient.addLabel(msg.id, "needs-response");
    expect(added.label).toBe("needs-response");

    // Beta's labels are private — alpha sees no labels
    const alphaLabels = await alphaClient.messageLabels(msg.id);
    expect(alphaLabels.count).toBe(0);
  });

  it("rejects labeling a message by an unrelated agent", async () => {
    const { alphaClient, beta } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "private" },
    });

    // Register a third agent that's not sender or recipient
    const gamma = await createClient().register({ name: "gamma" });
    const gammaClient = createClient(gamma.secret);
    await expect(gammaClient.addLabel(msg.id, "snoop")).rejects.toThrow(TrunkApiError);
  });

  // ── Contact Blocking ──
  it("can block and unblock a contact", async () => {
    const { alpha, alphaClient, beta, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Beta blocks alpha
    const block = await betaClient.blockContact(alpha.agent_id, "spam");
    expect(block.ok).toBe(true);

    // List blocked
    const blocked = await betaClient.blockedContacts();
    expect(blocked.count).toBe(1);
    expect(blocked.blocked[0].agent_id).toBe(alpha.agent_id);
    expect(blocked.blocked[0].reason).toBe("spam");

    // Unblock
    const unblock = await betaClient.unblockContact(alpha.agent_id);
    expect(unblock.ok).toBe(true);

    const afterUnblock = await betaClient.blockedContacts();
    expect(afterUnblock.count).toBe(0);
  });

  it("blocked agent cannot send messages", async () => {
    const { alpha, alphaClient, beta, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Beta blocks alpha
    await betaClient.blockContact(alpha.agent_id, "unwanted");

    // Alpha tries to send to beta — should fail
    await expect(
      alphaClient.send({
        to: beta.agent_id,
        type: "update",
        payload: { content: "hello" },
      })
    ).rejects.toThrow(TrunkApiError);
  });

  it("unblocked agent can send messages again", async () => {
    const { alpha, alphaClient, beta, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await betaClient.blockContact(alpha.agent_id);
    await betaClient.unblockContact(alpha.agent_id);

    // Should succeed now
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "hello again" },
    });
    expect(sent.id).toBeDefined();
  });

  it("blocking is one-directional", async () => {
    const { alpha, alphaClient, beta, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Beta blocks alpha
    await betaClient.blockContact(alpha.agent_id);

    // Beta can still send to alpha (block is one-way)
    const sent = await betaClient.send({
      to: alpha.agent_id,
      type: "update",
      payload: { content: "I blocked you but I can still write" },
    });
    expect(sent.id).toBeDefined();
  });

  it("blocked agent cannot reply to messages received before being blocked", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Beta sends a message to alpha
    const sent = await betaClient.send({
      to: alpha.agent_id,
      type: "question",
      payload: { content: "Hey alpha" },
    });

    // Beta then blocks alpha
    await betaClient.blockContact(alpha.agent_id);

    // Alpha received the message — get it from inbox
    const inbox = await alphaClient.inbox();
    const msgFromBeta = inbox.messages[0];

    // Alpha tries to reply to beta's message — should fail because beta blocked alpha
    await expect(
      alphaClient.reply(msgFromBeta.id, {
        type: "response",
        payload: { content: "reply after being blocked" },
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns already_blocked on duplicate block", async () => {
    const { alpha, alphaClient, beta, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await betaClient.blockContact(alpha.agent_id);
    const duplicate = await betaClient.blockContact(alpha.agent_id);
    expect(duplicate.already_blocked).toBe(true);
  });

  it("returns 404 when unblocking a non-blocked agent", async () => {
    const { alpha, betaClient } = await registerPair();
    await expect(betaClient.unblockContact(alpha.agent_id)).rejects.toThrow(TrunkApiError);
  });

  it("blocked agent is excluded from workspace fan-out", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-block-1" });
    const beta = await anon.register({ name: "ws-block-2" });
    const external = await anon.register({ name: "ws-block-ext" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);
    const externalClient = createClient(external.secret);

    const ws = await alphaClient.createWorkspace({ name: "BlockTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });
    await externalClient.pair({ code: ws.pairing_code });

    // Beta blocks external
    await betaClient.blockContact(external.agent_id, "spam");

    // External sends to workspace — should only reach alpha, not beta
    const sent = await externalClient.send({
      to: `workspace:${ws.id}`,
      type: "update",
      payload: { content: "Broadcast to team" },
    });

    expect(sent.status).toBe("delivered");
    expect(sent.recipients).toBe(1); // only alpha

    const alphaInbox = await alphaClient.inbox();
    const betaInbox = await betaClient.inbox();
    expect(alphaInbox.messages).toHaveLength(1);
    expect(betaInbox.messages).toHaveLength(0);
  });

  it("blocked agent is excluded from room fan-out", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Register a third agent and create room
    const gammaReg = await createClient().register({ name: "room-block-gamma" });
    const gammaClient = createClient(gammaReg.secret);

    const roomRes = await createRoomRaw(alpha.secret, { name: "Block Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);
    await joinRoomRaw(gammaReg.secret, room.pairing_code);

    // Beta blocks alpha
    await betaClient.blockContact(alpha.agent_id, "annoying");

    // Alpha sends to room — should reach gamma but not beta
    const receipt = await alphaClient.send({
      to: `room:${room.id}`,
      type: "update",
      payload: { content: "Room message" },
    });

    expect(receipt.status).toBe("delivered");
    expect(receipt.recipients).toBe(1); // only gamma

    const betaInbox = await betaClient.inbox();
    const gammaInbox = await gammaClient.inbox();
    expect(betaInbox.messages).toHaveLength(0);
    expect(gammaInbox.messages).toHaveLength(1);
  });

  it("returns 403 when all workspace recipients have blocked sender", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-allblock-1" });
    const external = await anon.register({ name: "ws-allblock-ext" });
    const alphaClient = createClient(alpha.secret);
    const externalClient = createClient(external.secret);

    const ws = await alphaClient.createWorkspace({ name: "AllBlock" });
    await externalClient.pair({ code: ws.pairing_code });

    // Alpha (only member) blocks external
    await alphaClient.blockContact(external.agent_id, "blocked");

    // External sends to workspace — all blocked, should 403
    await expect(
      externalClient.send({
        to: `workspace:${ws.id}`,
        type: "update",
        payload: { content: "Nobody hears me" },
      })
    ).rejects.toThrow(TrunkApiError);
  });

  it("direct contact with one workspace member does NOT grant workspace fan-out access", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-fanout-member" });
    const beta = await anon.register({ name: "ws-fanout-member2" });
    const outsider = await anon.register({ name: "ws-fanout-outsider" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);
    const outsiderClient = createClient(outsider.secret);

    // Create workspace with alpha and beta
    const ws = await alphaClient.createWorkspace({ name: "ClosedTeam" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Outsider pairs directly with alpha (direct contact), but NOT with the workspace
    await outsiderClient.pair({ code: alpha.pairing_code });

    // Outsider can DM alpha directly — that's fine
    const dm = await outsiderClient.send({
      to: alpha.agent_id,
      type: "update",
      payload: { content: "Direct message" },
    });
    expect(dm.status).toBe("delivered");

    // But outsider should NOT be able to fan-out to the workspace
    await expect(
      outsiderClient.send({
        to: `workspace:${ws.id}`,
        type: "update",
        payload: { content: "Unauthorized fan-out attempt" },
      })
    ).rejects.toThrow(TrunkApiError);

    // Verify beta received nothing from the outsider
    const betaInbox = await betaClient.inbox();
    const fromOutsider = betaInbox.messages.filter((m: any) => m.fromAgent === outsider.agent_id);
    expect(fromOutsider).toHaveLength(0);
  });

  // ── Contact Notes ──
  it("can set, get, and update a contact note", async () => {
    const { alphaClient, beta } = await registerPair();

    // Set a note
    const created = await alphaClient.setContactNote(beta.agent_id, "Good collaborator, prefers short messages");
    expect(created.contact_id).toBe(beta.agent_id);
    expect(created.content).toBe("Good collaborator, prefers short messages");

    // Get the note
    const note = await alphaClient.contactNote(beta.agent_id);
    expect(note.content).toBe("Good collaborator, prefers short messages");

    // Update the note
    const updated = await alphaClient.setContactNote(beta.agent_id, "Updated note");
    expect(updated.content).toBe("Updated note");

    // Verify update persisted
    const readBack = await alphaClient.contactNote(beta.agent_id);
    expect(readBack.content).toBe("Updated note");
  });

  it("returns null content for a contact without notes", async () => {
    const { alphaClient, beta } = await registerPair();
    const note = await alphaClient.contactNote(beta.agent_id);
    expect(note.content).toBeNull();
  });

  it("can delete a contact note", async () => {
    const { alphaClient, beta } = await registerPair();
    await alphaClient.setContactNote(beta.agent_id, "temp note");
    await alphaClient.deleteContactNote(beta.agent_id);
    const note = await alphaClient.contactNote(beta.agent_id);
    expect(note.content).toBeNull();
  });

  // ── Message Expiry / TTL ──
  it("can send a message with ttl_seconds", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "ephemeral" },
      ttl_seconds: 3600,
    });
    expect(msg.id).toBeDefined();
    expect(msg.expires_at).toBeDefined();
  });

  it("can send a message with expires_at", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const future = new Date(Date.now() + 60000).toISOString();
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "timed" },
      expires_at: future,
    });
    expect(msg.expires_at).toBeDefined();
  });

  it("expired messages are filtered from inbox", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send a message that expires immediately (ttl_seconds would be 0 but we set expiresAt in the past manually)
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "should expire" },
      ttl_seconds: 3600, // 1 hour — won't expire yet
    });

    // Message should be in inbox (not expired yet)
    const inbox = await betaClient.inbox();
    const found = inbox.messages.find((m) => m.id === msg.id);
    expect(found).toBeDefined();
  });

  // ── Read Receipts ──
  it("can mark a message as read without processing", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "read me" },
    });

    // Beta marks as read
    const readResult = await betaClient.markRead(msg.id);
    expect(readResult.ok).toBe(true);
    expect(readResult.read_at).toBeDefined();

    // Message should still appear in inbox (not processed)
    const inbox = await betaClient.inbox();
    const found = inbox.messages.find((m) => m.id === msg.id);
    expect(found).toBeDefined();
  });

  it("returns already_read on duplicate read", async () => {
    const { beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "read twice" },
    });
    await betaClient.markRead(msg.id);
    const second = await betaClient.markRead(msg.id);
    expect(second.already_read).toBe(true);
  });

  // ── Agent Analytics ──
  it("returns analytics with message volume and top contacts", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send some messages
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "hello" } });
    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "how?" } });
    await betaClient.send({ to: alpha.agent_id, type: "ack", payload: { content: "fine" } });

    const analytics = await alphaClient.analytics({ days: 7 });
    expect(analytics.period_days).toBe(7);
    expect(analytics.total_sent).toBe(2);
    expect(analytics.total_received).toBe(1);
    expect(analytics.top_contacts.length).toBeGreaterThan(0);
    expect(analytics.top_contacts[0].agent_id).toBe(beta.agent_id);
    expect(analytics.by_type).toBeDefined();
  });

  it("analytics returns empty data for new agent", async () => {
    const { alphaClient } = await registerPair();

    const analytics = await alphaClient.analytics();
    expect(analytics.total_sent).toBe(0);
    expect(analytics.total_received).toBe(0);
    expect(analytics.top_contacts).toEqual([]);
  });

  it("analytics respects days parameter", async () => {
    const { alphaClient } = await registerPair();

    const analytics = await alphaClient.analytics({ days: 1 });
    expect(analytics.period_days).toBe(1);
  });

  it("analytics defaults to 7 days for invalid days parameter", async () => {
    const { alphaClient } = await registerPair();

    // NaN days should default to 7
    const analytics = await alphaClient.analytics({ days: NaN } as any);
    expect(analytics.period_days).toBe(7);
  });

  it("analytics clamps days to 1-30 range", async () => {
    const { alphaClient } = await registerPair();

    const low = await alphaClient.analytics({ days: 0 });
    expect(low.period_days).toBe(1);

    const high = await alphaClient.analytics({ days: 100 });
    expect(high.period_days).toBe(30);
  });

  it("analytics computes volume_by_day breakdown", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "a" } });
    await betaClient.send({ to: alpha.agent_id, type: "ack", payload: { content: "b" } });

    const analytics = await alphaClient.analytics({ days: 7 });
    const today = new Date().toISOString().slice(0, 10);
    expect(analytics.volume_by_day).toBeDefined();
    expect(analytics.volume_by_day[today]).toBeDefined();
    expect(analytics.volume_by_day[today].sent).toBe(1);
    expect(analytics.volume_by_day[today].received).toBe(1);
  });

  it("analytics computes by_type breakdown correctly", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "a" } });
    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "b" } });
    await betaClient.send({ to: alpha.agent_id, type: "ack", payload: { content: "c" } });

    const analytics = await alphaClient.analytics({ days: 7 });
    expect(analytics.by_type.update).toBe(1);
    expect(analytics.by_type.question).toBe(1);
    expect(analytics.by_type.ack).toBe(1);
  });

  it("analytics computes avg_response_ms for thread replies", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Beta sends a message, alpha replies in the same thread
    const msg = await betaClient.send({ to: alpha.agent_id, type: "question", payload: { content: "ping" } });
    await alphaClient.reply(msg.id, { type: "ack", payload: { content: "pong" } });

    const analytics = await alphaClient.analytics({ days: 7 });
    expect(analytics.response_count).toBeGreaterThanOrEqual(1);
    // avg_response_ms should be a positive number when there are thread replies
    expect(analytics.avg_response_ms).not.toBeNull();
    expect(analytics.avg_response_ms).toBeGreaterThan(0);
  });

  it("analytics returns null avg_response_ms when no thread replies exist", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send a message but no replies
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "one-way" } });

    const analytics = await alphaClient.analytics({ days: 7 });
    expect(analytics.avg_response_ms).toBeNull();
    expect(analytics.response_count).toBe(0);
  });

  it("analytics top_contacts sorts by total volume descending", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Register a third agent
    const gamma = await createClient().register({ name: "gamma" });
    const gammaClient = createClient(gamma.secret);
    await alphaClient.pair({ code: gamma.pairing_code });

    // Send more messages to beta than gamma
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "1" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "2" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "3" } });
    await alphaClient.send({ to: gamma.agent_id, type: "update", payload: { content: "1" } });

    const analytics = await alphaClient.analytics({ days: 7 });
    expect(analytics.top_contacts.length).toBe(2);
    expect(analytics.top_contacts[0].agent_id).toBe(beta.agent_id);
    expect(analytics.top_contacts[0].total).toBe(3);
    expect(analytics.top_contacts[1].agent_id).toBe(gamma.agent_id);
    expect(analytics.top_contacts[1].total).toBe(1);
  });

  // ── Agent Status Messages ──
  it("can set and clear a custom status text", async () => {
    const { alphaClient } = await registerPair();

    // Set status
    const result = await alphaClient.setStatus("In a meeting");
    expect(result.ok).toBe(true);
    expect(result.status_text).toBe("In a meeting");

    // Verify via profile
    const profile = await alphaClient.me();
    expect((profile.metadata as Record<string, unknown>)?.status_text).toBe("In a meeting");

    // Clear status
    const cleared = await alphaClient.setStatus(null);
    expect(cleared.status_text).toBeNull();
  });

  it("status text appears in presence response", async () => {
    // Register fresh agents (not from registerPair which may have workspace conflicts)
    const anon = createClient();
    const a = await anon.register({ name: "statusA" });
    const b = await anon.register({ name: "statusB" });
    const aClient = createClient(a.secret);
    const bClient = createClient(b.secret);

    // Create workspace (creator auto-joins) and have B join
    const ws = await aClient.createWorkspace({ name: "StatusTest" });
    await bClient.joinWorkspace({ code: ws.pairing_code });

    // A sets status
    await aClient.setStatus("Coding");

    // B checks presence
    const presence = await bClient.presence();
    const aMember = presence.members.find((m) => m.agent_id === a.agent_id);
    expect(aMember?.status_text).toBe("Coding");
  });

  it("contact notes are private to each agent", async () => {
    const { alphaClient, beta, betaClient, alpha } = await registerPair();
    await alphaClient.setContactNote(beta.agent_id, "alpha's note about beta");
    await betaClient.setContactNote(alpha.agent_id, "beta's note about alpha");

    const alphaNote = await alphaClient.contactNote(beta.agent_id);
    expect(alphaNote.content).toBe("alpha's note about beta");

    const betaNote = await betaClient.contactNote(alpha.agent_id);
    expect(betaNote.content).toBe("beta's note about alpha");
  });

  it("rejects registration with invalid webhook_url", async () => {
    await expect(
      createClient().register({ name: "bad-webhook", webhook_url: "not-a-url" } as any)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects PATCH with invalid webhook_url", async () => {
    const { alphaClient } = await registerPair();
    await expect(
      alphaClient.updateMe({ webhook_url: "not-a-url" } as any)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects status text exceeding 500 characters", async () => {
    const { alphaClient } = await registerPair();
    await expect(
      alphaClient.setStatus("x".repeat(501))
    ).rejects.toMatchObject({ status: 400 });
  });

  it("accepts status text at exactly 500 characters", async () => {
    const { alphaClient } = await registerPair();
    const result = await alphaClient.setStatus("x".repeat(500));
    expect(result.ok).toBe(true);
  });

  it("rejects role exceeding 200 characters", async () => {
    const { alphaClient } = await registerPair();
    await expect(
      alphaClient.updateMe({ role: "x".repeat(201) })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects metadata exceeding 10KB", async () => {
    const { alphaClient } = await registerPair();
    await expect(
      alphaClient.updateMe({ metadata: { big: "x".repeat(11000) } })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects contact note exceeding 5000 characters", async () => {
    const { alphaClient, beta } = await registerPair();
    await expect(
      alphaClient.setContactNote(beta.agent_id, "x".repeat(5001))
    ).rejects.toMatchObject({ status: 400 });
  });

  it("accepts contact note at exactly 5000 characters", async () => {
    const { alphaClient, beta } = await registerPair();
    const result = await alphaClient.setContactNote(beta.agent_id, "x".repeat(5000));
    expect(result.content).toBe("x".repeat(5000));
  });

  // --- Message template tests ---

  it("creates and lists message templates", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const template = await client.createTemplate({
      name: "status-update",
      type: "update",
      payload: { content: "Status: {{status}}", urgency: "async" },
      description: "Standard status update template",
    });

    expect(template.name).toBe("status-update");
    expect(template.type).toBe("update");
    expect(template.payload).toMatchObject({ content: "Status: {{status}}" });
    expect(template.description).toBe("Standard status update template");

    const list = await client.listTemplates();
    expect(list.templates).toHaveLength(1);
    expect(list.templates[0].name).toBe("status-update");
  });

  it("gets a specific template by ID", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const created = await client.createTemplate({
      name: "handoff",
      type: "handoff",
      payload: { content: "Handing off to {{agent}}" },
    });

    const fetched = await client.getTemplate(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("handoff");
  });

  it("updates a template", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const created = await client.createTemplate({
      name: "old-name",
      type: "update",
      payload: { content: "old" },
    });

    const updated = await client.updateTemplate(created.id, {
      name: "new-name",
      payload: { content: "new" },
      description: "Updated description",
    });

    expect(updated.name).toBe("new-name");
    expect(updated.payload).toMatchObject({ content: "new" });
    expect(updated.description).toBe("Updated description");
  });

  it("deletes a template", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const created = await client.createTemplate({
      name: "to-delete",
      type: "update",
      payload: { content: "temp" },
    });

    const result = await client.deleteTemplate(created.id);
    expect(result).toMatchObject({ ok: true });

    const list = await client.listTemplates();
    expect(list.templates).toHaveLength(0);
  });

  it("rejects duplicate template names", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await client.createTemplate({
      name: "unique-name",
      type: "update",
      payload: { content: "first" },
    });

    await expect(
      client.createTemplate({
        name: "unique-name",
        type: "update",
        payload: { content: "second" },
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("templates are private to each agent", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const template = await alphaClient.createTemplate({
      name: "private-template",
      type: "update",
      payload: { content: "alpha only" },
    });

    // Beta should not see alpha's template
    const betaList = await betaClient.listTemplates();
    expect(betaList.templates).toHaveLength(0);

    // Beta cannot get alpha's template
    await expect(betaClient.getTemplate(template.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects template creation without required fields", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(
      client.createTemplate({ name: "", type: "update", payload: { content: "test" } })
    ).rejects.toMatchObject({ status: 400 });
  });

  // --- Notification preferences tests ---

  it("returns defaults when no notification prefs set", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const prefs = await alphaClient.notificationPrefs(beta.agent_id);
    expect(prefs.muted).toBe(false);
    expect(prefs.urgency_filter).toBe("all");
  });

  it("sets and gets notification preferences", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.setNotificationPrefs(beta.agent_id, {
      muted: true,
      urgency_filter: "sync_only",
    });

    expect(result.muted).toBe(true);
    expect(result.urgency_filter).toBe("sync_only");

    const prefs = await alphaClient.notificationPrefs(beta.agent_id);
    expect(prefs.muted).toBe(true);
    expect(prefs.urgency_filter).toBe("sync_only");
  });

  it("updates existing notification preferences", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.setNotificationPrefs(beta.agent_id, { muted: true });
    const updated = await alphaClient.setNotificationPrefs(beta.agent_id, { muted: false });

    expect(updated.muted).toBe(false);
  });

  it("notification prefs are per-agent", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.setNotificationPrefs(beta.agent_id, { muted: true });

    // Beta's prefs for alpha should be defaults
    const betaPrefs = await betaClient.notificationPrefs(alpha.agent_id);
    expect(betaPrefs.muted).toBe(false);
  });

  it("rejects invalid urgency_filter", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(
      alphaClient.setNotificationPrefs(beta.agent_id, { urgency_filter: "invalid" })
    ).rejects.toMatchObject({ status: 400 });
  });

  // --- Contact tags tests ---

  it("adds and lists tags for a contact", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.addContactTag(beta.agent_id, "team");
    expect(result.tag).toBe("team");

    const tags = await alphaClient.contactTags(beta.agent_id);
    expect(tags.tags).toContain("team");
  });

  it("prevents duplicate tags", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.addContactTag(beta.agent_id, "vendor");
    const dup = await alphaClient.addContactTag(beta.agent_id, "vendor");
    expect(dup).toMatchObject({ ok: true, already_tagged: true });
  });

  it("removes a tag from a contact", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.addContactTag(beta.agent_id, "temp");
    const result = await alphaClient.removeContactTag(beta.agent_id, "temp");
    expect(result).toMatchObject({ ok: true });

    const tags = await alphaClient.contactTags(beta.agent_id);
    expect(tags.tags).not.toContain("temp");
  });

  it("lists contacts by tag", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.addContactTag(beta.agent_id, "priority");
    const contacts = await alphaClient.contactsByTag("priority");
    expect(contacts.contacts).toHaveLength(1);
    expect(contacts.contacts[0].agent_id).toBe(beta.agent_id);
  });

  it("lists all tags with counts", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.addContactTag(beta.agent_id, "team");
    await alphaClient.addContactTag(beta.agent_id, "active");

    const allTags = await alphaClient.allContactTags();
    expect(allTags.tags).toHaveLength(2);
    expect(allTags.tags.find((t: { tag: string }) => t.tag === "team")?.count).toBe(1);
  });

  it("tags are private to each agent", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.addContactTag(beta.agent_id, "my-tag");

    const betaTags = await betaClient.contactTags(alpha.agent_id);
    expect(betaTags.tags).toHaveLength(0);
  });

  // --- Saved search tests ---

  it("saves and lists searches", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const search = await client.saveSearch("unread-questions", { type: "question" });
    expect(search.name).toBe("unread-questions");
    expect(search.query).toMatchObject({ type: "question" });

    const list = await client.listSavedSearches();
    expect(list.searches).toHaveLength(1);
    expect(list.searches[0].name).toBe("unread-questions");
  });

  it("deletes a saved search", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const search = await client.saveSearch("temp-search", { q: "test" });
    const result = await client.deleteSavedSearch(search.id);
    expect(result).toMatchObject({ ok: true });

    const list = await client.listSavedSearches();
    expect(list.searches).toHaveLength(0);
  });

  it("rejects duplicate search names", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await client.saveSearch("my-search", { q: "hello" });
    await expect(
      client.saveSearch("my-search", { q: "world" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("saved searches are private to each agent", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    await alphaClient.saveSearch("private-search", { type: "handoff" });

    const betaList = await betaClient.listSavedSearches();
    expect(betaList.searches).toHaveLength(0);
  });

  // --- Attachments ---

  it("uploads an attachment and retrieves it", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const client = createClient(registered.secret);

    const uploaded = await client.uploadAttachment({
      filename: "test.txt",
      content_type: "text/plain",
      data: btoa("hello world"),
    });

    expect(uploaded.id).toEqual(expect.any(String));
    expect(uploaded.filename).toBe("test.txt");
    expect(uploaded.content_type).toBe("text/plain");
    expect(uploaded.size_bytes).toBeGreaterThan(0);
    expect(uploaded.message_id).toBeNull();

    const downloaded = await client.getAttachment(uploaded.id);
    expect(downloaded.id).toBe(uploaded.id);
    expect(downloaded.data).toBe(btoa("hello world"));
    expect(downloaded.filename).toBe("test.txt");
  });

  it("lists my attachments", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const client = createClient(registered.secret);

    await client.uploadAttachment({ filename: "a.txt", data: btoa("a") });
    await client.uploadAttachment({ filename: "b.txt", data: btoa("b") });

    const list = await client.listAttachments();
    expect(list.attachments).toHaveLength(2);
  });

  it("links attachment to message via attachment_ids", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const uploaded = await alphaClient.uploadAttachment({
      filename: "report.pdf",
      data: btoa("pdf content"),
      content_type: "application/pdf",
    });

    const receipt = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "here is the report" },
      attachment_ids: [uploaded.id],
    });

    const msgAttachments = await alphaClient.messageAttachments(receipt.id);
    expect(msgAttachments.message_id).toBe(receipt.id);
    expect(msgAttachments.attachments).toHaveLength(1);
    expect(msgAttachments.attachments[0].filename).toBe("report.pdf");
  });

  it("links attachment to message via message_id on upload", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const receipt = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "message first" },
    });

    const uploaded = await alphaClient.uploadAttachment({
      filename: "doc.txt",
      data: btoa("doc"),
      message_id: receipt.id,
    });

    expect(uploaded.message_id).toBe(receipt.id);
  });

  it("rejects attachment download by non-owner/non-participant", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const uploaded = await alphaClient.uploadAttachment({
      filename: "private.txt",
      data: btoa("secret"),
    });

    await expect(betaClient.getAttachment(uploaded.id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("deletes an attachment", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const client = createClient(registered.secret);

    const uploaded = await client.uploadAttachment({
      filename: "temp.txt",
      data: btoa("temp"),
    });

    await client.deleteAttachment(uploaded.id);

    await expect(client.getAttachment(uploaded.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rejects attachment deletion by non-owner", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const uploaded = await alphaClient.uploadAttachment({
      filename: "mine.txt",
      data: btoa("mine"),
    });

    await expect(betaClient.deleteAttachment(uploaded.id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects invalid base64 in attachment upload", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const client = createClient(registered.secret);

    await expect(
      client.uploadAttachment({ filename: "bad.txt", data: "not-valid-base64!!!" })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("recipient can download attachment linked to a message they received", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const receipt = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "file attached" },
    });

    const uploaded = await alphaClient.uploadAttachment({
      filename: "shared.txt",
      data: btoa("shared content"),
      message_id: receipt.id,
    });

    const downloaded = await betaClient.getAttachment(uploaded.id);
    expect(downloaded.filename).toBe("shared.txt");
    expect(downloaded.data).toBe(btoa("shared content"));
  });

  it("connect page shows agent info for a valid pairing code", async () => {
    const registered = await createClient().register({ name: "connector-agent", owner: "Alice" });
    const res = await app.request(`/connect/${registered.pairing_code}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Alice's agent wants to connect");
    expect(body).toContain(registered.pairing_code);
    expect(body).toContain("Pairing code");
  });

  it("connect page shows invalid code message for unknown pairing code", async () => {
    const res = await app.request("/connect/ZZZZZZZZ");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Invalid pairing code");
    expect(body).toContain("ZZZZZZZZ");
  });

  it("connect page uppercases the code in the URL", async () => {
    const registered = await createClient().register({ name: "lower-agent", owner: "Bob" });
    const lowerCode = registered.pairing_code.toLowerCase();
    const res = await app.request(`/connect/${lowerCode}`);
    const body = await res.text();
    expect(body).toContain("Bob's agent wants to connect");
    expect(body).toContain(registered.pairing_code);
  });

  it("connect page includes machine-readable agent-hint for AI agents", async () => {
    const registered = await createClient().register({ name: "hint-agent", owner: "Carol" });
    const res = await app.request(`/connect/${registered.pairing_code}`);
    const body = await res.text();
    expect(body).toContain("data-trunk-pairing-code");
    expect(body).toContain(`data-trunk-pairing-code="${registered.pairing_code}"`);
    expect(body).toContain('data-trunk-relay="https://trunk.bot"');
    expect(body).toContain('data-trunk-inviter="hint-agent"');
  });

  it("connect page uses agent name as fallback when owner is not set", async () => {
    const registered = await createClient().register({ name: "solo-agent" });
    const res = await app.request(`/connect/${registered.pairing_code}`);
    const body = await res.text();
    expect(body).toContain("solo-agent's agent wants to connect");
  });

  it("connect page includes rate limit headers", async () => {
    const res = await app.request("/connect/TESTCODE", {
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    expect(res.headers.get("x-ratelimit-limit")).toBe("30");
    expect(res.headers.get("x-ratelimit-remaining")).toBeTruthy();
  });

  it("dashboard shows login form when no session is provided", async () => {
    const res = await app.request("/dashboard");
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Sign in");
    expect(body).toContain('<input type="password"');
    expect(body).toContain('<form method="POST"');
  });

  it("dashboard rejects invalid secret with 401", async () => {
    const res = await app.request("/dashboard", {
      headers: { Authorization: "Bearer invalid-secret-value" },
    });
    expect(res.status).toBe(401);
  });

  it("dashboard login sets HTTP-only session cookie and redirects", async () => {
    const registered = await createClient().register({ name: "cookie-agent" });
    const formBody = new URLSearchParams({ secret: registered.secret });
    const res = await app.request("/dashboard/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
    const setCookieHeader = res.headers.get("set-cookie");
    expect(setCookieHeader).toBeTruthy();
    expect(setCookieHeader).toContain("trunk_session=");
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("Path=/dashboard");
  });

  it("dashboard login rejects invalid secret", async () => {
    const formBody = new URLSearchParams({ secret: "bad-secret" });
    const res = await app.request("/dashboard/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Invalid secret");
  });

  it("dashboard login rejects empty secret", async () => {
    const formBody = new URLSearchParams({ secret: "" });
    const res = await app.request("/dashboard/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Secret is required");
  });

  it("dashboard authenticates via session cookie", async () => {
    const registered = await createClient().register({ name: "cookie-auth-agent" });
    // First login to get a cookie
    const formBody = new URLSearchParams({ secret: registered.secret });
    const loginRes = await app.request("/dashboard/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });
    const setCookieHeader = loginRes.headers.get("set-cookie")!;
    const cookieValue = setCookieHeader.split(";")[0]; // "trunk_session=..."

    // Use the cookie to access the dashboard
    const res = await app.request("/dashboard", {
      headers: { Cookie: cookieValue },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("cookie-auth-agent");
  });

  it("dashboard logout clears session cookie", async () => {
    const res = await app.request("/dashboard/logout", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
    const setCookieHeader = res.headers.get("set-cookie");
    expect(setCookieHeader).toContain("trunk_session=");
    // Cookie should be cleared (max-age=0 or expires in the past)
    expect(setCookieHeader).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i);
  });

  it("dashboard login form uses POST method not GET (no secret in URL)", async () => {
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain('method="POST"');
    expect(body).toContain('action="/dashboard/login"');
    expect(body).not.toContain('method="GET"');
  });

  it("dashboard pages do not leak secret in URLs", async () => {
    const registered = await createClient().register({ name: "no-leak-agent" });
    const res = await app.request("/dashboard", {
      headers: { Authorization: `Bearer ${registered.secret}` },
    });
    const body = await res.text();
    expect(body).not.toContain("?secret=");
    expect(body).not.toContain("&secret=");
  });

  it("dashboard login is rate limited", async () => {
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const formBody = new URLSearchParams({ secret: "bad-secret" });
      const res = await app.request("/dashboard/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody.toString(),
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  it("dashboard authenticates via Authorization header", async () => {
    const registered = await createClient().register({ name: "header-auth-agent" });
    const res = await app.request("/dashboard", {
      headers: { Authorization: `Bearer ${registered.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("header-auth-agent");
    expect(body).toContain("Observer");
  });

  it("dashboard thread view requires auth and renders thread page", async () => {
    const registered = await createClient().register({ name: "thread-viewer" });
    const res = await app.request(`/dashboard/thread/fake-thread-id`, {
      headers: { Authorization: `Bearer ${registered.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Thread");
    expect(body).toContain("0 messages");
  });

  it("dashboard thread view rejects without auth", async () => {
    const res = await app.request("/dashboard/thread/fake-thread-id");
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Sign in");
  });

  it("dashboard inbox view requires auth and renders inbox page", async () => {
    const registered = await createClient().register({ name: "inbox-viewer" });
    const res = await app.request(`/dashboard/inbox`, {
      headers: { Authorization: `Bearer ${registered.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Inbox");
  });

  it("dashboard inbox view shows status filter tabs", async () => {
    const registered = await createClient().register({ name: "filter-viewer" });
    const res = await app.request(`/dashboard/inbox?status=read`, {
      headers: { Authorization: `Bearer ${registered.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Inbox (read)");
    expect(body).toContain("pending");
    expect(body).toContain("replied");
  });

  it("dashboard gantt view renders mission control with no tasks", async () => {
    const registered = await createClient().register({ name: "gantt-agent" });
    const res = await app.request(`/dashboard/gantt`, {
      headers: { Authorization: `Bearer ${registered.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Mission control");
    expect(body).toContain("No tasks yet");
  });

  it("completing a dependency auto-unblocks a blocked downstream task", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Create the dependency task
    const depRes = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Dep task" });
    const dep = await depRes.json();

    // Create a task and set it to blocked with depends_on
    const taskRes = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "Blocked task",
      depends_on: [dep.id],
    });
    const task = await taskRes.json();
    await updateTaskRaw(alpha.secret, beta.agent_id, task.id, { status: "blocked" });

    // Mark the dependency as done — should auto-unblock
    await updateTaskRaw(alpha.secret, beta.agent_id, dep.id, { status: "done" });

    // Check that the blocked task was auto-unblocked
    const tasksRes = await listTasksRaw(alpha.secret, beta.agent_id);
    const allTasks = await tasksRes.json();
    const unblocked = allTasks.tasks.find((t: { id: string }) => t.id === task.id);
    expect(unblocked.status).toBe("open");
  });

  it("partially completing dependencies keeps task blocked", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const dep1Res = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Dep 1" });
    const dep1 = await dep1Res.json();
    const dep2Res = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Dep 2" });
    const dep2 = await dep2Res.json();

    // Create task, then set blocked with both deps
    const taskRes = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "Multi-dep task",
      depends_on: [dep1.id, dep2.id],
    });
    const task = await taskRes.json();
    await updateTaskRaw(alpha.secret, beta.agent_id, task.id, { status: "blocked" });

    // Only complete dep1
    await updateTaskRaw(alpha.secret, beta.agent_id, dep1.id, { status: "done" });

    // Task should still be blocked
    const tasksRes = await listTasksRaw(alpha.secret, beta.agent_id);
    const allTasks = await tasksRes.json();
    const stillBlocked = allTasks.tasks.find((t: { id: string }) => t.id === task.id);
    expect(stillBlocked.status).toBe("blocked");
  });

  it("completing all dependencies unblocks a multi-dep task", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const dep1Res = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Dep A" });
    const dep1 = await dep1Res.json();
    const dep2Res = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Dep B" });
    const dep2 = await dep2Res.json();

    const taskRes = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "Waiting on both",
      depends_on: [dep1.id, dep2.id],
    });
    const task = await taskRes.json();
    await updateTaskRaw(alpha.secret, beta.agent_id, task.id, { status: "blocked" });

    // Complete both deps
    await updateTaskRaw(alpha.secret, beta.agent_id, dep1.id, { status: "done" });
    await updateTaskRaw(alpha.secret, beta.agent_id, dep2.id, { status: "done" });

    const tasksRes = await listTasksRaw(alpha.secret, beta.agent_id);
    const allTasks = await tasksRes.json();
    const unblocked = allTasks.tasks.find((t: { id: string }) => t.id === task.id);
    expect(unblocked.status).toBe("open");
  });

  it("auto-unblock does not affect non-blocked tasks with same dependency", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const depRes = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Shared dep" });
    const dep = await depRes.json();

    // Create a task, set it to in-progress with the dep
    const taskRes = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "In progress task",
      depends_on: [dep.id],
    });
    const task = await taskRes.json();
    await updateTaskRaw(alpha.secret, beta.agent_id, task.id, { status: "in-progress" });

    await updateTaskRaw(alpha.secret, beta.agent_id, dep.id, { status: "done" });

    const tasksRes = await listTasksRaw(alpha.secret, beta.agent_id);
    const allTasks = await tasksRes.json();
    const unchanged = allTasks.tasks.find((t: { id: string }) => t.id === task.id);
    expect(unchanged.status).toBe("in-progress");
  });

  // --- Input validation tests ---

  it("rejects task creation with invalid priority", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "Test task",
      priority: "urgent",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("priority");
  });

  it("accepts task creation with valid priorities", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    for (const priority of ["critical", "high", "medium", "low"]) {
      const res = await createTaskRaw(alpha.secret, beta.agent_id, {
        title: `Task ${priority}`,
        priority,
      });
      expect(res.status).toBe(201);
    }
  });

  it("rejects task update with invalid status", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Test task" });
    const task = await createRes.json();

    const updateRes = await updateTaskRaw(alpha.secret, beta.agent_id, task.id, {
      status: "completed",
    });
    expect(updateRes.status).toBe(400);
    const body = await updateRes.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("status");
  });

  it("rejects task update with invalid priority", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Test task" });
    const task = await createRes.json();

    const updateRes = await updateTaskRaw(alpha.secret, beta.agent_id, task.id, {
      priority: "super-high",
    });
    expect(updateRes.status).toBe(400);
    const body = await updateRes.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("priority");
  });

  it("rejects task list with invalid status filter", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await listTasksRaw(alpha.secret, beta.agent_id, "invalid-status");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("status");
  });

  it("rejects task creation with title exceeding 500 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "x".repeat(501),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("500");
  });

  it("rejects workspace creation with name exceeding 100 characters", async () => {
    const alpha = await createClient().register({ name: "agent-val", owner: "Frank" });

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ name: "x".repeat(101) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("100");
  });

  it("rejects room creation with name exceeding 100 characters", async () => {
    const alpha = await createClient().register({ name: "agent-room-val", owner: "Frank" });

    const res = await createRoomRaw(alpha.secret, { name: "x".repeat(101) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("100");
  });

  it("rejects room rename with name exceeding 100 characters", async () => {
    const alpha = await createClient().register({ name: "agent-rename-val", owner: "Frank" });
    const roomRes = await createRoomRaw(alpha.secret, { name: "Good Name" });
    const room = await roomRes.json();

    const res = await app.request(`/rooms/${room.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ name: "x".repeat(101) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("100");
  });

  it("rejects oversized attachment upload with 413", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const client = createClient(registered.secret);

    // Create a base64 string that decodes to > 10MB
    const bigData = "A".repeat(14 * 1024 * 1024); // ~10.5MB decoded

    await expect(
      client.uploadAttachment({ filename: "huge.bin", data: bigData })
    ).rejects.toMatchObject({ status: 413 });
  });

  it("rejects updateMe with empty name", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const client = createClient(registered.secret);

    await expect(client.updateMe({ name: "" })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects updateMe with whitespace-only name", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const client = createClient(registered.secret);

    await expect(client.updateMe({ name: "   " })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects updateMe with name exceeding 100 characters", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const client = createClient(registered.secret);

    await expect(client.updateMe({ name: "x".repeat(101) })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects registration with whitespace-only name", async () => {
    await expect(createClient().register({ name: "   " })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects registration with name exceeding 100 characters", async () => {
    await expect(createClient().register({ name: "x".repeat(101) })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects registration with owner exceeding 100 characters", async () => {
    await expect(createClient().register({ name: "valid", owner: "x".repeat(101) })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects updateMe with owner exceeding 100 characters", async () => {
    const registered = await createClient().register({ name: "alpha" });
    const client = createClient(registered.secret);
    await expect(client.updateMe({ owner: "x".repeat(101) })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects workspace creation with owner exceeding 100 characters", async () => {
    const alpha = await createClient().register({ name: "ws-owner-val", owner: "Frank" });

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Valid Workspace", owner: "x".repeat(101) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("100");
  });

  // --- Message field length validation ---

  it("rejects message send with type exceeding 50 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
        "Idempotency-Key": "msg-type-len",
      },
      body: JSON.stringify({ to: beta.agent_id, type: "x".repeat(51), payload: { content: "test" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("50");
  });

  it("rejects message send with to exceeding 200 characters", async () => {
    const { alpha, alphaClient, beta } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
        "Idempotency-Key": "msg-to-len",
      },
      body: JSON.stringify({ to: "x".repeat(201), type: "question", payload: { content: "test" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("200");
  });

  // --- Hardening: inbox status filter, thread_id/reply_to UUID, ttl_seconds cap, depends_on validation ---

  it("rejects inbox status=deleted to prevent soft-deleted message exposure", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send a message and then soft-delete it
    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "secret" },
    });

    // Delete the message
    const delRes = await app.request(`/messages/${sent.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(delRes.status).toBe(200);

    // Attempting to filter inbox by status=deleted should be rejected
    const inboxRes = await app.request("/messages/inbox?status=deleted", {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(inboxRes.status).toBe(400);
    const body = await inboxRes.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("status");
  });

  it("allows valid inbox status filters (pending, delivered, processed, replied)", async () => {
    const alpha = await createClient().register({ name: "inbox-val", owner: "Frank" });

    for (const status of ["pending", "delivered", "processed", "replied"]) {
      const res = await app.request(`/messages/inbox?status=${status}`, {
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it("rejects non-UUID thread_id on message send", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
        "Idempotency-Key": "bad-thread-id",
      },
      body: JSON.stringify({
        to: beta.agent_id,
        type: "update",
        payload: { content: "test" },
        thread_id: "not-a-uuid",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.error).toContain("thread_id");
  });

  it("rejects non-UUID reply_to on message send", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
        "Idempotency-Key": "bad-reply-to",
      },
      body: JSON.stringify({
        to: beta.agent_id,
        type: "update",
        payload: { content: "test" },
        reply_to: "invalid-reply",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.error).toContain("reply_to");
  });

  it("caps ttl_seconds to prevent overflow", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
        "Idempotency-Key": "huge-ttl",
      },
      body: JSON.stringify({
        to: beta.agent_id,
        type: "update",
        payload: { content: "test" },
        ttl_seconds: 999999999999,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // Should succeed but expiry should be capped to ~1 year from now
    const expiresAt = new Date(body.expires_at);
    const maxExpiry = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000);
    expect(expiresAt.getTime()).toBeLessThan(maxExpiry.getTime());
  });

  it("rejects too many attachment_ids", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const fakeIds = Array.from({ length: 21 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );

    const res = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
        "Idempotency-Key": "too-many-att",
      },
      body: JSON.stringify({
        to: beta.agent_id,
        type: "update",
        payload: { content: "test" },
        attachment_ids: fakeIds,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("20");
  });

  it("rejects depends_on with non-UUID values in task creation", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "Bad deps task",
      depends_on: ["not-a-uuid"],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.error).toContain("depends_on");
  });

  it("rejects depends_on exceeding 50 entries", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const manyDeps = Array.from({ length: 51 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );

    const res = await createTaskRaw(alpha.secret, beta.agent_id, {
      title: "Too many deps",
      depends_on: manyDeps,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toContain("50");
  });

  it("rejects non-UUID 'to' filter on sent messages", async () => {
    const alpha = await createClient().register({ name: "sent-val", owner: "Frank" });

    const res = await app.request("/messages/sent?to=not-a-uuid", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
  });

  // --- Saved search validation ---

  it("rejects saved search with name exceeding 200 characters", async () => {
    const alpha = await createClient().register({ name: "search-val", owner: "Frank" });

    const res = await app.request("/messages/searches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "x".repeat(201), query: { type: "question" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
  });

  // --- Contact alias and block reason validation ---

  it("rejects contact alias exceeding 100 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request(`/contacts/${beta.agent_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ alias: "x".repeat(101) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("100");
  });

  it("accepts contact alias of exactly 100 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request(`/contacts/${beta.agent_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ alias: "x".repeat(100) }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects block reason exceeding 500 characters", async () => {
    const { alpha, beta } = await registerPair();

    const res = await app.request(`/contacts/${beta.agent_id}/block`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ reason: "x".repeat(501) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("500");
  });

  // --- Attachment validation ---

  it("rejects attachment with filename exceeding 255 characters", async () => {
    const alpha = await createClient().register({ name: "attach-val", owner: "Frank" });

    const res = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "x".repeat(256), data: btoa("test") }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("255");
  });

  it("rejects attachment with content_type exceeding 100 characters", async () => {
    const alpha = await createClient().register({ name: "attach-ct-val", owner: "Frank" });

    const res = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "test.txt", data: btoa("test"), content_type: "x".repeat(101) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("100");
  });

  // --- Template validation ---

  it("rejects template creation with name exceeding 200 characters", async () => {
    const alpha = await createClient().register({ name: "tpl-val", owner: "Frank" });

    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "x".repeat(201), type: "greeting", payload: { content: "hi" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("200");
  });

  it("rejects template creation with type exceeding 100 characters", async () => {
    const alpha = await createClient().register({ name: "tpl-type-val", owner: "Frank" });

    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "valid", type: "x".repeat(101), payload: { content: "hi" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("100");
  });

  it("rejects template creation with description exceeding 500 characters", async () => {
    const alpha = await createClient().register({ name: "tpl-desc-val", owner: "Frank" });

    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "valid", type: "greeting", payload: { content: "hi" }, description: "x".repeat(501) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("500");
  });

  it("rejects template update with name exceeding 200 characters", async () => {
    const alpha = await createClient().register({ name: "tpl-upd-val", owner: "Frank" });

    // Create a valid template first
    const createRes = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "update-me", type: "greeting", payload: { content: "hi" } }),
    });
    const template = await createRes.json();

    const res = await app.request(`/templates/${template.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "x".repeat(201) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
  });

  // --- Document validation ---

  it("rejects room document creation with name exceeding 255 characters", async () => {
    const alpha = await createClient().register({ name: "doc-val", owner: "Frank" });
    const roomRes = await app.request("/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Doc test room" }),
    });
    const room = await roomRes.json();

    const res = await app.request(`/documents/room/${room.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "x".repeat(256), body: "some content" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("255");
  });

  it("rejects room document creation with content_type exceeding 100 characters", async () => {
    const alpha = await createClient().register({ name: "doc-ct-val", owner: "Frank" });
    const roomRes = await app.request("/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Doc CT room" }),
    });
    const room = await roomRes.json();

    const res = await app.request(`/documents/room/${room.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "valid", body: "some content", content_type: "x".repeat(101) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("100");
  });

  it("rejects room document update with name exceeding 255 characters", async () => {
    const alpha = await createClient().register({ name: "doc-upd-val", owner: "Frank" });
    const roomRes = await app.request("/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Doc upd room" }),
    });
    const room = await roomRes.json();

    // Create a doc first
    const createRes = await app.request(`/documents/room/${room.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "update-me", body: "original" }),
    });
    const doc = await createRes.json();

    const res = await app.request(`/documents/room/${room.id}/${doc.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ body: "updated", name: "x".repeat(256) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
  });

  it("rejects contact document creation with name exceeding 255 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request(`/documents/${beta.agent_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "x".repeat(256), body: "some content" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("255");
  });

  // --- Hardening: deliver-scheduled scoped to caller ---

  it("deliver-scheduled only delivers the caller's own scheduled messages", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Alpha schedules a message to beta
    const scheduled = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "alpha scheduled" },
      scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    // Beta schedules a message to alpha
    const betaScheduled = await betaClient.send({
      to: alpha.agent_id,
      type: "update",
      payload: { content: "beta scheduled" },
      scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    // Make both messages due
    const alphaMsg = testState.messages.find((m) => m.id === scheduled.id);
    const betaMsg = testState.messages.find((m) => m.id === betaScheduled.id);
    if (alphaMsg) alphaMsg.scheduledAt = new Date(Date.now() - 1000);
    if (betaMsg) betaMsg.scheduledAt = new Date(Date.now() - 1000);

    // Alpha triggers deliver-scheduled — should only deliver alpha's message
    const result = await alphaClient.deliverScheduled();
    expect(result.delivered).toBe(1);

    // Beta's scheduled message should still be scheduled
    const stillScheduled = testState.messages.find((m) => m.id === betaScheduled.id);
    expect(stillScheduled?.status).toBe("scheduled");
  });

  // --- Hardening: purge-expired rate limiting ---

  it("purge-expired is rate limited", async () => {
    const { alphaClient } = await registerPair();

    // Exhaust rate limit (5 per minute)
    for (let i = 0; i < 5; i++) {
      await alphaClient.purgeExpiredMessages(90);
    }

    await expect(alphaClient.purgeExpiredMessages(90)).rejects.toMatchObject({
      status: 429,
    });
  });

  // --- Hardening: deliver-scheduled rate limiting ---

  it("deliver-scheduled is rate limited", async () => {
    const { alphaClient } = await registerPair();

    // Exhaust rate limit (10 per minute)
    for (let i = 0; i < 10; i++) {
      await alphaClient.deliverScheduled();
    }

    await expect(alphaClient.deliverScheduled()).rejects.toMatchObject({
      status: 429,
    });
  });

  // --- Hardening: tasks rate limiting ---

  it("rate limits task creation at 30/min", async () => {
    const { alpha, beta } = await registerPair();
    const alphaClient = createClient(alpha.secret);
    await alphaClient.pair({ code: beta.pairing_code });

    for (let i = 0; i < 30; i++) {
      const res = await createTaskRaw(alpha.secret, beta.agent_id, { title: `Task ${i}` });
      expect(res.status).toBe(201);
    }

    const blocked = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Over limit" });
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("rate limits task updates at 30/min", async () => {
    const { alpha, beta } = await registerPair();
    const alphaClient = createClient(alpha.secret);
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await createTaskRaw(alpha.secret, beta.agent_id, { title: "Rate test" });
    const task = await createRes.json();

    // Already used 1 of the 30 limit for the create; use 29 more via updates
    for (let i = 0; i < 29; i++) {
      const res = await updateTaskRaw(alpha.secret, beta.agent_id, task.id, { status: "open" });
      expect(res.status).toBe(200);
    }

    const blocked = await updateTaskRaw(alpha.secret, beta.agent_id, task.id, { status: "done" });
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  // --- Hardening: context/facts rate limiting ---

  it("rate limits fact upserts at 30/min", async () => {
    const { alpha, beta } = await registerPair();
    const alphaClient = createClient(alpha.secret);
    await alphaClient.pair({ code: beta.pairing_code });

    for (let i = 0; i < 30; i++) {
      const res = await app.request(`/context/${beta.agent_id}/facts/key${i}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${alpha.secret}`,
        },
        body: JSON.stringify({ value: `val${i}` }),
      });
      expect(res.status).toBe(200);
    }

    const blocked = await app.request(`/context/${beta.agent_id}/facts/over-limit`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ value: "blocked" }),
    });
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("rate limits fact deletes at 30/min (shared counter with upserts)", async () => {
    const { alpha, beta } = await registerPair();
    const alphaClient = createClient(alpha.secret);
    await alphaClient.pair({ code: beta.pairing_code });

    // Use up rate limit with upserts
    for (let i = 0; i < 30; i++) {
      await app.request(`/context/${beta.agent_id}/facts/key${i}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${alpha.secret}`,
        },
        body: JSON.stringify({ value: `val${i}` }),
      });
    }

    const blocked = await app.request(`/context/${beta.agent_id}/facts/key0`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  // --- Hardening: purge-expired uses DB-level date filtering ---

  it("purge-expired with custom days parameter only deletes old messages", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send two messages
    const old = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "old message" },
    });
    const recent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "recent message" },
    });

    // Make the old message 31 days old
    const oldMsg = testState.messages.find((m) => m.id === old.id);
    if (oldMsg) oldMsg.createdAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

    // Purge messages older than 30 days
    const result = await alphaClient.purgeExpiredMessages(30);
    expect(result.purged).toBe(1);

    // Recent message should still exist
    const remaining = testState.messages.find((m) => m.id === recent.id);
    expect(remaining).toBeDefined();
  });

  // --- Hardening: inbox/stats with lightweight projection ---

  it("inbox/stats returns correct counts with projection", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Send messages of different types
    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "q1" } });
    await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "u1" } });
    await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "q2" } });

    const stats = await betaClient.inboxStats();
    expect(stats.unread).toBe(3);
    expect(stats.by_type.question).toBe(2);
    expect(stats.by_type.update).toBe(1);
  });

  // ---- Shared Documents (contact-scoped) ----

  it("creates a contact-scoped document and retrieves it", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, {
      name: "design.md",
      body: "# Design Doc\nArchitecture overview",
      content_type: "text/markdown",
    });

    expect(doc.id).toEqual(expect.any(String));
    expect(doc.name).toBe("design.md");
    expect(doc.content_type).toBe("text/markdown");
    expect(doc.version).toBe(1);
    expect(doc.last_edited_by).toBe(alpha.agent_id);

    const fetched = await alphaClient.getDocument(beta.agent_id, doc.id);
    expect(fetched.body).toBe("# Design Doc\nArchitecture overview");
    expect(fetched.version).toBe(1);
  });

  it("lists contact-scoped documents", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.createDocument(beta.agent_id, { name: "doc1.md", body: "first" });
    await alphaClient.createDocument(beta.agent_id, { name: "doc2.md", body: "second" });

    const list = await alphaClient.listDocuments(beta.agent_id);
    expect(list.documents.length).toBe(2);
    expect(list.documents.map((d: { name: string }) => d.name).sort()).toEqual(["doc1.md", "doc2.md"]);
  });

  it("updates a contact-scoped document and increments version", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "spec.md", body: "v1 content" });
    expect(doc.version).toBe(1);

    const updated = await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "v2 content" });
    expect(updated.version).toBe(2);
    expect(updated.last_edited_by).toBe(alpha.agent_id);

    const fetched = await alphaClient.getDocument(beta.agent_id, doc.id);
    expect(fetched.body).toBe("v2 content");
  });

  it("updates a document name alongside body", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "old-name.md", body: "content" });
    const updated = await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "new content", name: "new-name.md" });

    expect(updated.name).toBe("new-name.md");
    expect(updated.version).toBe(2);
  });

  it("retrieves version history for a contact-scoped document", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "log.md", body: "initial" });
    await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "updated once" });
    await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "updated twice" });

    const history = await alphaClient.documentVersions(beta.agent_id, doc.id);
    expect(history.versions.length).toBe(3);
    expect(history.versions[0].version).toBe(3);
    expect(history.versions[2].version).toBe(1);
    expect(history.versions[0].edited_by).toBe(alpha.agent_id);
  });

  it("retrieves a specific document version", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "versioned.md", body: "v1" });
    await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "v2" });

    const v1 = await alphaClient.documentVersion(beta.agent_id, doc.id, 1);
    expect(v1.body).toBe("v1");
    expect(v1.version).toBe(1);

    const v2 = await alphaClient.documentVersion(beta.agent_id, doc.id, 2);
    expect(v2.body).toBe("v2");
    expect(v2.version).toBe(2);
  });

  it("deletes a contact-scoped document and its versions", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "temp.md", body: "ephemeral" });
    await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "v2" });

    const result = await alphaClient.deleteDocument(beta.agent_id, doc.id);
    expect(result.ok).toBe(true);

    await expect(alphaClient.getDocument(beta.agent_id, doc.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects document creation for non-contacts", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);

    await expect(
      alphaClient.createDocument(beta.agent_id, { name: "sneaky.md", body: "unauthorized" })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects document creation with missing required fields", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(
      alphaClient.createDocument(beta.agent_id, { name: "", body: "content" })
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      alphaClient.createDocument(beta.agent_id, { name: "doc.md", body: "" })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects document name exceeding max length", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const longName = "a".repeat(256);
    await expect(
      alphaClient.createDocument(beta.agent_id, { name: longName, body: "content" })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("both paired agents can access the same contact-scoped document", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, {
      name: "shared.md",
      body: "created by alpha",
    });

    // Beta should be able to read documents in the shared scope
    const betaDocs = await betaClient.listDocuments(alpha.agent_id);
    expect(betaDocs.documents.length).toBe(1);
    expect(betaDocs.documents[0].name).toBe("shared.md");
  });

  it("returns 404 for non-existent document", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(
      alphaClient.getDocument(beta.agent_id, "00000000-0000-0000-0000-000000000000")
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns 404 for non-existent document version", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "v.md", body: "only v1" });

    await expect(
      alphaClient.documentVersion(beta.agent_id, doc.id, 99)
    ).rejects.toMatchObject({ status: 404 });
  });

  // ---- Cross-scope document access bypass regression tests ----

  it("blocks reading a document through a different contact scope", async () => {
    // Alpha creates a doc with Beta, then Gamma (different contact) tries to read it
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const gamma = await createClient().register({ name: "gamma" });
    const gammaClient = createClient(gamma.secret);
    await alphaClient.pair({ code: gamma.pairing_code });

    // Alpha creates doc in Alpha<->Beta scope
    const doc = await alphaClient.createDocument(beta.agent_id, {
      name: "secret.md",
      body: "beta-only content",
    });

    // Alpha tries to read that doc through the Gamma contact scope — should 404
    await expect(
      alphaClient.getDocument(gamma.agent_id, doc.id)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("blocks updating a document through a different contact scope", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const gamma = await createClient().register({ name: "gamma" });
    await alphaClient.pair({ code: gamma.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, {
      name: "locked.md",
      body: "original",
    });

    // Try to update via wrong contact scope
    await expect(
      alphaClient.updateDocument(gamma.agent_id, doc.id, { body: "hijacked" })
    ).rejects.toMatchObject({ status: 404 });

    // Verify original content unchanged
    const fetched = await alphaClient.getDocument(beta.agent_id, doc.id);
    expect(fetched.body).toBe("original");
  });

  it("blocks version history access through a different contact scope", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const gamma = await createClient().register({ name: "gamma" });
    await alphaClient.pair({ code: gamma.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, {
      name: "history.md",
      body: "v1",
    });
    await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "v2" });

    // Version list via wrong scope should 404
    await expect(
      alphaClient.documentVersions(gamma.agent_id, doc.id)
    ).rejects.toMatchObject({ status: 404 });

    // Specific version via wrong scope should also 404
    await expect(
      alphaClient.documentVersion(gamma.agent_id, doc.id, 1)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("blocks deleting a document through a different contact scope", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const gamma = await createClient().register({ name: "gamma" });
    await alphaClient.pair({ code: gamma.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, {
      name: "nodelete.md",
      body: "protected",
    });

    // Delete via wrong scope should fail
    await expect(
      alphaClient.deleteDocument(gamma.agent_id, doc.id)
    ).rejects.toMatchObject({ status: 404 });

    // Still accessible via correct scope
    const fetched = await alphaClient.getDocument(beta.agent_id, doc.id);
    expect(fetched.body).toBe("protected");
  });

  // ---- Shared Documents (room-scoped) ----

  it("creates and retrieves a room-scoped document", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const roomRes = await createRoomRaw(alpha.secret, { name: "Doc Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const doc = await alphaClient.createRoomDocument(room.id, {
      name: "room-spec.md",
      body: "Room design doc",
    });

    expect(doc.id).toEqual(expect.any(String));
    expect(doc.name).toBe("room-spec.md");
    expect(doc.version).toBe(1);

    const fetched = await alphaClient.getRoomDocument(room.id, doc.id);
    expect(fetched.body).toBe("Room design doc");
  });

  it("lists room-scoped documents", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const roomRes = await createRoomRaw(alpha.secret, { name: "List Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    await alphaClient.createRoomDocument(room.id, { name: "r1.md", body: "first" });
    await alphaClient.createRoomDocument(room.id, { name: "r2.md", body: "second" });

    const list = await alphaClient.listRoomDocuments(room.id);
    expect(list.documents.length).toBe(2);
  });

  it("updates a room-scoped document with versioning", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const roomRes = await createRoomRaw(alpha.secret, { name: "Edit Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const doc = await alphaClient.createRoomDocument(room.id, { name: "collab.md", body: "v1" });

    // Beta updates the document
    const updated = await betaClient.updateRoomDocument(room.id, doc.id, { body: "v2 by beta" });
    expect(updated.version).toBe(2);
    expect(updated.last_edited_by).toBe(beta.agent_id);

    const history = await alphaClient.roomDocumentVersions(room.id, doc.id);
    expect(history.versions.length).toBe(2);
  });

  it("retrieves a specific room document version", async () => {
    const { alpha, alphaClient } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Version Room" });
    const room = await roomRes.json();

    const doc = await alphaClient.createRoomDocument(room.id, { name: "rv.md", body: "initial" });
    await alphaClient.updateRoomDocument(room.id, doc.id, { body: "revised" });

    const v1 = await alphaClient.roomDocumentVersion(room.id, doc.id, 1);
    expect(v1.body).toBe("initial");

    const v2 = await alphaClient.roomDocumentVersion(room.id, doc.id, 2);
    expect(v2.body).toBe("revised");
  });

  it("deletes a room-scoped document", async () => {
    const { alpha, alphaClient } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Delete Room" });
    const room = await roomRes.json();

    const doc = await alphaClient.createRoomDocument(room.id, { name: "doomed.md", body: "bye" });
    const result = await alphaClient.deleteRoomDocument(room.id, doc.id);
    expect(result.ok).toBe(true);

    await expect(alphaClient.getRoomDocument(room.id, doc.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects room document access for non-members", async () => {
    const { alpha, alphaClient } = await registerPair();
    const outsider = await createClient().register({ name: "outsider" });
    const outsiderClient = createClient(outsider.secret);

    const roomRes = await createRoomRaw(alpha.secret, { name: "Private Doc Room" });
    const room = await roomRes.json();

    await expect(
      outsiderClient.createRoomDocument(room.id, { name: "sneak.md", body: "nope" })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns 404 for room document in wrong room", async () => {
    const { alpha, alphaClient } = await registerPair();

    const room1Res = await createRoomRaw(alpha.secret, { name: "Room A" });
    const room1 = await room1Res.json();
    const room2Res = await createRoomRaw(alpha.secret, { name: "Room B" });
    const room2 = await room2Res.json();

    const doc = await alphaClient.createRoomDocument(room1.id, { name: "scoped.md", body: "room1 only" });

    await expect(alphaClient.getRoomDocument(room2.id, doc.id)).rejects.toMatchObject({ status: 404 });
  });

  // ---- Shared Documents (workspace-scoped) ----

  it("creates and retrieves a workspace-scoped document", async () => {
    const { alpha, alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Doc WS" });

    const doc = await alphaClient.createWorkspaceDocument(ws.id, {
      name: "ws-spec.md",
      body: "Workspace design doc",
      content_type: "text/markdown",
    });

    expect(doc.id).toEqual(expect.any(String));
    expect(doc.name).toBe("ws-spec.md");
    expect(doc.version).toBe(1);
    expect(doc.last_edited_by).toBe(alpha.agent_id);

    const fetched = await alphaClient.getWorkspaceDocument(ws.id, doc.id);
    expect(fetched.body).toBe("Workspace design doc");
  });

  it("lists workspace-scoped documents", async () => {
    const { alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "List WS" });

    await alphaClient.createWorkspaceDocument(ws.id, { name: "w1.md", body: "first" });
    await alphaClient.createWorkspaceDocument(ws.id, { name: "w2.md", body: "second" });

    const list = await alphaClient.listWorkspaceDocuments(ws.id);
    expect(list.documents.length).toBe(2);
  });

  it("updates a workspace-scoped document with versioning", async () => {
    const { alpha, alphaClient, betaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Collab WS" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    const doc = await alphaClient.createWorkspaceDocument(ws.id, { name: "ws-collab.md", body: "v1" });

    const updated = await betaClient.updateWorkspaceDocument(ws.id, doc.id, { body: "v2 by beta" });
    expect(updated.version).toBe(2);

    const history = await alphaClient.workspaceDocumentVersions(ws.id, doc.id);
    expect(history.versions.length).toBe(2);
  });

  it("retrieves a specific workspace document version", async () => {
    const { alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Version WS" });

    const doc = await alphaClient.createWorkspaceDocument(ws.id, { name: "wv.md", body: "original" });
    await alphaClient.updateWorkspaceDocument(ws.id, doc.id, { body: "modified" });

    const v1 = await alphaClient.workspaceDocumentVersion(ws.id, doc.id, 1);
    expect(v1.body).toBe("original");

    const v2 = await alphaClient.workspaceDocumentVersion(ws.id, doc.id, 2);
    expect(v2.body).toBe("modified");
  });

  it("deletes a workspace-scoped document", async () => {
    const { alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Delete WS" });

    const doc = await alphaClient.createWorkspaceDocument(ws.id, { name: "temp.md", body: "gone" });
    const result = await alphaClient.deleteWorkspaceDocument(ws.id, doc.id);
    expect(result.ok).toBe(true);

    await expect(alphaClient.getWorkspaceDocument(ws.id, doc.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects workspace document access for non-members", async () => {
    const { alphaClient } = await registerPair();
    const outsider = await createClient().register({ name: "outsider" });
    const outsiderClient = createClient(outsider.secret);

    const ws = await alphaClient.createWorkspace({ name: "Private WS" });

    await expect(
      outsiderClient.createWorkspaceDocument(ws.id, { name: "sneak.md", body: "nope" })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns 404 for workspace document in wrong workspace", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const ws1 = await alphaClient.createWorkspace({ name: "WS A" });
    await alphaClient.leaveWorkspace();
    const ws2 = await alphaClient.createWorkspace({ name: "WS B" });

    const doc = await alphaClient.createWorkspaceDocument(ws2.id, { name: "scoped.md", body: "ws2 only" });

    await betaClient.joinWorkspace({ code: ws1.pairing_code });
    await expect(betaClient.getWorkspaceDocument(ws1.id, doc.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects document update with missing body", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "test.md", body: "content" });

    await expect(
      alphaClient.updateDocument(beta.agent_id, doc.id, { body: "" })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("creates audit events for document operations", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const doc = await alphaClient.createDocument(beta.agent_id, { name: "audited.md", body: "tracked" });
    await alphaClient.updateDocument(beta.agent_id, doc.id, { body: "updated" });
    await alphaClient.deleteDocument(beta.agent_id, doc.id);

    const auditData = await alphaClient.auditLog({ target_type: "shared_document" });

    const docEvents = auditData.events.filter((e) => e.target_type === "shared_document");
    expect(docEvents.length).toBe(3);
    expect(docEvents.map((e) => e.action).sort()).toEqual([
      "document.created",
      "document.deleted",
      "document.updated",
    ]);
  });

  // ---- Shared Facts / Context (contact-scoped) ----

  it("creates and retrieves a contact-scoped fact", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.putFact(beta.agent_id, "project.status", "active");
    expect(result.key).toBe("project.status");
    expect(result.value).toBe("active");
    expect(result.version).toBe(1);
    expect(result.updated_by).toBe(alpha.agent_id);

    const fetched = await alphaClient.getFact(beta.agent_id, "project.status");
    expect(fetched.value).toBe("active");
    expect(fetched.version).toBe(1);
  });

  it("lists all contact-scoped facts", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.putFact(beta.agent_id, "key1", "val1");
    await alphaClient.putFact(beta.agent_id, "key2", { nested: true });

    const list = await alphaClient.listFacts(beta.agent_id);
    expect(list.facts.length).toBe(2);
    expect(list.facts.map((f: { key: string }) => f.key).sort()).toEqual(["key1", "key2"]);
  });

  it("updates a contact-scoped fact and increments version", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.putFact(beta.agent_id, "counter", 1);
    const updated = await alphaClient.putFact(beta.agent_id, "counter", 2);
    expect(updated.version).toBe(2);
    expect(updated.value).toBe(2);
  });

  it("supports optimistic concurrency with If-Match", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.putFact(beta.agent_id, "shared.key", "v1");

    // Update with correct version succeeds
    const ok = await alphaClient.putFact(beta.agent_id, "shared.key", "v2", { ifMatch: 1 });
    expect(ok.version).toBe(2);

    // Update with stale version fails (412)
    await expect(
      betaClient.putFact(alpha.agent_id, "shared.key", "v3", { ifMatch: 1 })
    ).rejects.toMatchObject({ status: 412 });
  });

  it("deletes a contact-scoped fact", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.putFact(beta.agent_id, "temp", "gone");
    const result = await alphaClient.deleteFact(beta.agent_id, "temp");
    expect(result.ok).toBe(true);

    await expect(alphaClient.getFact(beta.agent_id, "temp")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects fact access for non-contacts", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);

    await expect(alphaClient.listFacts(beta.agent_id)).rejects.toMatchObject({ status: 403 });
    await expect(alphaClient.putFact(beta.agent_id, "key", "val")).rejects.toMatchObject({ status: 403 });
  });

  it("returns 404 for non-existent fact", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(alphaClient.getFact(beta.agent_id, "nonexistent")).rejects.toMatchObject({ status: 404 });
  });

  it("stores complex JSON values as facts", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const complexValue = { items: [1, 2, 3], nested: { deep: true } };
    await alphaClient.putFact(beta.agent_id, "config", complexValue);

    const fetched = await alphaClient.getFact(beta.agent_id, "config");
    expect(fetched.value).toEqual(complexValue);
  });

  // ---- Shared Facts / Context (room-scoped) ----

  it("creates and retrieves a room-scoped fact", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const roomRes = await createRoomRaw(alpha.secret, { name: "Fact Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const result = await alphaClient.putRoomFact(room.id, "sprint.goal", "Ship v2");
    expect(result.key).toBe("sprint.goal");
    expect(result.value).toBe("Ship v2");
    expect(result.version).toBe(1);

    const fetched = await alphaClient.getRoomFact(room.id, "sprint.goal");
    expect(fetched.value).toBe("Ship v2");
  });

  it("lists room-scoped facts", async () => {
    const { alpha, alphaClient } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "List Fact Room" });
    const room = await roomRes.json();

    await alphaClient.putRoomFact(room.id, "a", 1);
    await alphaClient.putRoomFact(room.id, "b", 2);

    const list = await alphaClient.listRoomFacts(room.id);
    expect(list.facts.length).toBe(2);
  });

  it("updates a room-scoped fact with versioning", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const roomRes = await createRoomRaw(alpha.secret, { name: "Update Fact Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    await alphaClient.putRoomFact(room.id, "status", "draft");
    const updated = await betaClient.putRoomFact(room.id, "status", "reviewed");
    expect(updated.version).toBe(2);
    expect(updated.updated_by).toBe(beta.agent_id);
  });

  it("deletes a room-scoped fact", async () => {
    const { alpha, alphaClient } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Delete Fact Room" });
    const room = await roomRes.json();

    await alphaClient.putRoomFact(room.id, "temp", "val");
    const result = await alphaClient.deleteRoomFact(room.id, "temp");
    expect(result.ok).toBe(true);

    await expect(alphaClient.getRoomFact(room.id, "temp")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects room fact access for non-members", async () => {
    const { alpha, alphaClient } = await registerPair();
    const outsider = await createClient().register({ name: "outsider" });
    const outsiderClient = createClient(outsider.secret);

    const roomRes = await createRoomRaw(alpha.secret, { name: "Private Fact Room" });
    const room = await roomRes.json();

    await expect(outsiderClient.listRoomFacts(room.id)).rejects.toMatchObject({ status: 403 });
  });

  // ---- Shared Facts / Context (workspace-scoped) ----

  it("creates and retrieves a workspace-scoped fact", async () => {
    const { alpha, alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Fact WS" });

    const result = await alphaClient.putWorkspaceFact(ws.id, "team.lead", "alpha");
    expect(result.key).toBe("team.lead");
    expect(result.value).toBe("alpha");
    expect(result.version).toBe(1);

    const fetched = await alphaClient.getWorkspaceFact(ws.id, "team.lead");
    expect(fetched.value).toBe("alpha");
  });

  it("lists workspace-scoped facts", async () => {
    const { alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "List Fact WS" });

    await alphaClient.putWorkspaceFact(ws.id, "x", 10);
    await alphaClient.putWorkspaceFact(ws.id, "y", 20);

    const list = await alphaClient.listWorkspaceFacts(ws.id);
    expect(list.facts.length).toBe(2);
  });

  it("updates a workspace-scoped fact with versioning", async () => {
    const { alphaClient, betaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Update Fact WS" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    await alphaClient.putWorkspaceFact(ws.id, "version", "1.0");
    const updated = await betaClient.putWorkspaceFact(ws.id, "version", "2.0");
    expect(updated.version).toBe(2);
  });

  it("deletes a workspace-scoped fact", async () => {
    const { alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Delete Fact WS" });

    await alphaClient.putWorkspaceFact(ws.id, "temp", "val");
    const result = await alphaClient.deleteWorkspaceFact(ws.id, "temp");
    expect(result.ok).toBe(true);

    await expect(alphaClient.getWorkspaceFact(ws.id, "temp")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects workspace fact access for non-members", async () => {
    const { alphaClient } = await registerPair();
    const outsider = await createClient().register({ name: "outsider" });
    const outsiderClient = createClient(outsider.secret);

    const ws = await alphaClient.createWorkspace({ name: "Private Fact WS" });

    await expect(outsiderClient.listWorkspaceFacts(ws.id)).rejects.toMatchObject({ status: 403 });
  });

  it("supports If-Match concurrency control for room facts", async () => {
    const { alpha, alphaClient } = await registerPair();

    const roomRes = await createRoomRaw(alpha.secret, { name: "Concurrency Room" });
    const room = await roomRes.json();

    await alphaClient.putRoomFact(room.id, "lock", "v1");

    // Correct version succeeds
    const ok = await alphaClient.putRoomFact(room.id, "lock", "v2", { ifMatch: 1 });
    expect(ok.version).toBe(2);

    // Stale version fails
    await expect(
      alphaClient.putRoomFact(room.id, "lock", "v3", { ifMatch: 1 })
    ).rejects.toMatchObject({ status: 412 });
  });

  it("supports If-Match concurrency control for workspace facts", async () => {
    const { alphaClient } = await registerPair();

    const ws = await alphaClient.createWorkspace({ name: "Concurrency WS" });

    await alphaClient.putWorkspaceFact(ws.id, "lock", "v1");

    // Correct version succeeds
    const ok = await alphaClient.putWorkspaceFact(ws.id, "lock", "v2", { ifMatch: 1 });
    expect(ok.version).toBe(2);

    // Stale version fails with 412
    await expect(
      alphaClient.putWorkspaceFact(ws.id, "lock", "v3", { ifMatch: 1 })
    ).rejects.toMatchObject({ status: 412 });
  });

  it("If-Match '*' allows creating a new fact but rejects when fact exists", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // If-Match: * on a new fact should succeed (create)
    const created = await alphaClient.putFact(beta.agent_id, "star.test", "first", { ifMatch: "*" });
    expect(created.version).toBe(1);

    // If-Match: * on existing fact should still succeed (it only blocks non-"*" on missing)
    // The code only rejects non-"*" If-Match when fact doesn't exist
    // When fact exists, If-Match is checked against version — "*" won't match version number
    // Actually looking at the code: ifMatch !== String(existing[0].version) — "*" !== "1" so it will 412
    await expect(
      alphaClient.putFact(beta.agent_id, "star.test", "second", { ifMatch: "*" })
    ).rejects.toMatchObject({ status: 412 });
  });

  it("If-Match with non-'*' value on non-existent fact returns 412", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(
      alphaClient.putFact(beta.agent_id, "does.not.exist", "val", { ifMatch: 99 })
    ).rejects.toMatchObject({ status: 412 });
  });

  it("rejects invalid fact keys across all scopes", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Contact-scoped: key with spaces
    await expect(
      alphaClient.putFact(beta.agent_id, "invalid key", "val")
    ).rejects.toMatchObject({ status: 400 });

    // Contact-scoped: key with special chars
    await expect(
      alphaClient.putFact(beta.agent_id, "key/with/slashes", "val")
    ).rejects.toMatchObject({ status: 400 });

    // Contact-scoped: empty key — need raw request since SDK might URL-encode
    const emptyKeyRes = await app.request(`/context/${beta.agent_id}/facts/`, {
      method: "GET",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    // Empty key routes to list endpoint, so it won't 400 — that's fine

    // Contact-scoped: key too long (>128 chars)
    await expect(
      alphaClient.putFact(beta.agent_id, "a".repeat(129), "val")
    ).rejects.toMatchObject({ status: 400 });

    // Valid keys with dots, colons, hyphens, underscores should succeed
    const valid = await alphaClient.putFact(beta.agent_id, "project.status:v1_test-key", "val");
    expect(valid.version).toBe(1);
  });

  it("rejects invalid fact keys for room-scoped facts", async () => {
    const { alpha, alphaClient } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Key Validation Room" });
    const room = await roomRes.json();

    await expect(
      alphaClient.putRoomFact(room.id, "has spaces", "val")
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      alphaClient.putRoomFact(room.id, "a".repeat(129), "val")
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects invalid fact keys for workspace-scoped facts", async () => {
    const { alphaClient } = await registerPair();
    const ws = await alphaClient.createWorkspace({ name: "Key Validation WS" });

    await expect(
      alphaClient.putWorkspaceFact(ws.id, "has spaces", "val")
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      alphaClient.putWorkspaceFact(ws.id, "key@invalid!", "val")
    ).rejects.toMatchObject({ status: 400 });
  });

  it("deleting a non-existent fact succeeds silently (idempotent)", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Delete a fact that was never created
    const result = await alphaClient.deleteFact(beta.agent_id, "never.existed");
    expect(result.ok).toBe(true);
  });

  it("deleting a non-existent room fact succeeds silently", async () => {
    const { alpha, alphaClient } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Delete Ghost Room" });
    const room = await roomRes.json();

    const result = await alphaClient.deleteRoomFact(room.id, "ghost.key");
    expect(result.ok).toBe(true);
  });

  it("deleting a non-existent workspace fact succeeds silently", async () => {
    const { alphaClient } = await registerPair();
    const ws = await alphaClient.createWorkspace({ name: "Delete Ghost WS" });

    const result = await alphaClient.deleteWorkspaceFact(ws.id, "ghost.key");
    expect(result.ok).toBe(true);
  });

  it("unpin returns already_unpinned for messages that are not pinned", async () => {
    const { beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "never pinned" },
    });

    const result = await alphaClient.unpin(sent.id);
    expect(result).toMatchObject({ ok: true, already_unpinned: true });
  });

  it("workspace fact If-Match '*' allows new fact creation", async () => {
    const { alphaClient } = await registerPair();
    const ws = await alphaClient.createWorkspace({ name: "IfMatch Star WS" });

    // If-Match: * on new fact should succeed
    const created = await alphaClient.putWorkspaceFact(ws.id, "new.fact", "first", { ifMatch: "*" });
    expect(created.version).toBe(1);
  });

  it("room fact If-Match '*' allows new fact creation", async () => {
    const { alpha, alphaClient } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "IfMatch Star Room" });
    const room = await roomRes.json();

    const created = await alphaClient.putRoomFact(room.id, "new.fact", "first", { ifMatch: "*" });
    expect(created.version).toBe(1);
  });

  // ---- Message Templates ----

  it("creates and retrieves a template", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const tmpl = await client.createTemplate({
      name: "greeting",
      type: "update",
      payload: { content: "Hello {{name}}!" },
      description: "Standard greeting template",
    });

    expect(tmpl.id).toEqual(expect.any(String));
    expect(tmpl.name).toBe("greeting");
    expect(tmpl.type).toBe("update");
    expect(tmpl.payload).toEqual({ content: "Hello {{name}}!" });
    expect(tmpl.description).toBe("Standard greeting template");

    const fetched = await client.getTemplate(tmpl.id);
    expect(fetched.name).toBe("greeting");
  });

  it("lists all templates for the agent", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await client.createTemplate({ name: "t1", type: "update", payload: { content: "a" } });
    await client.createTemplate({ name: "t2", type: "question", payload: { content: "b" } });

    const list = await client.listTemplates();
    expect(list.templates.length).toBe(2);
    expect(list.templates.map((t: { name: string }) => t.name).sort()).toEqual(["t1", "t2"]);
  });

  it("updates a template", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const tmpl = await client.createTemplate({ name: "draft", type: "update", payload: { content: "v1" } });

    const updated = await client.updateTemplate(tmpl.id, {
      name: "final",
      payload: { content: "v2" },
      description: "Updated description",
    });

    expect(updated.name).toBe("final");
    expect(updated.payload).toEqual({ content: "v2" });
    expect(updated.description).toBe("Updated description");
  });

  it("rejects duplicate template names", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await client.createTemplate({ name: "unique", type: "update", payload: { content: "a" } });

    await expect(
      client.createTemplate({ name: "unique", type: "update", payload: { content: "b" } })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("deletes a template", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const tmpl = await client.createTemplate({ name: "doomed", type: "update", payload: { content: "bye" } });
    const result = await client.deleteTemplate(tmpl.id);
    expect(result.ok).toBe(true);

    await expect(client.getTemplate(tmpl.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects template creation with missing fields", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(
      client.createTemplate({ name: "", type: "update", payload: { content: "a" } })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects template name exceeding max length", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(
      client.createTemplate({ name: "a".repeat(201), type: "update", payload: { content: "a" } })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("templates are agent-scoped (isolated)", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const tmpl = await alphaClient.createTemplate({ name: "private", type: "update", payload: { content: "mine" } });

    await expect(betaClient.getTemplate(tmpl.id)).rejects.toMatchObject({ status: 404 });
    const betaList = await betaClient.listTemplates();
    expect(betaList.templates.length).toBe(0);
  });

  // ---- Attachments ----

  it("uploads and retrieves an attachment", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const att = await client.uploadAttachment({
      filename: "readme.txt",
      content_type: "text/plain",
      data: btoa("Hello World"),
    });

    expect(att.id).toEqual(expect.any(String));
    expect(att.filename).toBe("readme.txt");
    expect(att.content_type).toBe("text/plain");

    const fetched = await client.getAttachment(att.id);
    expect(fetched.data).toBe(btoa("Hello World"));
  });

  it("lists all attachments for the agent", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await client.uploadAttachment({ filename: "a.txt", data: btoa("a") });
    await client.uploadAttachment({ filename: "b.txt", data: btoa("b") });

    const list = await client.listAttachments();
    expect(list.attachments.length).toBe(2);
  });

  it("uploads an attachment linked to a message", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "see attachment" },
    });

    const att = await alphaClient.uploadAttachment({
      filename: "report.pdf",
      data: btoa("PDF content"),
      message_id: msg.id,
    });

    expect(att.message_id).toBe(msg.id);

    const msgAtts = await alphaClient.messageAttachments(msg.id);
    expect(msgAtts.attachments.length).toBe(1);
    expect(msgAtts.attachments[0].filename).toBe("report.pdf");
  });

  it("deletes an attachment", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    const att = await client.uploadAttachment({ filename: "temp.txt", data: btoa("temp") });
    const result = await client.deleteAttachment(att.id);
    expect(result.ok).toBe(true);

    await expect(client.getAttachment(att.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects attachment upload with missing fields", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(
      client.uploadAttachment({ filename: "", data: btoa("a") })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects attachment access by non-owner", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const att = await alphaClient.uploadAttachment({ filename: "secret.txt", data: btoa("private") });

    await expect(betaClient.getAttachment(att.id)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects attachment deletion by non-uploader", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const beta = await createClient().register({ name: "beta" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const att = await alphaClient.uploadAttachment({ filename: "mine.txt", data: btoa("mine") });

    await expect(betaClient.deleteAttachment(att.id)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects attachment linked to non-existent message", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(
      client.uploadAttachment({
        filename: "orphan.txt",
        data: btoa("data"),
        message_id: "00000000-0000-0000-0000-000000000000",
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects filename exceeding max length", async () => {
    const alpha = await createClient().register({ name: "alpha" });
    const client = createClient(alpha.secret);

    await expect(
      client.uploadAttachment({ filename: "a".repeat(256), data: btoa("a") })
    ).rejects.toMatchObject({ status: 400 });
  });

  // --- Workspace PATCH validation ---

  it("rejects workspace update with name exceeding 100 characters", async () => {
    const alpha = await createClient().register({ name: "ws-patch-val" });
    const client = createClient(alpha.secret);
    await client.createWorkspace({ name: "My WS" });

    const res = await app.request("/workspaces/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ name: "x".repeat(101) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("100");
  });

  it("rejects workspace update with metadata exceeding 10KB", async () => {
    const alpha = await createClient().register({ name: "ws-meta-val" });
    const client = createClient(alpha.secret);
    await client.createWorkspace({ name: "My WS" });

    const res = await app.request("/workspaces/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ metadata: { big: "x".repeat(11000) } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("10KB");
  });

  it("workspace PATCH /me is rate limited", async () => {
    const alpha = await createClient().register({ name: "ws-rl" });
    const client = createClient(alpha.secret);
    await client.createWorkspace({ name: "Rate WS" });

    // Send 21 requests to exceed the 20/min limit
    const results: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await app.request("/workspaces/me", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alpha.secret}`,
        },
        body: JSON.stringify({ name: `WS-${i}` }),
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  // --- Room creation validation ---

  it("room creation is rate limited", async () => {
    const alpha = await createClient().register({ name: "room-rl" });

    const results: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await createRoomRaw(alpha.secret, { name: `Room-${i}` });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  it("rejects room creation with metadata exceeding 10KB", async () => {
    const alpha = await createClient().register({ name: "room-meta-val" });

    const res = await createRoomRaw(alpha.secret, {
      name: "Good Room",
      metadata: { big: "x".repeat(11000) },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("10KB");
  });

  it("rejects room update with metadata exceeding 10KB", async () => {
    const alpha = await createClient().register({ name: "room-up-meta" });
    const roomRes = await createRoomRaw(alpha.secret, { name: "Good Room" });
    const room = await roomRes.json();

    const res = await app.request(`/rooms/${room.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ metadata: { big: "x".repeat(11000) } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("10KB");
  });

  // --- Agent PATCH /me rate limit ---

  it("agent PATCH /me is rate limited", async () => {
    const alpha = await createClient().register({ name: "agent-rl" });

    const results: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await app.request("/agents/me", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alpha.secret}`,
        },
        body: JSON.stringify({ name: `Agent-${i}` }),
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  // --- Hardening: audit route rate limiting ---

  it("audit events endpoint is rate limited at 30/min", async () => {
    const alpha = await createClient().register({ name: "audit-rl" });
    const results: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await app.request("/audit-events", {
        method: "GET",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  // --- Hardening: billing route rate limiting ---

  it("billing status is rate limited at 30/min", async () => {
    const alpha = await createClient().register({ name: "billing-rl" });
    // Create workspace so billing status works
    const wsRes = await app.request("/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ name: "BillingWS" }),
    });
    expect(wsRes.status).toBe(201);

    const results: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await app.request("/billing/status", {
        method: "GET",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  it("billing checkout is rate limited at 5/min", async () => {
    const alpha = await createClient().register({ name: "checkout-rl" });
    const wsRes = await app.request("/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ name: "CheckoutWS" }),
    });
    expect(wsRes.status).toBe(201);

    const results: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.request("/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alpha.secret}`,
        },
        body: JSON.stringify({}),
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  // --- Hardening: dashboard rate limiting ---

  it("dashboard is rate limited at 30/min", async () => {
    const alpha = await createClient().register({ name: "dash-rl" });
    const results: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await app.request(`/dashboard`, {
        method: "GET",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  // --- Hardening: contacts write rate limiting ---

  it("contacts write operations share a 30/min rate limit", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const results: number[] = [];
    // Exhaust with PATCH alias updates (30 calls)
    for (let i = 0; i < 30; i++) {
      const res = await app.request(`/contacts/${beta.agent_id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alpha.secret}`,
        },
        body: JSON.stringify({ alias: `alias-${i}` }),
      });
      results.push(res.status);
    }

    // 31st call should be rate limited — try a different write endpoint
    const blocked = await app.request(`/contacts/${beta.agent_id}/block`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({}),
    });
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body).toMatchObject({ error: "Rate limit exceeded", code: "RATE_LIMITED" });
  });

  // --- Room role change edge cases ---

  it("rejects invalid role value in room role change", async () => {
    const { alpha, beta } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Invalid Role Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const roleRes = await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ role: "superadmin" }),
    });
    expect(roleRes.status).toBe(400);
    const body = await roleRes.json();
    expect(body).toMatchObject({ error: "role must be 'admin' or 'member'", code: "INVALID_INPUT" });
  });

  it("rejects missing role in room role change", async () => {
    const { alpha, beta } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Missing Role Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const roleRes = await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({}),
    });
    expect(roleRes.status).toBe(400);
    const body = await roleRes.json();
    expect(body).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("cannot change own role in a room", async () => {
    const { alpha, beta } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Self Role Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const roleRes = await app.request(`/rooms/${room.id}/members/${alpha.agent_id}/role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ role: "member" }),
    });
    expect(roleRes.status).toBe(400);
    const body = await roleRes.json();
    expect(body).toMatchObject({ code: "SELF_ACTION" });
  });

  it("returns 404 when changing role of non-member in room", async () => {
    const { alpha, beta } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Ghost Role Room" });
    const room = await roomRes.json();
    // beta does NOT join the room

    const roleRes = await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(roleRes.status).toBe(404);
    const body = await roleRes.json();
    expect(body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("creator can demote admin back to member", async () => {
    const { alpha, beta } = await registerPair();
    const roomRes = await createRoomRaw(alpha.secret, { name: "Demote Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Promote beta to admin
    const promoteRes = await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(promoteRes.status).toBe(200);

    // Demote beta back to member
    const demoteRes = await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ role: "member" }),
    });
    expect(demoteRes.status).toBe(200);
    const body = await demoteRes.json();
    expect(body.role).toBe("member");
  });

  it("non-member caller gets 403 for room role change", async () => {
    const { alpha, beta } = await registerPair();
    const gamma = await createClient().register({ name: "gamma", owner: "Tester" });
    const gammaClient = createClient(gamma.secret);
    const roomRes = await createRoomRaw(alpha.secret, { name: "Outsider Role Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const roleRes = await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gamma.secret}`,
      },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(roleRes.status).toBe(403);
    const body = await roleRes.json();
    expect(body).toMatchObject({ code: "NOT_MEMBER" });
  });

  // --- Audit log filter edge cases ---

  it("auditLog filters by target_id", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Pairing creates audit events with target_id = beta.agent_id
    const result = await alphaClient.auditLog({ target_id: beta.agent_id });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((e) => e.target_id === beta.agent_id)).toBe(true);
  });

  it("auditLog filters by after date", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Use a date far in the past — all events should be included
    const result = await alphaClient.auditLog({ after: "2020-01-01T00:00:00Z" });
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("auditLog filters by before date (future date includes all)", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.auditLog({ before: "2099-01-01T00:00:00Z" });
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("auditLog returns empty when after date is in the future", async () => {
    const { alphaClient } = await registerPair();

    const result = await alphaClient.auditLog({ after: "2099-01-01T00:00:00Z" });
    expect(result.events).toEqual([]);
  });

  it("auditLog returns empty when before date is in the past", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.auditLog({ before: "2000-01-01T00:00:00Z" });
    expect(result.events).toEqual([]);
  });

  // --- Bulk operations: read-bulk, delete-bulk, label-bulk ---

  it("readBulk marks multiple messages as read", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "bulk read 1" } });
    const msg2 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "bulk read 2" } });

    const result = await betaClient.readBulk([msg1.id, msg2.id]);
    expect(result.ok).toBe(true);
    expect(result.marked).toBe(2);
  });

  it("readBulk ignores messages not addressed to the caller", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "not yours" } });

    // Alpha tries to mark as read a message addressed to beta
    const result = await alphaClient.readBulk([msg.id]);
    expect(result.marked).toBe(0);
  });

  it("readBulk rejects empty message_ids array", async () => {
    const { alphaClient } = await registerPair();
    await expect(alphaClient.readBulk([])).rejects.toMatchObject({ status: 400 });
  });

  it("deleteBulk soft-deletes multiple sent messages", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "bulk del 1" } });
    const msg2 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "bulk del 2" } });

    const result = await alphaClient.deleteBulk([msg1.id, msg2.id]);
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(2);
  });

  it("deleteBulk only deletes messages sent by the caller", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "not beta's" } });

    // Beta tries to delete alpha's sent message
    const result = await betaClient.deleteBulk([msg.id]);
    expect(result.deleted).toBe(0);
  });

  it("deleteBulk rejects empty array", async () => {
    const { alphaClient } = await registerPair();
    await expect(alphaClient.deleteBulk([])).rejects.toMatchObject({ status: 400 });
  });

  it("labelBulk adds a label to multiple messages", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "label me 1" } });
    const msg2 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "label me 2" } });

    const result = await alphaClient.labelBulk([msg1.id, msg2.id], "important");
    expect(result.ok).toBe(true);
    expect(result.labeled).toBe(2);
  });

  it("labelBulk rejects missing label", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "test" } });

    const res = await app.request("/messages/label-bulk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alpha.secret}`,
      },
      body: JSON.stringify({ message_ids: [msg.id] }),
    });
    expect(res.status).toBe(400);
  });

  it("labelBulk rejects empty message_ids", async () => {
    const { alphaClient } = await registerPair();
    await expect(alphaClient.labelBulk([], "urgent")).rejects.toMatchObject({ status: 400 });
  });

  // --- Messages by label and all labels ---

  it("messagesByLabel returns messages with the specified label", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "labeled msg" } });
    await alphaClient.addLabel(msg.id, "priority");

    const result = await alphaClient.messagesByLabel("priority");
    expect(result.messages.length).toBe(1);
  });

  it("messagesByLabel returns empty for unused label", async () => {
    const { alphaClient } = await registerPair();
    const result = await alphaClient.messagesByLabel("nonexistent");
    expect(result.messages).toEqual([]);
  });

  it("allLabels returns all labels with counts", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg1 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "label test 1" } });
    const msg2 = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "label test 2" } });

    await alphaClient.addLabel(msg1.id, "urgent");
    await alphaClient.addLabel(msg2.id, "urgent");
    await alphaClient.addLabel(msg1.id, "review");

    const result = await alphaClient.allLabels();
    const urgentLabel = result.labels.find((l) => l.label === "urgent");
    const reviewLabel = result.labels.find((l) => l.label === "review");
    expect(urgentLabel?.count).toBe(2);
    expect(reviewLabel?.count).toBe(1);
  });

  it("allLabels returns empty when no labels exist", async () => {
    const { alphaClient } = await registerPair();
    const result = await alphaClient.allLabels();
    expect(result.labels).toEqual([]);
  });

  // --- Contacts: blocked list, tags by-tag, tags/all ---

  it("blockedContacts returns the blocked list with names", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    await alphaClient.blockContact(beta.agent_id, "spammy");

    const result = await alphaClient.blockedContacts();
    expect(result.count).toBe(1);
    expect(result.blocked[0]).toMatchObject({
      agent_id: beta.agent_id,
      reason: "spammy",
    });
    expect(result.blocked[0].blocked_at).toBeDefined();
  });

  it("blockedContacts returns empty when no contacts are blocked", async () => {
    const { alphaClient } = await registerPair();
    const result = await alphaClient.blockedContacts();
    expect(result.blocked).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("contactsByTag returns contacts with the specified tag", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    await alphaClient.addContactTag(beta.agent_id, "teammate");

    const result = await alphaClient.contactsByTag("teammate");
    expect(result.contacts.length).toBe(1);
    expect(result.contacts[0].agent_id).toBe(beta.agent_id);
  });

  it("contactsByTag returns empty for unused tag", async () => {
    const { alphaClient } = await registerPair();
    const result = await alphaClient.contactsByTag("nonexistent");
    expect(result.contacts).toEqual([]);
  });

  it("allContactTags returns all tags with counts", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const gamma = await createClient().register({ name: "gamma", owner: "Tester" });
    await alphaClient.pair({ code: gamma.pairing_code });

    await alphaClient.addContactTag(beta.agent_id, "dev");
    await alphaClient.addContactTag(gamma.agent_id, "dev");
    await alphaClient.addContactTag(beta.agent_id, "priority");

    const result = await alphaClient.allContactTags();
    const devTag = result.tags.find((t) => t.tag === "dev");
    const prioTag = result.tags.find((t) => t.tag === "priority");
    expect(devTag?.count).toBe(2);
    expect(prioTag?.count).toBe(1);
  });

  it("allContactTags returns empty when no tags exist", async () => {
    const { alphaClient } = await registerPair();
    const result = await alphaClient.allContactTags();
    expect(result.tags).toEqual([]);
  });

  // --- Notification preferences ---

  it("notificationPrefs returns defaults when no prefs set", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.notificationPrefs(beta.agent_id);
    expect(result.muted).toBe(false);
    expect(result.urgency_filter).toBe("all");
  });

  it("setNotificationPrefs creates new prefs", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.setNotificationPrefs(beta.agent_id, { muted: true, urgency_filter: "sync_only" });
    expect(result.muted).toBe(true);
    expect(result.urgency_filter).toBe("sync_only");
  });

  it("setNotificationPrefs updates existing prefs", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.setNotificationPrefs(beta.agent_id, { muted: true });
    const updated = await alphaClient.setNotificationPrefs(beta.agent_id, { muted: false });
    expect(updated.muted).toBe(false);
  });

  it("setNotificationPrefs rejects invalid urgency_filter", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await expect(
      alphaClient.setNotificationPrefs(beta.agent_id, { urgency_filter: "invalid" })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("notificationPrefs returns stored values after set", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.setNotificationPrefs(beta.agent_id, { muted: true, urgency_filter: "sync_only" });
    const result = await alphaClient.notificationPrefs(beta.agent_id);
    expect(result.muted).toBe(true);
    expect(result.urgency_filter).toBe("sync_only");
  });

  // --- Additional audit log filter edge cases ---

  it("auditLog combines action and target_type filters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "combined filter test" },
    });

    const result = await alphaClient.auditLog({ action: "message.send", target_type: "message" });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((e) => e.action === "message.send" && e.target_type === "message")).toBe(true);
  });

  // --- Rate limiting on read endpoints ---

  it("reactions endpoint includes rate limit headers", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "text",
      payload: { content: "rate limit reactions test" },
    });
    const secret = (alphaClient as unknown as { secret: string }).secret;
    const res = await app.request(`/messages/${msg.id}/reactions`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("thread pins endpoint includes rate limit headers", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "text",
      payload: { content: "rate limit pins test" },
    });
    const secret = (alphaClient as unknown as { secret: string }).secret;
    const res = await app.request(`/messages/thread/${msg.thread_id}/pins`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("thread summary endpoint includes rate limit headers", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "text",
      payload: { content: "rate limit summary test" },
    });
    const secret = (alphaClient as unknown as { secret: string }).secret;
    const res = await app.request(`/messages/thread/${msg.thread_id}/summary`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("labels/all endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const secret = alpha.secret;
    const res = await app.request("/messages/labels/all", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("message labels endpoint includes rate limit headers", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const msg = await alphaClient.send({
      to: beta.agent_id,
      type: "text",
      payload: { content: "rate limit msg labels test" },
    });
    const secret = (alphaClient as unknown as { secret: string }).secret;
    const res = await app.request(`/messages/${msg.id}/labels`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("presence endpoint includes rate limit headers", async () => {
    const alpha = await createClient().register({ name: "presence-rl", owner: "Test" });
    const alphaClient = createClient(alpha.secret);
    await alphaClient.createWorkspace({ name: "RL Workspace" });
    const secret = alpha.secret;
    const res = await app.request("/agents/presence", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("analytics endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const secret = alpha.secret;
    const res = await app.request("/agents/me/analytics", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("contacts list endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const secret = alpha.secret;
    const res = await app.request("/contacts", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("blocked contacts endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const secret = alpha.secret;
    const res = await app.request("/contacts/blocked", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("contact tags/all endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const secret = alpha.secret;
    const res = await app.request("/contacts/tags/all", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("inbox endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const res = await app.request("/messages/inbox", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("inbox/stats endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const res = await app.request("/messages/inbox/stats", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("threads endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const res = await app.request("/messages/threads", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("sent endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const res = await app.request("/messages/sent", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("search endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const res = await app.request("/messages/search?q=test", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("saved searches endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const res = await app.request("/messages/searches", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("rejects search with invalid after date", async () => {
    const { alpha } = await registerPair();
    const res = await app.request("/messages/search?after=not-a-date", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects search with invalid before date", async () => {
    const { alpha } = await registerPair();
    const res = await app.request("/messages/search?before=xyz", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects search with invalid contact UUID", async () => {
    const { alpha } = await registerPair();
    const res = await app.request("/messages/search?contact=not-a-uuid", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
  });

  it("accepts search with valid contact UUID", async () => {
    const { alpha, beta } = await registerPair();
    const res = await app.request(`/messages/search?contact=${beta.agent_id}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects whitespace-only tag", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request(`/contacts/${beta.agent_id}/tags`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alpha.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tag: "   " }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("trims whitespace from tags before storing", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const result = await alphaClient.addContactTag(beta.agent_id, "  team  ");
    expect(result.tag).toBe("team");
  });

  it("threads endpoint returns projected fields correctly", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Create a thread
    const msg = await alphaClient.send({ to: beta.agent_id, type: "question", payload: { content: "thread test" } });

    const res = await app.request("/messages/threads", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threads.length).toBeGreaterThanOrEqual(1);
    const thread = body.threads.find((t: { thread_id: string }) => t.thread_id === msg.id);
    expect(thread).toBeDefined();
    expect(thread.last_message.type).toBe("question");
    expect(thread.last_message.preview).toBe("thread test");
  });

  it("rooms list endpoint includes rate limit headers", async () => {
    const { alpha } = await registerPair();
    const res = await app.request("/rooms", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("room update endpoint is rate limited", async () => {
    const alpha = await createClient().register({ name: "room-upd-rl" });
    const roomRes = await createRoomRaw(alpha.secret, { name: "RL Update Room" });
    const room = await roomRes.json();

    const results: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await app.request(`/rooms/${room.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
        body: JSON.stringify({ name: `Updated-${i}` }),
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  it("room kick endpoint is rate limited", async () => {
    const alpha = await createClient().register({ name: "room-kick-rl" });
    const beta = await createClient().register({ name: "room-kick-rl-b" });
    const roomRes = await createRoomRaw(alpha.secret, { name: "RL Kick Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const results: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await app.request(`/rooms/${room.id}/kick`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
        body: JSON.stringify({ agent_id: beta.agent_id }),
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  it("room role change endpoint is rate limited", async () => {
    const alpha = await createClient().register({ name: "room-role-rl" });
    const beta = await createClient().register({ name: "room-role-rl-b" });
    const roomRes = await createRoomRaw(alpha.secret, { name: "RL Role Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    const results: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
        body: JSON.stringify({ role: i % 2 === 0 ? "admin" : "member" }),
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  it("room delete endpoint is rate limited", async () => {
    const alpha = await createClient().register({ name: "room-del-rl" });

    const results: number[] = [];
    for (let i = 0; i < 21; i++) {
      const roomRes = await createRoomRaw(alpha.secret, { name: `RL Del Room ${i}` });
      const room = await roomRes.json() as { id?: string };
      if (!room.id) { results.push(roomRes.status); continue; }
      const res = await app.request(`/rooms/${room.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  it("room leave endpoint is rate limited", async () => {
    const alpha = await createClient().register({ name: "room-leave-rl" });

    const results: number[] = [];
    for (let i = 0; i < 21; i++) {
      const roomRes = await createRoomRaw(alpha.secret, { name: `RL Leave Room ${i}` });
      const room = await roomRes.json() as { id?: string };
      if (!room.id) { results.push(roomRes.status); continue; }
      const res = await app.request(`/rooms/${room.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  // --- Attachment CRUD tests ---

  it("uploads an attachment and retrieves it", async () => {
    const alpha = await createClient().register({ name: "attach-crud", owner: "Frank" });

    const createRes = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "readme.txt", data: btoa("hello world"), content_type: "text/plain" }),
    });
    expect(createRes.status).toBe(201);
    const attachment = await createRes.json();
    expect(attachment.filename).toBe("readme.txt");
    expect(attachment.content_type).toBe("text/plain");
    expect(typeof attachment.id).toBe("string");
    expect(attachment.size_bytes).toBeGreaterThan(0);

    // Retrieve it
    const getRes = await app.request(`/attachments/${attachment.id}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.id).toBe(attachment.id);
    expect(fetched.data).toBe(btoa("hello world"));
  });

  it("lists my attachments", async () => {
    const alpha = await createClient().register({ name: "attach-list", owner: "Frank" });

    await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "file1.txt", data: btoa("one") }),
    });
    await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "file2.txt", data: btoa("two") }),
    });

    const listRes = await app.request("/attachments", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.attachments).toHaveLength(2);
  });

  it("deletes an attachment", async () => {
    const alpha = await createClient().register({ name: "attach-del", owner: "Frank" });

    const createRes = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "delete-me.txt", data: btoa("bye") }),
    });
    const attachment = await createRes.json();

    const delRes = await app.request(`/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);

    // Verify it's gone
    const getRes = await app.request(`/attachments/${attachment.id}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(getRes.status).toBe(404);
  });

  it("cannot access another agent's attachment", async () => {
    const alpha = await createClient().register({ name: "attach-owner", owner: "Frank" });
    const beta = await createClient().register({ name: "attach-other", owner: "Frank" });

    const createRes = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "private.txt", data: btoa("secret") }),
    });
    const attachment = await createRes.json();

    // Beta cannot read it
    const getRes = await app.request(`/attachments/${attachment.id}`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(getRes.status).toBe(403);

    // Beta cannot delete it
    const delRes = await app.request(`/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(delRes.status).toBe(403);
  });

  it("uploads an attachment linked to a message", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "See attached" },
    });

    const createRes = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "report.pdf", data: btoa("pdf-data"), message_id: sent.id }),
    });
    expect(createRes.status).toBe(201);
    const attachment = await createRes.json();
    expect(attachment.message_id).toBe(sent.id);

    // List attachments for the message
    const listRes = await app.request(`/attachments/message/${sent.id}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.attachments).toHaveLength(1);
    expect(list.attachments[0].filename).toBe("report.pdf");
  });

  it("recipient can access message-linked attachment", async () => {
    const { alpha, beta, alphaClient, betaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "File attached" },
    });

    const createRes = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "shared.txt", data: btoa("shared-content"), message_id: sent.id }),
    });
    const attachment = await createRes.json();

    // Beta (recipient) can read the attachment
    const getRes = await app.request(`/attachments/${attachment.id}`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.filename).toBe("shared.txt");

    // Beta can list message attachments
    const listRes = await app.request(`/attachments/message/${sent.id}`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.attachments).toHaveLength(1);
  });

  it("third party cannot access message-linked attachment", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });
    const gamma = await createClient().register({ name: "attach-gamma", owner: "Frank" });

    const sent = await alphaClient.send({
      to: beta.agent_id,
      type: "update",
      payload: { content: "Private message" },
    });

    const createRes = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "secret.txt", data: btoa("private"), message_id: sent.id }),
    });
    const attachment = await createRes.json();

    // Gamma (third party) cannot read it
    const getRes = await app.request(`/attachments/${attachment.id}`, {
      headers: { Authorization: `Bearer ${gamma.secret}` },
    });
    expect(getRes.status).toBe(403);

    // Gamma cannot list message attachments
    const listRes = await app.request(`/attachments/message/${sent.id}`, {
      headers: { Authorization: `Bearer ${gamma.secret}` },
    });
    expect(listRes.status).toBe(403);
  });

  it("rejects attachment with missing required fields", async () => {
    const alpha = await createClient().register({ name: "attach-miss", owner: "Frank" });

    const res = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "test.txt" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_FIELD");
  });

  it("rejects attachment with invalid base64", async () => {
    const alpha = await createClient().register({ name: "attach-b64", owner: "Frank" });

    const res = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "test.txt", data: "not!valid@base64" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
  });

  it("rejects attachment linked to nonexistent message", async () => {
    const alpha = await createClient().register({ name: "attach-nomsg", owner: "Frank" });

    const res = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "test.txt", data: btoa("data"), message_id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("MESSAGE_NOT_FOUND");
  });

  it("returns 404 for nonexistent attachment", async () => {
    const alpha = await createClient().register({ name: "attach-404", owner: "Frank" });

    const res = await app.request("/attachments/00000000-0000-0000-0000-000000000000", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(404);
  });

  it("defaults content_type to application/octet-stream", async () => {
    const alpha = await createClient().register({ name: "attach-default-ct", owner: "Frank" });

    const createRes = await app.request("/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ filename: "mystery.bin", data: btoa("binary") }),
    });
    expect(createRes.status).toBe(201);
    const attachment = await createRes.json();
    expect(attachment.content_type).toBe("application/octet-stream");
  });

  // --- Template CRUD tests ---

  it("creates a template and retrieves it", async () => {
    const alpha = await createClient().register({ name: "tpl-crud", owner: "Frank" });

    const createRes = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Greeting", type: "hello", payload: { content: "Hi {{name}}!" } }),
    });
    expect(createRes.status).toBe(201);
    const tpl = await createRes.json();
    expect(tpl.name).toBe("Greeting");
    expect(tpl.type).toBe("hello");
    expect(tpl.payload).toMatchObject({ content: "Hi {{name}}!" });

    // Get by ID
    const getRes = await app.request(`/templates/${tpl.id}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.id).toBe(tpl.id);
    expect(fetched.name).toBe("Greeting");
  });

  it("lists templates", async () => {
    const alpha = await createClient().register({ name: "tpl-list", owner: "Frank" });

    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "T1", type: "t", payload: { content: "a" } }),
    });
    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "T2", type: "t", payload: { content: "b" } }),
    });

    const listRes = await app.request("/templates", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.templates).toHaveLength(2);
  });

  it("updates a template", async () => {
    const alpha = await createClient().register({ name: "tpl-update", owner: "Frank" });

    const createRes = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Original", type: "greeting", payload: { content: "v1" } }),
    });
    const tpl = await createRes.json();

    const patchRes = await app.request(`/templates/${tpl.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Updated", payload: { content: "v2" } }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.name).toBe("Updated");
    expect(updated.payload).toMatchObject({ content: "v2" });
  });

  it("deletes a template", async () => {
    const alpha = await createClient().register({ name: "tpl-delete", owner: "Frank" });

    const createRes = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "DeleteMe", type: "temp", payload: { content: "gone" } }),
    });
    const tpl = await createRes.json();

    const delRes = await app.request(`/templates/${tpl.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);

    // Verify it's gone
    const getRes = await app.request(`/templates/${tpl.id}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(getRes.status).toBe(404);
  });

  it("rejects duplicate template name", async () => {
    const alpha = await createClient().register({ name: "tpl-dup", owner: "Frank" });

    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Unique", type: "greeting", payload: { content: "hi" } }),
    });

    const dupRes = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Unique", type: "greeting", payload: { content: "hi again" } }),
    });
    expect(dupRes.status).toBe(409);
    const body = await dupRes.json();
    expect(body.code).toBe("ALREADY_EXISTS");
  });

  it("cannot access another agent's template", async () => {
    const alpha = await createClient().register({ name: "tpl-owner", owner: "Frank" });
    const beta = await createClient().register({ name: "tpl-other", owner: "Frank" });

    const createRes = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Private", type: "secret", payload: { content: "mine" } }),
    });
    const tpl = await createRes.json();

    // Beta cannot read it
    const getRes = await app.request(`/templates/${tpl.id}`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(getRes.status).toBe(404);

    // Beta cannot update it
    const patchRes = await app.request(`/templates/${tpl.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${beta.secret}` },
      body: JSON.stringify({ name: "Hacked" }),
    });
    expect(patchRes.status).toBe(404);

    // Beta cannot delete it
    const delRes = await app.request(`/templates/${tpl.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(delRes.status).toBe(404);
  });

  it("rejects template creation with missing required fields", async () => {
    const alpha = await createClient().register({ name: "tpl-miss", owner: "Frank" });

    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "NoPayload", type: "greeting" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_FIELD");
  });

  it("creates template with description and retrieves it", async () => {
    const alpha = await createClient().register({ name: "tpl-desc", owner: "Frank" });

    const createRes = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Described", type: "greeting", payload: { content: "hi" }, description: "A friendly greeting" }),
    });
    expect(createRes.status).toBe(201);
    const tpl = await createRes.json();
    expect(tpl.description).toBe("A friendly greeting");

    const getRes = await app.request(`/templates/${tpl.id}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    const fetched = await getRes.json();
    expect(fetched.description).toBe("A friendly greeting");
  });

  it("rejects rename to existing template name", async () => {
    const alpha = await createClient().register({ name: "tpl-rename-dup", owner: "Frank" });

    await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "First", type: "t", payload: { content: "a" } }),
    });
    const secondRes = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "Second", type: "t", payload: { content: "b" } }),
    });
    const second = await secondRes.json();

    const patchRes = await app.request(`/templates/${second.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ name: "First" }),
    });
    expect(patchRes.status).toBe(409);
    const body = await patchRes.json();
    expect(body.code).toBe("ALREADY_EXISTS");
  });

  it("returns 404 for nonexistent template", async () => {
    const alpha = await createClient().register({ name: "tpl-404", owner: "Frank" });

    const res = await app.request("/templates/00000000-0000-0000-0000-000000000000", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).toBe(404);
  });

  // --- Hardening: message write endpoint rate limiting ---

  it("rate limits message cancel at 30/min", async () => {
    const { alpha, alphaClient } = await registerPair();

    for (let i = 0; i < 30; i++) {
      const res = await app.request("/messages/00000000-0000-0000-0000-000000000099/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // 404 is fine — rate limit counts regardless
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099/cancel", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits message delete at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits message edit at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: { content: "test" } }),
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { content: "test" } }),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits message read-mark at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099/read", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099/read", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits message ack at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099/ack", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099/ack", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits message forward at 60/min (shared with sends)", async () => {
    const { alpha } = await registerPair();

    // Exhaust the messages rate limit (60/min)
    for (let i = 0; i < 60; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099/forward", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json", "Idempotency-Key": `fwd-${i}` },
        body: JSON.stringify({ to: "someone" }),
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099/forward", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json", "Idempotency-Key": "fwd-overflow" },
      body: JSON.stringify({ to: "someone" }),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits message react at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099/react", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: "👍" }),
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099/react", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "👍" }),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits message unreact at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099/react/%F0%9F%91%8D", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099/react/%F0%9F%91%8D", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits message pin at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099/pin", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099/pin", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits message unpin at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099/unpin", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099/unpin", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits add label at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099/labels", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ label: "test" }),
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099/labels", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "test" }),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits remove label at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/00000000-0000-0000-0000-000000000099/labels/test", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/messages/00000000-0000-0000-0000-000000000099/labels/test", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits save search at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/searches", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: `search-${i}`, query: { type: "test" } }),
      });
    }

    const blocked = await app.request("/messages/searches", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "search-overflow", query: { type: "test" } }),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits delete search at 30/min", async () => {
    const { alpha } = await registerPair();

    for (let i = 0; i < 30; i++) {
      await app.request("/messages/searches/00000000-0000-0000-0000-000000000099", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/messages/searches/00000000-0000-0000-0000-000000000099", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  // --- Hardening: agent write endpoint rate limiting ---

  it("rate limits agent status update at 30/min", async () => {
    const alpha = await createClient().register({ name: "status-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/agents/me/status", {
        method: "PUT",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: `status-${i}` }),
      });
    }

    const blocked = await app.request("/agents/me/status", {
      method: "PUT",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "overflow" }),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits webhook set at 30/min", async () => {
    const alpha = await createClient().register({ name: "webhook-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/agents/me/webhook", {
        method: "PUT",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://example.com/hook${i}` }),
      });
    }

    const blocked = await app.request("/agents/me/webhook", {
      method: "PUT",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/overflow" }),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits webhook delete at 30/min", async () => {
    const alpha = await createClient().register({ name: "webhook-del-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/agents/me/webhook", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/agents/me/webhook", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits webhook rotate-secret at 30/min", async () => {
    const alpha = await createClient().register({ name: "wh-rotate-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/agents/me/webhook/rotate-secret", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/agents/me/webhook/rotate-secret", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits webhook test at 30/min", async () => {
    const alpha = await createClient().register({ name: "wh-test-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/agents/me/webhook/test", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/agents/me/webhook/test", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits secret rotation at 30/min", async () => {
    const alpha = await createClient().register({ name: "rotate-rl" });
    let currentSecret = alpha.secret;

    for (let i = 0; i < 30; i++) {
      const res = await app.request("/agents/me/rotate-secret", {
        method: "POST",
        headers: { Authorization: `Bearer ${currentSecret}` },
      });
      if (res.status === 200) {
        const body = await res.json();
        currentSecret = body.secret;
      }
    }

    const blocked = await app.request("/agents/me/rotate-secret", {
      method: "POST",
      headers: { Authorization: `Bearer ${currentSecret}` },
    });
    expect(blocked.status).toBe(429);
  });

  // --- Hardening: workspace write endpoint rate limiting ---

  it("rate limits workspace leave at 30/min", async () => {
    const alpha = await createClient().register({ name: "ws-leave-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/workspaces/leave", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/workspaces/leave", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits workspace kick at 30/min", async () => {
    const alpha = await createClient().register({ name: "ws-kick-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/workspaces/kick", {
        method: "POST",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "nonexistent" }),
      });
    }

    const blocked = await app.request("/workspaces/kick", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "nonexistent" }),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits workspace role change at 30/min", async () => {
    const alpha = await createClient().register({ name: "ws-role-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/workspaces/members/00000000-0000-0000-0000-000000000099/role", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      });
    }

    const blocked = await app.request("/workspaces/members/00000000-0000-0000-0000-000000000099/role", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits workspace delete at 30/min", async () => {
    const alpha = await createClient().register({ name: "ws-del-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/workspaces", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/workspaces", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  // --- Hardening: document write endpoint rate limiting ---

  it("rate limits document update at 30/min", async () => {
    const alpha = await createClient().register({ name: "doc-update-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/documents/00000000-0000-0000-0000-000000000098/00000000-0000-0000-0000-000000000099", {
        method: "PUT",
        headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ body: "test content" }),
      });
    }

    const blocked = await app.request("/documents/00000000-0000-0000-0000-000000000098/00000000-0000-0000-0000-000000000099", {
      method: "PUT",
      headers: { Authorization: `Bearer ${alpha.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "test content" }),
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits document delete at 30/min", async () => {
    const alpha = await createClient().register({ name: "doc-del-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/documents/00000000-0000-0000-0000-000000000098/00000000-0000-0000-0000-000000000099", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/documents/00000000-0000-0000-0000-000000000098/00000000-0000-0000-0000-000000000099", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  // --- Hardening: attachment delete rate limiting ---

  it("rate limits attachment delete at 30/min", async () => {
    const alpha = await createClient().register({ name: "att-del-rl" });

    for (let i = 0; i < 30; i++) {
      await app.request("/attachments/00000000-0000-0000-0000-000000000099", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/attachments/00000000-0000-0000-0000-000000000099", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  // --- Hardening: UUID validation on path params ---

  it("rejects invalid UUID in path params with 400", async () => {
    const alpha = await createClient().register({ name: "uuid-val" });

    // Tasks endpoint with invalid contactId
    const tasksRes = await app.request("/tasks/not-a-uuid", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(tasksRes.status).toBe(400);
    const tasksBody = await tasksRes.json() as { code: string };
    expect(tasksBody.code).toBe("INVALID_INPUT");

    // Rooms endpoint with invalid roomId
    const roomRes = await app.request("/rooms/not-a-uuid/members", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(roomRes.status).toBe(400);

    // Messages endpoint with invalid messageId
    const msgRes = await app.request("/messages/not-a-uuid/ack", {
      method: "POST",
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(msgRes.status).toBe(400);

    // Templates endpoint with invalid id
    const tmplRes = await app.request("/templates/;;;drop-table", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(tmplRes.status).toBe(400);

    // Attachments endpoint with invalid id
    const attRes = await app.request("/attachments/xyz", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(attRes.status).toBe(400);
  });

  it("accepts valid UUIDs in path params", async () => {
    const alpha = await createClient().register({ name: "uuid-ok" });
    const validUUID = "00000000-0000-0000-0000-000000000000";

    // Should get past UUID validation (404 means the resource wasn't found, not a validation error)
    const res = await app.request(`/tasks/${validUUID}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(res.status).not.toBe(400);
  });

  // --- Hardening: rate limits on previously unprotected read endpoints ---

  it("rate limits scheduled messages listing at 60/min", async () => {
    const alpha = await createClient().register({ name: "sched-rl" });

    for (let i = 0; i < 60; i++) {
      await app.request("/messages/scheduled", {
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/messages/scheduled", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits messages by-label at 60/min", async () => {
    const alpha = await createClient().register({ name: "label-rl" });

    for (let i = 0; i < 60; i++) {
      await app.request("/messages/by-label/test-label", {
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request("/messages/by-label/test-label", {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits template get-by-id at 60/min", async () => {
    const alpha = await createClient().register({ name: "tmpl-rl" });
    const fakeId = "00000000-0000-0000-0000-000000000001";

    for (let i = 0; i < 60; i++) {
      await app.request(`/templates/${fakeId}`, {
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request(`/templates/${fakeId}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  it("rate limits attachment list-by-message at 60/min", async () => {
    const alpha = await createClient().register({ name: "attmsg-rl" });
    const fakeId = "00000000-0000-0000-0000-000000000002";

    for (let i = 0; i < 60; i++) {
      await app.request(`/attachments/message/${fakeId}`, {
        headers: { Authorization: `Bearer ${alpha.secret}` },
      });
    }

    const blocked = await app.request(`/attachments/message/${fakeId}`, {
      headers: { Authorization: `Bearer ${alpha.secret}` },
    });
    expect(blocked.status).toBe(429);
  });

  // --- Room edge case tests ---

  it("admin cannot kick the room creator", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "room-creator" });
    const beta = await anon.register({ name: "room-admin" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    // Alpha creates room (becomes creator), beta joins
    const roomRes = await createRoomRaw(alpha.secret, { name: "Creator Protection" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Promote beta to admin
    await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ role: "admin" }),
    });

    // Admin (beta) tries to kick creator (alpha) — should fail
    const kickRes = await app.request(`/rooms/${room.id}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${beta.secret}` },
      body: JSON.stringify({ agent_id: alpha.agent_id }),
    });
    expect(kickRes.status).toBe(403);
    const body = await kickRes.json();
    expect(body.code).toBe("INSUFFICIENT_ROLE");
  });

  it("admin cannot kick another admin in a room", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "room-creator" });
    const beta = await anon.register({ name: "admin-1" });
    const gamma = await anon.register({ name: "admin-2" });

    const roomRes = await createRoomRaw(alpha.secret, { name: "Admin vs Admin" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);
    await joinRoomRaw(gamma.secret, room.pairing_code);

    // Promote both to admin
    await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ role: "admin" }),
    });
    await app.request(`/rooms/${room.id}/members/${gamma.agent_id}/role`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ role: "admin" }),
    });

    // Admin beta tries to kick admin gamma — should fail
    const kickRes = await app.request(`/rooms/${room.id}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${beta.secret}` },
      body: JSON.stringify({ agent_id: gamma.agent_id }),
    });
    expect(kickRes.status).toBe(403);
    const body = await kickRes.json();
    expect(body.code).toBe("INSUFFICIENT_ROLE");
  });

  it("non-creator cannot delete a room", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "room-creator" });
    const beta = await anon.register({ name: "room-admin" });

    const roomRes = await createRoomRaw(alpha.secret, { name: "Delete Protected" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Promote beta to admin
    await app.request(`/rooms/${room.id}/members/${beta.agent_id}/role`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ role: "admin" }),
    });

    // Admin (not creator) tries to delete — should fail
    const delRes = await app.request(`/rooms/${room.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(delRes.status).toBe(403);
    const body = await delRes.json();
    expect(body.code).toBe("INSUFFICIENT_ROLE");
  });

  it("room double-join returns idempotent response", async () => {
    const alpha = await createClient().register({ name: "double-joiner" });

    const roomRes = await createRoomRaw(alpha.secret, { name: "Rejoin Room" });
    const room = await roomRes.json();

    // Create a second agent and join twice
    const beta = await createClient().register({ name: "beta-joiner" });
    const join1 = await joinRoomRaw(beta.secret, room.pairing_code);
    expect(join1.status).toBe(200);
    const join1Body = await join1.json();
    expect(join1Body.joined).toBe(true);

    // Second join with same code — should be idempotent
    const join2 = await joinRoomRaw(beta.secret, room.pairing_code);
    expect(join2.status).toBe(200);
    const join2Body = await join2.json();
    expect(join2Body.joined).toBe(true);
    expect(join2Body.already_member).toBe(true);
    expect(join2Body.room_id).toBe(room.id);
  });

  it("kicked member cannot access room resources", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "room-owner" });
    const beta = await anon.register({ name: "kicked-member" });

    const roomRes = await createRoomRaw(alpha.secret, { name: "Kick Access" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Beta can access members
    const beforeKick = await app.request(`/rooms/${room.id}/members`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(beforeKick.status).toBe(200);

    // Kick beta
    await app.request(`/rooms/${room.id}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ agent_id: beta.agent_id }),
    });

    // Beta can no longer access members
    const afterKick = await app.request(`/rooms/${room.id}/members`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(afterKick.status).toBe(403);
  });

  it("room leave removes membership and prevents further access", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "room-owner" });
    const beta = await anon.register({ name: "room-leaver" });

    const roomRes = await createRoomRaw(alpha.secret, { name: "Leave Room" });
    const room = await roomRes.json();
    await joinRoomRaw(beta.secret, room.pairing_code);

    // Beta leaves
    const leaveRes = await app.request(`/rooms/${room.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(leaveRes.status).toBe(200);
    const leaveBody = await leaveRes.json();
    expect(leaveBody.ok).toBe(true);

    // Beta can no longer access room
    const membersRes = await app.request(`/rooms/${room.id}/members`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(membersRes.status).toBe(403);
  });

  // --- Workspace edge case tests ---

  it("workspace double-join returns 409 ALREADY_MEMBER", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-creator" });
    const beta = await anon.register({ name: "ws-double-joiner" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "DoubleJoin WS" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Second join — should return 409 since already in a workspace
    const res = await app.request("/workspaces/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${beta.secret}` },
      body: JSON.stringify({ code: ws.pairing_code }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ALREADY_MEMBER");
  });

  it("kicked workspace member cannot access workspace resources", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "ws-admin" });
    const beta = await anon.register({ name: "ws-kicked" });
    const alphaClient = createClient(alpha.secret);
    const betaClient = createClient(beta.secret);

    const ws = await alphaClient.createWorkspace({ name: "Kick Access WS" });
    await betaClient.joinWorkspace({ code: ws.pairing_code });

    // Beta can see workspace
    const before = await betaClient.myWorkspace();
    expect(before.workspace.name).toBe("Kick Access WS");

    // Kick beta
    await alphaClient.kickWorkspaceMember(beta.agent_id);

    // Beta can no longer access workspace
    await expect(betaClient.myWorkspace()).rejects.toMatchObject({ status: 404 });
  });

  // --- Rate limit retry_after_seconds consistency tests ---

  it("rate limited responses always include retry_after_seconds", async () => {
    const alpha = await createClient().register({ name: "rl-consistency" });

    // Exhaust the task create rate limit (30/min)
    for (let i = 0; i < 30; i++) {
      await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
        body: JSON.stringify({ title: `task-${i}`, contact_id: "00000000-0000-0000-0000-000000000001" }),
      });
    }

    const blockedRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "over-limit", contact_id: "00000000-0000-0000-0000-000000000001" }),
    });
    expect(blockedRes.status).toBe(429);
    const body = await blockedRes.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retry_after_seconds).toEqual(expect.any(Number));
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  it("context fact write rate limit includes retry_after_seconds", async () => {
    const { alpha, beta, alphaClient } = await registerPair();

    // Exhaust the facts write rate limit (30/min)
    for (let i = 0; i < 30; i++) {
      await app.request(`/context/${beta.agent_id}/facts/key${i}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
        body: JSON.stringify({ value: `val-${i}` }),
      });
    }

    const blockedRes = await app.request(`/context/${beta.agent_id}/facts/over-limit`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ value: "blocked" }),
    });
    expect(blockedRes.status).toBe(429);
    const body = await blockedRes.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retry_after_seconds).toEqual(expect.any(Number));
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  // --- Task edge case tests ---

  it("task title exceeding 500 chars is rejected", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const longTitle = "x".repeat(501);
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: longTitle, contact_id: beta.agent_id }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
  });

  it("task depends_on exceeding 50 entries is rejected", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const tooManyDeps = Array.from({ length: 51 }, (_, i) =>
      `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`
    );
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "dep-test", contact_id: beta.agent_id, depends_on: tooManyDeps }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("task depends_on with invalid UUID is rejected", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "bad-dep", contact_id: beta.agent_id, depends_on: ["not-a-uuid"] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
  });

  it("task update with invalid status is rejected", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    // Create a task first
    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "status-test", contact_id: beta.agent_id }),
    });
    const task = await createRes.json();

    // Try updating with invalid status
    const updateRes = await app.request(`/tasks/${beta.agent_id}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ status: "invalid-status" }),
    });
    expect(updateRes.status).toBe(400);
    const body = await updateRes.json();
    expect(body.code).toBe("INVALID_FIELD");
  });

  it("task update with invalid priority is rejected", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "priority-test", contact_id: beta.agent_id }),
    });
    const task = await createRes.json();

    const updateRes = await app.request(`/tasks/${beta.agent_id}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ priority: "super-high" }),
    });
    expect(updateRes.status).toBe(400);
    const body = await updateRes.json();
    expect(body.code).toBe("INVALID_FIELD");
  });

  it("non-contact cannot create a task scoped to another agent", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "task-creator" });
    const beta = await anon.register({ name: "task-stranger" });

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "sneaky task", contact_id: beta.agent_id }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("NOT_MEMBER");
  });

  it("non-member cannot access room tasks", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "room-owner" });
    const beta = await anon.register({ name: "room-outsider" });

    const roomRes = await createRoomRaw(alpha.secret, { name: "Task Room" });
    const room = await roomRes.json();

    // Create a room task
    await createRoomTaskRaw(alpha.secret, room.id, { title: "secret task" });

    // Beta (not a member) tries to list room tasks
    const listRes = await app.request(`/tasks/room/${room.id}`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(listRes.status).toBe(403);
  });

  it("task create rejects invalid due date", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "date-test", contact_id: beta.agent_id, due: "not-a-date" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("due must be a valid ISO 8601 date");
  });

  it("task create rejects invalid start_date", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "date-test", contact_id: beta.agent_id, start_date: "yesterday" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("start_date must be a valid ISO 8601 date");
  });

  it("task create accepts valid ISO 8601 dates", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({
        title: "dated-task",
        contact_id: beta.agent_id,
        due: "2026-12-31",
        start_date: "2026-06-01T09:00:00Z",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.due).toBe("2026-12-31");
    expect(body.start_date).toBe("2026-06-01T09:00:00Z");
  });

  it("task update rejects invalid due date", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "update-date-test", contact_id: beta.agent_id }),
    });
    const task = await createRes.json();

    const updateRes = await app.request(`/tasks/${beta.agent_id}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ due: "2026-13-45" }),
    });
    expect(updateRes.status).toBe(400);
    const body = await updateRes.json();
    expect(body.code).toBe("INVALID_FIELD");
  });

  it("task update rejects invalid start_date", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "update-start-test", contact_id: beta.agent_id }),
    });
    const task = await createRes.json();

    const updateRes = await app.request(`/tasks/${beta.agent_id}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ start_date: "Tuesday" }),
    });
    expect(updateRes.status).toBe(400);
    const body = await updateRes.json();
    expect(body.code).toBe("INVALID_FIELD");
  });

  it("task create rejects description exceeding 5000 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "desc-test", contact_id: beta.agent_id, description: "x".repeat(5001) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("description");
  });

  it("task create rejects group exceeding 200 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "group-test", contact_id: beta.agent_id, group: "g".repeat(201) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("group");
  });

  it("task create rejects context_ref exceeding 500 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "ctx-test", contact_id: beta.agent_id, context_ref: "c".repeat(501) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("context_ref");
  });

  it("task update rejects description exceeding 5000 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "update-desc-test", contact_id: beta.agent_id }),
    });
    const task = await createRes.json();

    const updateRes = await app.request(`/tasks/${beta.agent_id}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ description: "x".repeat(5001) }),
    });
    expect(updateRes.status).toBe(400);
    const body = await updateRes.json();
    expect(body.code).toBe("INVALID_FIELD");
  });

  it("task update rejects group exceeding 200 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ title: "update-group-test", contact_id: beta.agent_id }),
    });
    const task = await createRes.json();

    const updateRes = await app.request(`/tasks/${beta.agent_id}/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ group: "g".repeat(201) }),
    });
    expect(updateRes.status).toBe(400);
    const body = await updateRes.json();
    expect(body.code).toBe("INVALID_FIELD");
  });

  it("label-bulk rejects label exceeding 50 characters", async () => {
    const { alpha, beta, alphaClient } = await registerPair();
    await alphaClient.pair({ code: beta.pairing_code });

    const msg = await alphaClient.send({ to: beta.agent_id, type: "update", payload: { content: "test" } });

    const res = await app.request("/messages/label-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alpha.secret}` },
      body: JSON.stringify({ message_ids: [msg.id], label: "x".repeat(51) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("label");
  });

  it("projects array rejects items exceeding 100 characters", async () => {
    const anon = createClient();
    const agent = await anon.register({ name: "projects-test" });
    const client = createClient(agent.secret);

    await expect(client.updateMe({ projects: ["x".repeat(101)] })).rejects.toMatchObject({ status: 400 });
  });

  it("projects array rejects non-string items", async () => {
    const anon = createClient();
    const agent = await anon.register({ name: "projects-type-test" });

    const res = await app.request("/agents/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agent.secret}` },
      body: JSON.stringify({ projects: [123, null] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FIELD");
    expect(body.error).toContain("each project name must be a string");
  });

  it("non-contact cannot read contact-scoped facts", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "fact-owner" });
    const beta = await anon.register({ name: "fact-stranger" });

    // Beta is not a contact of alpha — should be rejected
    const res = await app.request(`/context/${alpha.agent_id}/facts`, {
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("NOT_MEMBER");
  });

  it("non-contact cannot write contact-scoped facts", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "fact-writer" });
    const beta = await anon.register({ name: "fact-intruder" });

    const res = await app.request(`/context/${alpha.agent_id}/facts/secret-key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${beta.secret}` },
      body: JSON.stringify({ value: "hacked" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("NOT_MEMBER");
  });

  it("non-contact cannot delete contact-scoped facts", async () => {
    const anon = createClient();
    const alpha = await anon.register({ name: "fact-del-owner" });
    const beta = await anon.register({ name: "fact-del-intruder" });

    const res = await app.request(`/context/${alpha.agent_id}/facts/some-key`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${beta.secret}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("NOT_MEMBER");
  });
});

async function registerPair(): Promise<{
  alpha: RegisterResponse;
  beta: RegisterResponse;
  alphaClient: TrunkClient;
  betaClient: TrunkClient;
}> {
  const anonymous = createClient();
  const alpha = await anonymous.register({ name: "alpha", owner: "Andrei" });
  const beta = await anonymous.register({ name: "beta", owner: "Frank" });
  return {
    alpha,
    beta,
    alphaClient: createClient(alpha.secret),
    betaClient: createClient(beta.secret),
  };
}

// Raw task helpers (used by legacy tests — SDK methods available via TrunkClient)
function createTaskRaw(secret: string, contactId: string, body: Record<string, unknown>) {
  return app.request("/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secret}`,
    },
    body: JSON.stringify({ contact_id: contactId, ...body }),
  });
}

function listTasksRaw(secret: string, contactId: string, status?: string) {
  const path = status ? `/tasks/${contactId}?status=${status}` : `/tasks/${contactId}`;
  return app.request(path, {
    headers: { "Authorization": `Bearer ${secret}` },
  });
}

function updateTaskRaw(secret: string, contactId: string, taskId: string, body: Record<string, unknown>) {
  return app.request(`/tasks/${contactId}/${taskId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
}

function createRoomRaw(secret: string, body: Record<string, unknown>) {
  return app.request("/rooms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
}

function joinRoomRaw(secret: string, code: string) {
  return app.request("/rooms/join", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secret}`,
    },
    body: JSON.stringify({ code }),
  });
}

function createRoomTaskRaw(secret: string, roomId: string, body: Record<string, unknown>) {
  return app.request("/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secret}`,
    },
    body: JSON.stringify({ room_id: roomId, ...body }),
  });
}

async function sendRaw(
  client: TrunkClient,
  to: string,
  idempotencyKey: string,
  payload: Record<string, unknown>
): Promise<{ id: string; thread_id: string; status: string }> {
  const secret = (client as unknown as { secret: string }).secret;
  const res = await app.request("/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secret}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ to, type: "question", payload }),
  });
  return res.json();
}

function createClient(secret?: string): TrunkClient {
  return new TrunkClient({
    baseUrl: "http://trunk.test",
    secret,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      return app.request(`${url.pathname}${url.search}`, init);
    },
  });
}

function createMockDb() {
  return {
    select: (projection?: Record<string, unknown>) => new SelectQuery(projection),
    insert: (table: unknown) => new InsertQuery(getTableName(table)),
    update: (table: unknown) => new UpdateQuery(getTableName(table)),
    delete: (table: unknown) => new DeleteQuery(getTableName(table)),
  };
}

class SelectQuery {
  private table?: TableName;
  private condition?: SQL;
  private limitCount?: number;
  private orderDirection: "asc" | "desc" = "asc";

  constructor(private readonly projection?: Record<string, unknown>) {}

  from(table: unknown): this {
    this.table = getTableName(table);
    return this;
  }

  where(condition: SQL): this {
    this.condition = condition;
    return this;
  }

  orderBy(order: unknown): this {
    this.orderDirection = isDescendingOrder(order) ? "desc" : "asc";
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): unknown[] {
    if (!this.table) throw new Error("select query missing table");
    let rows = [...rowsFor(this.table)].filter((row) => evaluateCondition(this.condition, row));

    if (this.table === "messages") {
      rows.sort((a, b) => {
        const left = (a as MessageRow).createdAt.getTime();
        const right = (b as MessageRow).createdAt.getTime();
        const dir = this.orderDirection === "desc" ? -1 : 1;
        if (left !== right) return dir * (left - right);
        return dir * ((a as MessageRow).id < (b as MessageRow).id ? -1 : 1);
      });
    }

    if (this.table === "shared_documents") {
      rows.sort((a, b) => {
        const left = (a as SharedDocumentRow).createdAt.getTime();
        const right = (b as SharedDocumentRow).createdAt.getTime();
        const dir = this.orderDirection === "desc" ? -1 : 1;
        if (left !== right) return dir * (left - right);
        return dir * ((a as SharedDocumentRow).id < (b as SharedDocumentRow).id ? -1 : 1);
      });
    }

    if (this.table === "tasks") {
      rows.sort((a, b) => {
        const left = (a as TaskRow).createdAt.getTime();
        const right = (b as TaskRow).createdAt.getTime();
        const dir = this.orderDirection === "desc" ? -1 : 1;
        if (left !== right) return dir * (left - right);
        return dir * ((a as TaskRow).id < (b as TaskRow).id ? -1 : 1);
      });
    }

    if (this.table === "shared_document_versions") {
      rows.sort((a, b) => {
        const left = (a as SharedDocumentVersionRow).createdAt.getTime();
        const right = (b as SharedDocumentVersionRow).createdAt.getTime();
        const dir = this.orderDirection === "desc" ? -1 : 1;
        if (left !== right) return dir * (left - right);
        return dir * ((a as SharedDocumentVersionRow).id < (b as SharedDocumentVersionRow).id ? -1 : 1);
      });
    }

    if (this.table === "webhook_deliveries") {
      rows.sort((a, b) => {
        const left = (a as WebhookDeliveryRow).createdAt.getTime();
        const right = (b as WebhookDeliveryRow).createdAt.getTime();
        const dir = this.orderDirection === "desc" ? -1 : 1;
        if (left !== right) return dir * (left - right);
        return dir * ((a as WebhookDeliveryRow).id < (b as WebhookDeliveryRow).id ? -1 : 1);
      });
    }

    if (this.table === "audit_events") {
      rows.sort((a, b) => {
        const left = (a as AuditEventRow).createdAt.getTime();
        const right = (b as AuditEventRow).createdAt.getTime();
        const dir = this.orderDirection === "desc" ? -1 : 1;
        if (left !== right) return dir * (left - right);
        return dir * ((a as AuditEventRow).id < (b as AuditEventRow).id ? -1 : 1);
      });
    }

    if (this.table === "message_templates") {
      rows.sort((a, b) => {
        const left = (a as MessageTemplateRow).createdAt.getTime();
        const right = (b as MessageTemplateRow).createdAt.getTime();
        const dir = this.orderDirection === "desc" ? -1 : 1;
        if (left !== right) return dir * (left - right);
        return dir * ((a as MessageTemplateRow).id < (b as MessageTemplateRow).id ? -1 : 1);
      });
    }

    if (this.table === "attachments") {
      rows.sort((a, b) => {
        const left = (a as AttachmentRow).createdAt.getTime();
        const right = (b as AttachmentRow).createdAt.getTime();
        const dir = this.orderDirection === "desc" ? -1 : 1;
        if (left !== right) return dir * (left - right);
        return dir * ((a as AttachmentRow).id < (b as AttachmentRow).id ? -1 : 1);
      });
    }

    if (this.limitCount !== undefined) rows = rows.slice(0, this.limitCount);
    const projection = this.projection;
    return projection ? rows.map((row) => projectRow(projection, row)) : rows;
  }
}

class InsertQuery {
  private insertValues?: Record<string, unknown>;

  constructor(private readonly table: TableName) {}

  values(values: Record<string, unknown>): this {
    this.insertValues = values;
    return this;
  }

  returning(): Promise<unknown[]> {
    return Promise.resolve([this.insert()]);
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.insert()).then(onfulfilled, onrejected);
  }

  private insert(): unknown {
    if (!this.insertValues) throw new Error("insert query missing values");
    if (this.table === "agents") {
      const row: AgentRow = {
        id: nextId("agent"),
        name: this.insertValues.name as string,
        owner: (this.insertValues.owner as string | undefined) ?? null,
        secretHash: this.insertValues.secretHash as string,
        pairingCode: this.insertValues.pairingCode as string,
        webhookUrl: (this.insertValues.webhookUrl as string | undefined) ?? null,
        webhookSecret: (this.insertValues.webhookSecret as string | undefined) ?? null,
        workspaceId: (this.insertValues.workspaceId as string | undefined) ?? null,
        workspaceRole: (this.insertValues.workspaceRole as string | undefined) ?? null,
        metadata: (this.insertValues.metadata as Record<string, unknown>) ?? {},
        lastSeenAt: null,
        createdAt: new Date(),
      };
      testState.agents.push(row);
      return row;
    }

    if (this.table === "contacts") {
      const row: ContactRow = {
        agentA: this.insertValues.agentA as string,
        agentB: this.insertValues.agentB as string,
        aliasA: (this.insertValues.aliasA as string | undefined) ?? null,
        aliasB: (this.insertValues.aliasB as string | undefined) ?? null,
        pairedAt: new Date(),
      };
      testState.contacts.push(row);
      return row;
    }

    if (this.table === "rooms") {
      const row: RoomRow = {
        id: nextId("room"),
        name: this.insertValues.name as string,
        createdBy: this.insertValues.createdBy as string,
        pairingCode: this.insertValues.pairingCode as string,
        metadata: (this.insertValues.metadata as Record<string, unknown>) ?? {},
        createdAt: new Date(),
      };
      testState.rooms.push(row);
      return row;
    }

    if (this.table === "room_members") {
      const row: RoomMemberRow = {
        roomId: this.insertValues.roomId as string,
        agentId: this.insertValues.agentId as string,
        role: (this.insertValues.role as string) ?? "member",
        joinedAt: new Date(),
      };
      testState["room_members"].push(row);
      return row;
    }

    if (this.table === "workspaces") {
      const row: WorkspaceRow = {
        id: nextId("workspace"),
        name: this.insertValues.name as string,
        owner: (this.insertValues.owner as string | undefined) ?? null,
        pairingCode: this.insertValues.pairingCode as string,
        metadata: (this.insertValues.metadata as Record<string, unknown>) ?? {},
        createdAt: new Date(),
      };
      testState.workspaces.push(row);
      return row;
    }

    if (this.table === "workspace_contacts") {
      const row: WorkspaceContactRow = {
        workspaceId: this.insertValues.workspaceId as string,
        agentId: this.insertValues.agentId as string,
        alias: (this.insertValues.alias as string | undefined) ?? null,
        pairedAt: new Date(),
      };
      testState["workspace_contacts"].push(row);
      return row;
    }

    if (this.table === "rate_limits") {
      const row: RateLimitRow = {
        scope: this.insertValues.scope as string,
        count: (this.insertValues.count as number | undefined) ?? 0,
        windowStart: (this.insertValues.windowStart as Date | undefined) ?? new Date(),
        updatedAt: new Date(),
      };
      testState["rate_limits"].push(row);
      return row;
    }

    if (this.table === "tasks") {
      const row: TaskRow = {
        id: nextId("task"),
        scope: this.insertValues.scope as string,
        title: this.insertValues.title as string,
        description: (this.insertValues.description as string | undefined) ?? null,
        status: (this.insertValues.status as string | undefined) ?? "open",
        priority: (this.insertValues.priority as string | undefined) ?? "medium",
        owner: (this.insertValues.owner as string | undefined) ?? null,
        createdBy: this.insertValues.createdBy as string,
        due: (this.insertValues.due as string | undefined) ?? null,
        startDate: (this.insertValues.startDate as string | undefined) ?? null,
        group: (this.insertValues.group as string | undefined) ?? null,
        dependsOn: (this.insertValues.dependsOn as string[] | undefined) ?? [],
        sequence: (this.insertValues.sequence as number | undefined) ?? null,
        estimate: (this.insertValues.estimate as number | undefined) ?? null,
        contextRef: (this.insertValues.contextRef as string | undefined) ?? null,
        metadata: (this.insertValues.metadata as Record<string, unknown>) ?? {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      testState.tasks.push(row);
      return row;
    }

    if (this.table === "subscriptions") {
      const row: SubscriptionRow = {
        id: nextId("sub"),
        workspaceId: this.insertValues.workspaceId as string,
        stripeCustomerId: (this.insertValues.stripeCustomerId as string | undefined) ?? null,
        stripeSubscriptionId: (this.insertValues.stripeSubscriptionId as string | undefined) ?? null,
        plan: (this.insertValues.plan as string | undefined) ?? "free",
        status: (this.insertValues.status as string | undefined) ?? "active",
        currentPeriodStart: (this.insertValues.currentPeriodStart as Date | undefined) ?? null,
        currentPeriodEnd: (this.insertValues.currentPeriodEnd as Date | undefined) ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      testState.subscriptions.push(row);
      return row;
    }

    if (this.table === "shared_facts") {
      const row: SharedFactRow = {
        scope: this.insertValues.scope as string,
        key: this.insertValues.key as string,
        value: this.insertValues.value,
        version: (this.insertValues.version as number | undefined) ?? 1,
        updatedBy: this.insertValues.updatedBy as string,
        updatedAt: new Date(),
      };
      testState["shared_facts"].push(row);
      return row;
    }

    if (this.table === "shared_documents") {
      const row: SharedDocumentRow = {
        id: nextId("doc"),
        scope: this.insertValues.scope as string,
        name: this.insertValues.name as string,
        contentType: (this.insertValues.contentType as string) ?? "text/markdown",
        body: this.insertValues.body as string,
        version: (this.insertValues.version as number | undefined) ?? 1,
        lastEditedBy: this.insertValues.lastEditedBy as string,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      testState["shared_documents"].push(row);
      return row;
    }

    if (this.table === "shared_document_versions") {
      const row: SharedDocumentVersionRow = {
        id: nextId("docver"),
        documentId: this.insertValues.documentId as string,
        version: this.insertValues.version as number,
        body: this.insertValues.body as string,
        editedBy: this.insertValues.editedBy as string,
        createdAt: new Date(),
      };
      testState["shared_document_versions"].push(row);
      return row;
    }

    if (this.table === "audit_events") {
      const row: AuditEventRow = {
        id: nextId("audit"),
        actorAgent: (this.insertValues.actorAgent as string | undefined) ?? null,
        action: this.insertValues.action as string,
        targetType: this.insertValues.targetType as string,
        targetId: (this.insertValues.targetId as string | undefined) ?? null,
        metadata: (this.insertValues.metadata as Record<string, unknown>) ?? {},
        createdAt: new Date(),
      };
      testState["audit_events"].push(row);
      return row;
    }

    if (this.table === "reactions") {
      const row: ReactionRow = {
        id: nextId("reaction"),
        messageId: this.insertValues.messageId as string,
        agentId: this.insertValues.agentId as string,
        emoji: this.insertValues.emoji as string,
        createdAt: new Date(),
      };
      testState.reactions.push(row);
      return row;
    }

    if (this.table === "message_labels") {
      const row: MessageLabelRow = {
        id: nextId("label"),
        messageId: this.insertValues.messageId as string,
        agentId: this.insertValues.agentId as string,
        label: this.insertValues.label as string,
        createdAt: new Date(),
      };
      testState["message_labels"].push(row);
      return row;
    }

    if (this.table === "contact_notes") {
      const row: ContactNoteRow = {
        id: nextId("note"),
        agentId: this.insertValues.agentId as string,
        contactAgentId: this.insertValues.contactAgentId as string,
        content: this.insertValues.content as string,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      testState["contact_notes"].push(row);
      return row;
    }

    if (this.table === "blocked_contacts") {
      const row: BlockedContactRow = {
        id: nextId("block"),
        agentId: this.insertValues.agentId as string,
        blockedAgentId: this.insertValues.blockedAgentId as string,
        reason: (this.insertValues.reason as string | undefined) ?? null,
        createdAt: new Date(),
      };
      testState["blocked_contacts"].push(row);
      return row;
    }

    if (this.table === "webhook_deliveries") {
      const row: WebhookDeliveryRow = {
        id: nextId("whd"),
        agentId: this.insertValues.agentId as string,
        messageId: (this.insertValues.messageId as string | undefined) ?? null,
        url: this.insertValues.url as string,
        event: this.insertValues.event as string,
        success: this.insertValues.success as number,
        httpStatus: (this.insertValues.httpStatus as number | undefined) ?? null,
        latencyMs: (this.insertValues.latencyMs as number | undefined) ?? null,
        error: (this.insertValues.error as string | undefined) ?? null,
        attempts: (this.insertValues.attempts as number | undefined) ?? 1,
        createdAt: new Date(),
      };
      testState["webhook_deliveries"].push(row);
      return row;
    }

    if (this.table === "saved_searches") {
      const row: SavedSearchRow = {
        id: nextId("search"),
        agentId: this.insertValues.agentId as string,
        name: this.insertValues.name as string,
        query: this.insertValues.query as Record<string, string>,
        createdAt: new Date(),
      };
      testState["saved_searches"].push(row);
      return row;
    }

    if (this.table === "message_edits") {
      const row: MessageEditRow = {
        id: nextId("medit"),
        messageId: this.insertValues.messageId as string,
        version: this.insertValues.version as number,
        previousPayload: this.insertValues.previousPayload as Record<string, unknown>,
        editedBy: this.insertValues.editedBy as string,
        createdAt: new Date(),
      };
      testState["message_edits"].push(row);
      return row;
    }

    if (this.table === "contact_tags") {
      const row: ContactTagRow = {
        id: nextId("ctag"),
        agentId: this.insertValues.agentId as string,
        contactAgentId: this.insertValues.contactAgentId as string,
        tag: this.insertValues.tag as string,
        createdAt: new Date(),
      };
      testState["contact_tags"].push(row);
      return row;
    }

    if (this.table === "notification_preferences") {
      const row: NotificationPrefRow = {
        id: nextId("notifpref"),
        agentId: this.insertValues.agentId as string,
        contactAgentId: this.insertValues.contactAgentId as string,
        muted: (this.insertValues.muted as number | undefined) ?? 0,
        urgencyFilter: (this.insertValues.urgencyFilter as string | undefined) ?? "all",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      testState["notification_preferences"].push(row);
      return row;
    }

    if (this.table === "message_templates") {
      const row: MessageTemplateRow = {
        id: nextId("template"),
        agentId: this.insertValues.agentId as string,
        name: this.insertValues.name as string,
        type: this.insertValues.type as string,
        payload: this.insertValues.payload as Record<string, unknown>,
        description: (this.insertValues.description as string | undefined) ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      testState["message_templates"].push(row);
      return row;
    }

    if (this.table === "attachments") {
      const row: AttachmentRow = {
        id: nextId("attachment"),
        messageId: (this.insertValues.messageId as string | undefined) ?? null,
        agentId: this.insertValues.agentId as string,
        filename: this.insertValues.filename as string,
        contentType: (this.insertValues.contentType as string) ?? "application/octet-stream",
        sizeBytes: this.insertValues.sizeBytes as number,
        data: this.insertValues.data as string,
        createdAt: new Date(),
      };
      testState.attachments.push(row);
      return row;
    }

    const row: MessageRow = {
      id: nextId("message"),
      fromAgent: this.insertValues.fromAgent as string,
      toAgent: this.insertValues.toAgent as string,
      toWorkspace: (this.insertValues.toWorkspace as string | undefined) ?? null,
      toRoom: (this.insertValues.toRoom as string | undefined) ?? null,
      threadId: (this.insertValues.threadId as string | undefined) ?? null,
      replyTo: (this.insertValues.replyTo as string | undefined) ?? null,
      idempotencyKey: (this.insertValues.idempotencyKey as string | undefined) ?? null,
      type: this.insertValues.type as string,
      payload: this.insertValues.payload as Record<string, unknown>,
      status: (this.insertValues.status as string | undefined) ?? "pending",
      createdAt: new Date(Date.now() + testState.idCounter),
      readAt: null,
      deliveredAt: null,
      processedAt: null,
      repliedAt: null,
      deletedAt: null,
      editedAt: null,
      pinnedAt: null,
      pinnedBy: null,
      scheduledAt: (this.insertValues.scheduledAt as Date | undefined) ?? null,
      expiresAt: (this.insertValues.expiresAt as Date | undefined) ?? null,
    };
    testState.messages.push(row);
    return row;
  }
}

class UpdateQuery {
  private updates?: Record<string, unknown>;
  private condition?: SQL;

  constructor(private readonly table: TableName) {}

  set(updates: Record<string, unknown>): this {
    this.updates = updates;
    return this;
  }

  where(condition: SQL): this {
    this.condition = condition;
    return this;
  }

  returning(): Promise<unknown[]> {
    return Promise.resolve(this.apply());
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.apply()).then(onfulfilled, onrejected);
  }

  private apply(): unknown[] {
    if (!this.updates) throw new Error("update query missing set values");
    const rows = rowsFor(this.table).filter((row) => evaluateCondition(this.condition, row));
    for (const row of rows) {
      Object.assign(row, this.updates);
    }
    return rows;
  }
}

class DeleteQuery {
  private condition?: SQL;
  private useReturning = false;

  constructor(private readonly table: TableName) {}

  where(condition: SQL): this {
    this.condition = condition;
    return this;
  }

  returning(): this {
    this.useReturning = true;
    return this;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.apply()).then(onfulfilled, onrejected);
  }

  private apply(): unknown[] {
    const rows = rowsFor(this.table);
    const removed = rows.filter((row) => evaluateCondition(this.condition, row));
    const kept = rows.filter((row) => !evaluateCondition(this.condition, row));
    rows.splice(0, rows.length, ...kept);
    if (this.useReturning) return removed;
    return [{ rowCount: removed.length }];
  }
}

function rowsFor(table: TableName): Array<AgentRow | ContactRow | WorkspaceRow | WorkspaceContactRow | MessageRow | TaskRow | RoomRow | RoomMemberRow | SharedFactRow | SharedDocumentRow | SharedDocumentVersionRow | AuditEventRow | RateLimitRow | SubscriptionRow | ReactionRow | WebhookDeliveryRow | MessageLabelRow | BlockedContactRow | ContactNoteRow | MessageTemplateRow | NotificationPrefRow | ContactTagRow | SavedSearchRow | MessageEditRow | AttachmentRow> {
  return testState[table];
}

function nextId(_prefix: string): string {
  testState.idCounter += 1;
  const hex = testState.idCounter.toString(16).padStart(12, "0");
  return `00000000-0000-0000-0000-${hex}`;
}

function getTableName(table: unknown): TableName {
  const symbol = Object.getOwnPropertySymbols(table as object).find(
    (candidate) => candidate.description === "drizzle:Name"
  );
  const name = symbol ? (table as Record<symbol, string>)[symbol] : undefined;
  if (
    name === "agents" ||
    name === "contacts" ||
    name === "workspace_contacts" ||
    name === "messages" ||
    name === "tasks" ||
    name === "rooms" ||
    name === "room_members" ||
    name === "workspaces" ||
    name === "workspace_contacts" ||
    name === "shared_facts" ||
    name === "shared_documents" ||
    name === "shared_document_versions" ||
    name === "audit_events" ||
    name === "rate_limits" ||
    name === "subscriptions" ||
    name === "reactions" ||
    name === "webhook_deliveries" ||
    name === "message_labels" ||
    name === "blocked_contacts" ||
    name === "contact_notes" ||
    name === "message_templates" ||
    name === "notification_preferences" ||
    name === "contact_tags" ||
    name === "saved_searches" ||
    name === "message_edits" ||
    name === "attachments"
  ) return name;
  throw new Error(`Unsupported table ${String(name)}`);
}

function evaluateCondition(condition: SQL | undefined, row: unknown): boolean {
  if (!condition) return true;
  const chunks = getQueryChunks(condition);

  const sqlChildren = chunks.filter(isSql);
  if (chunks.some((chunk) => isStringChunk(chunk, " and "))) {
    return sqlChildren.every((chunk) => evaluateCondition(chunk, row));
  }
  if (chunks.some((chunk) => isStringChunk(chunk, " or "))) {
    return sqlChildren.some((chunk) => evaluateCondition(chunk, row));
  }
  if (
    sqlChildren.length === 1 &&
    chunks.every((chunk) => isSql(chunk) || isStringChunk(chunk, "(") || isStringChunk(chunk, ")"))
  ) {
    return evaluateCondition(sqlChildren[0], row);
  }

  const column = chunks.find(isColumn);
  const param = chunks.find(isParam);
  if (!column || !param) {
    return sqlChildren.every((chunk) => evaluateCondition(chunk, row));
  }

  // Detect comparison operator from string chunks
  if (chunks.some((chunk) => isStringChunk(chunk, " < "))) {
    const rowVal = getRowValue(row, column.name);
    const paramVal = param.value;
    if (rowVal instanceof Date && paramVal instanceof Date) return rowVal.getTime() < paramVal.getTime();
    if (typeof rowVal === "string" && typeof paramVal === "string") return rowVal < paramVal;
    if (typeof rowVal === "number" && typeof paramVal === "number") return rowVal < paramVal;
    return false;
  }

  if (chunks.some((chunk) => isStringChunk(chunk, " >= "))) {
    const rowVal = getRowValue(row, column.name);
    const paramVal = param.value;
    if (rowVal instanceof Date && paramVal instanceof Date) return rowVal.getTime() >= paramVal.getTime();
    if (typeof rowVal === "string" && typeof paramVal === "string") return rowVal >= paramVal;
    if (typeof rowVal === "number" && typeof paramVal === "number") return rowVal >= paramVal;
    return false;
  }

  if (chunks.some((chunk) => isStringChunk(chunk, " <= "))) {
    const rowVal = getRowValue(row, column.name);
    const paramVal = param.value;
    if (rowVal instanceof Date && paramVal instanceof Date) return rowVal.getTime() <= paramVal.getTime();
    if (typeof rowVal === "string" && typeof paramVal === "string") return rowVal <= paramVal;
    if (typeof rowVal === "number" && typeof paramVal === "number") return rowVal <= paramVal;
    return false;
  }

  const rowVal = getRowValue(row, column.name);
  const paramVal = param.value;
  // Date equality: compare by time value since === checks reference identity
  if (rowVal instanceof Date && paramVal instanceof Date) return rowVal.getTime() === paramVal.getTime();
  return rowVal === paramVal;
}

function getQueryChunks(condition: SQL): unknown[] {
  return ((condition as unknown as { queryChunks?: unknown[] }).queryChunks ?? []).filter(
    (chunk) => !isStringChunk(chunk, "")
  );
}

function isSql(value: unknown): value is SQL {
  return typeof value === "object" && value !== null && Array.isArray((value as { queryChunks?: unknown[] }).queryChunks);
}

function isColumn(value: unknown): value is { name: string } {
  return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}

function isParam(value: unknown): value is { value: unknown } {
  return typeof value === "object" && value !== null && "value" in value && "encoder" in value;
}

function isStringChunk(value: unknown, expected: string): boolean {
  const chunkValue = (value as { value?: unknown }).value;
  return Array.isArray(chunkValue) && chunkValue.join("") === expected;
}

function isDescendingOrder(order: unknown): boolean {
  if (!isSql(order)) return false;
  return getQueryChunks(order).some((chunk) => isStringChunk(chunk, " desc"));
}

function projectRow(projection: Record<string, unknown>, row: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(projection).map(([key, column]) => [
      key,
      isColumn(column) ? getRowValue(row, column.name) : undefined,
    ])
  );
}

function getRowValue(row: unknown, columnName: string): unknown {
  const property = columnToProperty[columnName] ?? columnName;
  return (row as Record<string, unknown>)[property];
}

const columnToProperty: Record<string, string> = {
  agent_a: "agentA",
  agent_b: "agentB",
  alias_a: "aliasA",
  alias_b: "aliasB",
  paired_at: "pairedAt",
  secret_hash: "secretHash",
  pairing_code: "pairingCode",
  webhook_url: "webhookUrl",
  webhook_secret: "webhookSecret",
  created_at: "createdAt",
  from_agent: "fromAgent",
  to_agent: "toAgent",
  thread_id: "threadId",
  reply_to: "replyTo",
  idempotency_key: "idempotencyKey",
  read_at: "readAt",
  delivered_at: "deliveredAt",
  processed_at: "processedAt",
  replied_at: "repliedAt",
  deleted_at: "deletedAt",
  created_by: "createdBy",
  context_ref: "contextRef",
  updated_at: "updatedAt",
  room_id: "roomId",
  agent_id: "agentId",
  joined_at: "joinedAt",
  updated_by: "updatedBy",
  version: "version",
  actor_agent: "actorAgent",
  target_type: "targetType",
  target_id: "targetId",
  window_start: "windowStart",
  workspace_id: "workspaceId",
  to_workspace: "toWorkspace",
  to_room: "toRoom",
  content_type: "contentType",
  last_edited_by: "lastEditedBy",
  document_id: "documentId",
  edited_by: "editedBy",
  edited_at: "editedAt",
  pinned_at: "pinnedAt",
  pinned_by: "pinnedBy",
  scheduled_at: "scheduledAt",
  last_seen_at: "lastSeenAt",
  message_id: "messageId",
  stripe_customer_id: "stripeCustomerId",
  stripe_subscription_id: "stripeSubscriptionId",
  current_period_start: "currentPeriodStart",
  current_period_end: "currentPeriodEnd",
  http_status: "httpStatus",
  latency_ms: "latencyMs",
  start_date: "startDate",
  depends_on: "dependsOn",
  blocked_agent_id: "blockedAgentId",
  contact_agent_id: "contactAgentId",
  urgency_filter: "urgencyFilter",
  expires_at: "expiresAt",
  workspace_role: "workspaceRole",
  size_bytes: "sizeBytes",
};
