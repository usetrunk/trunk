import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import app from "../src/app.js";
import { TrunkApiError, TrunkClient, type RegisterResponse } from "../src/sdk/index.js";

type AgentRow = {
  id: string;
  name: string;
  owner?: string | null;
  secretHash: string;
  pairingCode: string;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
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
  threadId: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: Date;
  readAt?: Date | null;
  repliedAt?: Date | null;
};

type TableName = "agents" | "contacts" | "messages";

const testState = vi.hoisted(() => ({
  agents: [] as AgentRow[],
  contacts: [] as ContactRow[],
  messages: [] as MessageRow[],
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
    testState.idCounter = 0;
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

    expect(sent.status).toBe("pending");
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({
      id: sent.id,
      threadId: sent.thread_id,
      type: "question",
      status: "pending",
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
    const readInbox = await betaClient.inbox({ status: "read" });
    expect(readInbox.messages).toHaveLength(1);
    expect(readInbox.messages[0]).toMatchObject({
      id: sent.id,
      status: "read",
      readAt: expect.any(String),
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

  it("reports missing auth and invalid tokens through SDK auth behavior", async () => {
    await createClient().register({ name: "alpha" });

    await expect(createClient().me()).rejects.toThrow("TrunkClient requires a secret");
    await expect(createClient("not-a-real-secret").me()).rejects.toMatchObject({
      status: 401,
      message: "Invalid token",
    });
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
        status: "pending",
      });
    }
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

    const row: MessageRow = {
      id: nextId("message"),
      fromAgent: this.insertValues.fromAgent as string,
      toAgent: this.insertValues.toAgent as string,
      threadId: (this.insertValues.threadId as string | undefined) ?? null,
      type: this.insertValues.type as string,
      payload: this.insertValues.payload as Record<string, unknown>,
      status: "pending",
      createdAt: new Date(Date.now() + testState.idCounter),
      readAt: null,
      repliedAt: null,
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

function rowsFor(table: TableName): Array<AgentRow | ContactRow | MessageRow> {
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
  if (name === "agents" || name === "contacts" || name === "messages") return name;
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
  read_at: "readAt",
  replied_at: "repliedAt",
};
