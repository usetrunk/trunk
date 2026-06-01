import { describe, expect, it } from "vitest";
import { resolveTargetAgent } from "../adapters/email/index.js";
import { resolveSlackTarget } from "../adapters/slack/index.js";

describe("bridge adapter routing", () => {
  it("resolves email recipients from explicit override first", () => {
    expect(resolveTargetAgent("support@example.com", "agent_override", { "support@example.com": "agent_a" })).toBe("agent_override");
  });

  it("normalizes email recipient headers before map lookup", () => {
    expect(resolveTargetAgent("Support <Support@Example.com>", null, { "support@example.com": "agent_a" })).toBe("agent_a");
  });

  it("resolves Slack thread mappings before channel mappings", () => {
    expect(resolveSlackTarget("C123", "1710000.0001", {
      "C123": "agent_channel",
      "C123:1710000.0001": "agent_thread",
    })).toBe("agent_thread");
  });

  it("falls back to Slack channel mapping", () => {
    expect(resolveSlackTarget("C123", undefined, { "C123": "agent_channel" })).toBe("agent_channel");
  });
});
