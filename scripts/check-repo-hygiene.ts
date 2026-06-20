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
  { pattern: /^worker\/dist\//, reason: "worker build output must not be tracked" },
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

for (const nestedLockfile of ["cli/package-lock.json", "worker/package-lock.json"]) {
  if (existsSync(nestedLockfile)) {
    issues.push(`${nestedLockfile}: use the root workspace lockfile instead`);
  }
}

const mcpProxyFiles = ["cli/src/index.ts", "worker/src/mcp.ts"];
for (const file of mcpProxyFiles) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("TrunkClient")) {
    issues.push(`${file}: MCP proxy must use TrunkClient from the shared SDK`);
  }
  if (/fetch\(\s*`\$\{RELAY_URL\}/.test(source)) {
    issues.push(`${file}: MCP proxy must not hand-roll relay fetch calls`);
  }
}

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(issue);
  }
  process.exit(1);
}

console.log("Repository hygiene verified");
