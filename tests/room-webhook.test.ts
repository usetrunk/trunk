import { describe, it, expect } from "vitest";
import { isSlackWebhook, formatSlackText } from "../src/lib/room-webhook.js";

describe("room webhook Slack formatting", () => {
  it("detects Slack incoming webhook hosts by hostname, not substring", () => {
    expect(isSlackWebhook("https://hooks.slack.com/services/T/B/xyz")).toBe(true);
    expect(isSlackWebhook("https://example.com/webhook")).toBe(false);
    // A path that merely contains the host must not match.
    expect(isSlackWebhook("https://evil.com/hooks.slack.com")).toBe(false);
    expect(isSlackWebhook("not a url")).toBe(false);
  });

  it("formats a task as Slack mrkdwn text", () => {
    const text = formatSlackText("task.created", {
      id: "t1",
      title: "Build is broken",
      description: "CI failed on main",
      status: "open",
      priority: "critical",
      created_by: "agent-1",
      group: "human",
      scope: "room:r1",
    });
    expect(text).toContain("🚨");
    expect(text).toContain("*critical*");
    expect(text).toContain("[human]");
    expect(text).toContain("Build is broken");
    expect(text).toContain("CI failed on main");
    expect(text).toContain("task.created");
    expect(text).toContain("status: open");
  });

  it("truncates long descriptions", () => {
    const text = formatSlackText("task.updated", {
      id: "t2",
      title: "T",
      description: "x".repeat(500),
      status: "open",
      priority: "low",
      created_by: "a",
      scope: "room:r1",
    });
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(400);
  });
});
