import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { AgentConnection, type Env } from "../src/index.js";

describe("push worker authentication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects WebSocket connect requests without a secret", async () => {
    const env = createEnv();

    const res = await worker.fetch(new Request("https://push.test/connect/agent-1"), env);

    expect(res.status).toBe(401);
    expect(env.AGENT_CONNECTION.get).not.toHaveBeenCalled();
  });

  it("rejects WebSocket connect requests when relay auth rejects the secret", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));
    const env = createEnv();

    const res = await worker.fetch(new Request("https://push.test/connect/agent-1?secret=wrong"), env);

    expect(res.status).toBe(401);
    expect(env.AGENT_CONNECTION.get).not.toHaveBeenCalled();
  });

  it("rejects WebSocket connect requests when the secret belongs to another agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agent_id: "agent-2" })));
    const env = createEnv();

    const res = await worker.fetch(new Request("https://push.test/connect/agent-1?secret=valid"), env);

    expect(res.status).toBe(401);
    expect(env.AGENT_CONNECTION.get).not.toHaveBeenCalled();
  });

  it("returns service unavailable when relay auth is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    const env = createEnv();

    const res = await worker.fetch(new Request("https://push.test/connect/agent-1?secret=valid"), env);

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Relay authentication unavailable");
    expect(env.AGENT_CONNECTION.get).not.toHaveBeenCalled();
  });

  it("delegates validated WebSocket connect requests to the agent durable object", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agent_id: "agent-1" })));
    const stubFetch = vi.fn(async () => new Response("upgraded"));
    const env = createEnv(stubFetch);

    const res = await worker.fetch(new Request("https://push.test/connect/agent-1?secret=valid", {
      headers: { Upgrade: "websocket" },
    }), env);

    expect(res.status).toBe(200);
    expect(env.AGENT_CONNECTION.idFromName).toHaveBeenCalledWith("agent-1");
    expect(stubFetch).toHaveBeenCalledOnce();
  });

  it("rejects notify calls without the push secret", async () => {
    const env = createEnv();

    const res = await worker.fetch(new Request("https://push.test/notify/agent-1", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
      body: JSON.stringify({ event: "message" }),
    }), env);

    expect(res.status).toBe(401);
    expect(env.AGENT_CONNECTION.get).not.toHaveBeenCalled();
  });

  it("forwards authorized notify calls to the agent durable object", async () => {
    const stubFetch = vi.fn(async () => Response.json({ delivered: 2, total_connections: 2 }));
    const env = createEnv(stubFetch);

    const res = await worker.fetch(new Request("https://push.test/notify/agent-1", {
      method: "POST",
      headers: {
        Authorization: "Bearer push-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event: "message.received", id: "msg-1" }),
    }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: 2, total_connections: 2 });
    expect(env.AGENT_CONNECTION.idFromName).toHaveBeenCalledWith("agent-1");
    expect(stubFetch).toHaveBeenCalledOnce();
  });
});

describe("agent durable object delivery", () => {
  it("requires WebSocket upgrades for connect requests", async () => {
    const state = createDurableObjectState([]);
    const agent = new AgentConnection(state);

    const res = await agent.fetch(new Request("http://internal/connect"));

    expect(res.status).toBe(426);
    expect(state.acceptWebSocket).not.toHaveBeenCalled();
  });

  it("delivers notify payloads to active sockets and skips failed sends", async () => {
    const goodSocket = createSocket();
    const deadSocket = createSocket({ throwOnSend: true });
    const state = createDurableObjectState([goodSocket, deadSocket]);
    const agent = new AgentConnection(state);

    const res = await agent.fetch(new Request("http://internal/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "message.received", id: "msg-1" }),
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: 1, total_connections: 2 });
    expect(goodSocket.send).toHaveBeenCalledWith(JSON.stringify({ event: "message.received", id: "msg-1" }));
    expect(deadSocket.send).toHaveBeenCalledOnce();
  });

  it("responds to ping messages with pong", () => {
    const socket = createSocket();
    const agent = new AgentConnection(createDurableObjectState([socket]));

    agent.webSocketMessage(socket as unknown as WebSocket, "ping");

    expect(socket.send).toHaveBeenCalledWith("pong");
  });

  it("removes closed and errored sockets from the in-memory connection set", () => {
    const socket = createSocket();
    const agent = new AgentConnection(createDurableObjectState([socket]));

    expect((agent as unknown as { connections: Set<WebSocket> }).connections.size).toBe(1);

    agent.webSocketClose(socket as unknown as WebSocket, 1000, "done");
    expect((agent as unknown as { connections: Set<WebSocket> }).connections.size).toBe(0);

    (agent as unknown as { connections: Set<WebSocket> }).connections.add(socket as unknown as WebSocket);
    agent.webSocketError(socket as unknown as WebSocket, new Error("boom"));
    expect((agent as unknown as { connections: Set<WebSocket> }).connections.size).toBe(0);
  });
});

function createEnv(stubFetch = vi.fn(async () => new Response("ok"))): Env {
  return {
    RELAY_URL: "https://relay.test",
    PUSH_SECRET: "push-secret",
    AGENT_CONNECTION: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({
        fetch: stubFetch,
      })),
    },
  } as unknown as Env;
}

function createDurableObjectState(sockets: Array<Pick<WebSocket, "send">>) {
  return {
    getWebSockets: vi.fn(() => sockets),
    acceptWebSocket: vi.fn(),
  } as unknown as DurableObjectState & {
    getWebSockets: ReturnType<typeof vi.fn>;
    acceptWebSocket: ReturnType<typeof vi.fn>;
  };
}

function createSocket(options: { throwOnSend?: boolean } = {}) {
  return {
    send: vi.fn(() => {
      if (options.throwOnSend) {
        throw new Error("closed");
      }
    }),
  };
}
