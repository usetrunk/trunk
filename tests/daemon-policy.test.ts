import { describe, expect, it } from "vitest";
import { formatExecutionReply } from "../cli/src/daemon/executor.js";
import { classifyCommand, matchesPattern, type DaemonPolicy } from "../cli/src/daemon/policy.js";

const policy: DaemonPolicy = {
  auto_execute: ["status *", "check *", "git status"],
  confirm: ["deploy *", "push *", "merge *"],
  block: ["rm *", "delete *", "drop *", "git reset --hard *"],
};

describe("daemon execution policy", () => {
  it("blocks destructive commands before checking broader patterns", () => {
    expect(classifyCommand("rm -rf dist", policy)).toBe("block");
    expect(classifyCommand("git reset --hard origin/main", policy)).toBe("block");
  });

  it("auto-executes read-only operational checks", () => {
    expect(classifyCommand("status superkey deploy", policy)).toBe("auto_execute");
    expect(classifyCommand("git status", policy)).toBe("auto_execute");
  });

  it("requires confirmation for deploy and unknown commands", () => {
    expect(classifyCommand("deploy koji", policy)).toBe("confirm");
    expect(classifyCommand("fix the customer bug", policy)).toBe("confirm");
  });

  it("matches wildcard policy patterns case-insensitively", () => {
    expect(matchesPattern("Deploy Koji", "deploy *")).toBe(true);
    expect(matchesPattern("deploy", "deploy *")).toBe(false);
  });

  it("formats execution results without dropping stderr", () => {
    expect(formatExecutionReply({ ok: false, stdout: "partial", stderr: "boom", exitCode: 2 })).toContain("stderr:\nboom");
  });
});
