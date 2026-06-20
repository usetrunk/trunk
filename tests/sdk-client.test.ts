import { describe, expect, it } from "vitest";
import { TrunkApiError, TrunkClient } from "../src/sdk/index.js";

describe("TrunkClient raw requests", () => {
  it("uses shared auth and idempotency handling for generic proxy calls", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({ id: "msg-1" });
    };
    const client = new TrunkClient({ baseUrl: "https://trunk.test/", secret: "secret-1", fetch: fetchImpl });

    const result = await client.raw("/messages", {
      method: "POST",
      body: { to: "agent-2", type: "update", payload: { content: "hi" } },
      idempotencyKey: "fixed-key",
    });

    expect(result).toEqual({ id: "msg-1" });
    expect(calls[0]?.input).toBe("https://trunk.test/messages");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ to: "agent-2", type: "update", payload: { content: "hi" } }));

    const headers = calls[0]?.init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer secret-1");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Idempotency-Key")).toBe("fixed-key");
  });

  it("can make unauthenticated generic proxy calls", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({ ok: true });
    };
    const client = new TrunkClient({ baseUrl: "https://trunk.test", fetch: fetchImpl });

    await client.raw("/agents/register", { method: "POST", body: { name: "Vesper" }, auth: false });

    const headers = calls[0]?.init?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
  });

  it("preserves API error body for proxy surfaces", async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ error: "Invalid token", code: "UNAUTHORIZED" }, { status: 401 });
    const client = new TrunkClient({ baseUrl: "https://trunk.test", secret: "bad", fetch: fetchImpl });

    await expect(client.raw("/agents/me")).rejects.toMatchObject({
      status: 401,
      body: { error: "Invalid token", code: "UNAUTHORIZED" },
    } satisfies Partial<TrunkApiError>);
  });
});
