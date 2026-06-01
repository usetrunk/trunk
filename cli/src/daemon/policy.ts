import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PolicyDecision = "auto_execute" | "confirm" | "block";

export type DaemonPolicy = {
  auto_execute: string[];
  confirm: string[];
  block: string[];
};

export const DEFAULT_POLICY: DaemonPolicy = {
  auto_execute: ["status *", "check *", "list *", "show *", "what branch *", "git status"],
  confirm: ["deploy *", "push *", "merge *", "create pr *", "open pr *", "commit *"],
  block: ["rm *", "delete *", "drop *", "reset --hard *", "git reset --hard *"],
};

export const DEFAULT_POLICY_FILE = join(homedir(), ".trunk", "policy.json");

export function loadPolicy(policyFile = DEFAULT_POLICY_FILE): DaemonPolicy {
  if (!existsSync(policyFile)) return DEFAULT_POLICY;

  const parsed = JSON.parse(readFileSync(policyFile, "utf-8")) as Partial<DaemonPolicy>;
  return {
    auto_execute: parsed.auto_execute ?? DEFAULT_POLICY.auto_execute,
    confirm: parsed.confirm ?? DEFAULT_POLICY.confirm,
    block: parsed.block ?? DEFAULT_POLICY.block,
  };
}

export function classifyCommand(command: string, policy: DaemonPolicy = DEFAULT_POLICY): PolicyDecision {
  const normalized = normalize(command);
  if (matchesAny(normalized, policy.block)) return "block";
  if (matchesAny(normalized, policy.auto_execute)) return "auto_execute";
  if (matchesAny(normalized, policy.confirm)) return "confirm";
  return "confirm";
}

function matchesAny(command: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(command, pattern));
}

export function matchesPattern(command: string, pattern: string): boolean {
  const normalizedCommand = normalize(command);
  const normalizedPattern = normalize(pattern);
  const escaped = normalizedPattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(normalizedCommand);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
