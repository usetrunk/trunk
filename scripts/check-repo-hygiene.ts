import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const issues: string[] = [];

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

const tracked = trackedFiles();

const forbiddenTrackedPatterns = [
  { pattern: /^dist\//, reason: "root build output must not be tracked" },
  { pattern: /^cli\/dist\//, reason: "CLI build output must not be tracked" },
  { pattern: /^node_modules\//, reason: "dependencies must not be tracked" },
  { pattern: /(^|\/)__pycache__\//, reason: "Python cache output must not be tracked" },
  { pattern: /\.py[cod]$/, reason: "Python bytecode must not be tracked" },
  { pattern: /(^|\/)\.env($|\.)/, reason: "environment files must not be tracked, except .env.example" },
];

for (const file of tracked) {
  if (file === ".env.example") continue;
  for (const { pattern, reason } of forbiddenTrackedPatterns) {
    if (pattern.test(file)) {
      issues.push(`${file}: ${reason}`);
    }
  }
}

for (const nestedLockfile of ["cli/package-lock.json"]) {
  if (existsSync(nestedLockfile)) {
    issues.push(`${nestedLockfile}: use the root workspace lockfile instead`);
  }
}

const mcpProxyFiles = ["cli/src/index.ts"];
for (const file of mcpProxyFiles) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("TrunkClient")) {
    issues.push(`${file}: MCP proxy must use TrunkClient from the shared SDK`);
  }
  if (/fetch\(\s*`\$\{RELAY_URL\}/.test(source)) {
    issues.push(`${file}: MCP proxy must not hand-roll relay fetch calls`);
  }
}

const responseShapeFiles = [
  {
    file: "src/routes/messages.ts",
    required: ["messageToJson"],
    forbidden: [/messages:\s*page\.items(?!\.map\(messageToJson\))/],
    reason: "message list responses must use the shared public response mapper",
  },
  {
    file: "src/routes/tasks.ts",
    required: ["taskToJson"],
    forbidden: [/tasks:\s*page\.items(?!\.map\(taskToJson\))/],
    reason: "task list responses must use the shared public response mapper",
  },
  {
    file: "src/mcp/server.ts",
    required: ["taskToJson"],
    forbidden: [/tasks:\s*page\.items\.map\(\s*\w+\s*=>\s*\(\s*\{/],
    reason: "direct MCP task responses must use the shared task response mapper",
  },
];

for (const { file, required, forbidden, reason } of responseShapeFiles) {
  const source = readFileSync(file, "utf8");
  for (const token of required) {
    if (!source.includes(token)) {
      issues.push(`${file}: ${reason}`);
    }
  }
  for (const pattern of forbidden) {
    if (pattern.test(source)) {
      issues.push(`${file}: ${reason}`);
    }
  }
}

const adapterFiles = ["adapters/email/index.ts", "adapters/intercom/index.ts", "adapters/slack/index.ts"];
for (const file of adapterFiles) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("TrunkClient")) {
    issues.push(`${file}: Trunk-facing adapter calls must use TrunkClient from the shared SDK`);
  }
  if (/fetch\(\s*`\$\{TRUNK_RELAY\}/.test(source)) {
    issues.push(`${file}: adapter must not hand-roll Trunk relay fetch calls`);
  }
}

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(issue);
  }
  process.exit(1);
}

console.log("Repository hygiene verified");
