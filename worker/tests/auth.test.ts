import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index.js";

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
});

function createEnv(): Env {
  return {
    RELAY_URL: "https://relay.test",
    PUSH_SECRET: "push-secret",
    AGENT_CONNECTION: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response("upgraded")),
      })),
    },
  } as unknown as Env;
}
