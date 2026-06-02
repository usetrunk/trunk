import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import app from "../src/app.js";
import { createTrunkInboxNode, createTrunkSendNode } from "../src/adapters/langgraph.js";
import { notifyPushWorker } from "../src/lib/webhook.js";
import { TrunkApiError, TrunkClient, signWebhookPayload, verifyWebhookSignature, type RegisterResponse } from "../src/sdk/index.js";

type AgentRow = {
  id: string;
  name: string;
  owner?: string | null;
  secretHash: string;
  pairingCode: string;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  workspaceId?: string | null;
  metadata: Record<string, unknown>;
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
  | "audit_events"
  | "rate_limits";

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
  "audit_events": [] as AuditEventRow[],
  "rate_limits": [] as RateLimitRow[],
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
    testState["audit_events"].length = 0;
    testState["rate_limits"].length = 0;
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
      thread_id: "thread-explicit-123",
      payload: { content: "Use this thread." },
    });

    expect(sent.thread_id).toBe("thread-explicit-123");
    await expect(betaClient.thread("thread-explicit-123")).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: sent.id, threadId: "thread-explicit-123" })],
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

    const dashboard = await app.request(`/dashboard?secret=${alpha.secret}`);
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
    expect(body).not.toContain("<form");
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
        return this.orderDirection === "desc" ? right - left : left - right;
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
        metadata: {},
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
        contextRef: (this.insertValues.contextRef as string | undefined) ?? null,
        metadata: (this.insertValues.metadata as Record<string, unknown>) ?? {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      testState.tasks.push(row);
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

    const row: MessageRow = {
      id: nextId("message"),
      fromAgent: this.insertValues.fromAgent as string,
      toAgent: this.insertValues.toAgent as string,
      toWorkspace: (this.insertValues.toWorkspace as string | undefined) ?? null,
      threadId: (this.insertValues.threadId as string | undefined) ?? null,
      replyTo: (this.insertValues.replyTo as string | undefined) ?? null,
      idempotencyKey: (this.insertValues.idempotencyKey as string | undefined) ?? null,
      type: this.insertValues.type as string,
      payload: this.insertValues.payload as Record<string, unknown>,
      status: "pending",
      createdAt: new Date(Date.now() + testState.idCounter),
      readAt: null,
      deliveredAt: null,
      processedAt: null,
      repliedAt: null,
      deletedAt: null,
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

  constructor(private readonly table: TableName) {}

  where(condition: SQL): this {
    this.condition = condition;
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
    const kept = rows.filter((row) => !evaluateCondition(this.condition, row));
    const removed = rows.length - kept.length;
    rows.splice(0, rows.length, ...kept);
    return [{ rowCount: removed }];
  }
}

function rowsFor(table: TableName): Array<AgentRow | ContactRow | WorkspaceRow | WorkspaceContactRow | MessageRow | TaskRow | RoomRow | RoomMemberRow | SharedFactRow | AuditEventRow | RateLimitRow> {
  return testState[table];
}

function nextId(prefix: string): string {
  testState.idCounter += 1;
  return `${prefix}_${testState.idCounter}`;
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
    name === "audit_events" ||
    name === "rate_limits"
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
  return getRowValue(row, column.name) === param.value;
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
};
