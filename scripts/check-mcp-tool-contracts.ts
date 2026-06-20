import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { MCP_TOOL_CONTRACTS, type McpSurface } from "../src/mcp/tool-manifest.js";

const SURFACE_FILES: Record<McpSurface, string> = {
  server: "src/mcp/server.ts",
  cli: "cli/src/index.ts",
  worker: "worker/src/mcp.ts",
};

const TOOL_REGISTRATION_RE = /server\.tool\(\s*\n?\s*["']([^"']+)["']/g;

type Issue = {
  surface: McpSurface;
  tool: string;
  message: string;
};

function extractToolNames(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(TOOL_REGISTRATION_RE)].map((match) => match[1]);
}

function extractToolBlocks(source: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;

  while (true) {
    const start = source.indexOf("server.tool(", cursor);
    if (start === -1) break;

    let depth = 1;
    let quote: string | null = null;
    let escaped = false;
    let index = start + "server.tool(".length;

    for (; index < source.length; index++) {
      const char = source[index];

      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }

      if (char === "\"" || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") depth++;
      else if (char === ")") {
        depth--;
        if (depth === 0) {
          blocks.push(source.slice(start, index + 1));
          cursor = index + 1;
          break;
        }
      }
    }

    if (index >= source.length) break;
  }

  return blocks;
}

function splitTopLevelArgs(block: string): string[] {
  const inner = block.slice(block.indexOf("(") + 1, -1);
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];

    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      args.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }

  args.push(inner.slice(start).trim());
  return args;
}

function extractTopLevelObjectKeys(source: string): string[] {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];

  const inner = trimmed.slice(1, -1);
  const keys = new Set<string>();
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  function readKey(part: string) {
    const match = part.match(/^\s*([A-Za-z0-9_]+)\s*:/);
    if (match) keys.add(match[1]);
  }

  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];

    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      readKey(inner.slice(start, index));
      start = index + 1;
    }
  }

  readKey(inner.slice(start));
  return sorted(keys);
}

function extractToolSchemaKeys(file: string): Map<string, string[]> {
  const source = readFileSync(file, "utf8");
  const result = new Map<string, string[]>();

  for (const block of extractToolBlocks(source)) {
    const args = splitTopLevelArgs(block);
    const name = args[0]?.match(/["']([^"']+)["']/)?.[1];
    if (!name) continue;

    const schemaArg = args.length === 3 ? args[2] : args[1];
    result.set(name, extractTopLevelObjectKeys(schemaArg));
  }

  return result;
}

function extractStringLiteral(source: string): string | null {
  const trimmed = source.trim();
  const match = trimmed.match(/^(["'`])([\s\S]*)\1$/);
  return match ? match[2].replace(/\s+/g, " ").trim() : null;
}

function extractToolDescriptions(file: string): Map<string, string> {
  const source = readFileSync(file, "utf8");
  const result = new Map<string, string>();

  for (const block of extractToolBlocks(source)) {
    const args = splitTopLevelArgs(block);
    const name = extractStringLiteral(args[0] ?? "");
    const description = extractStringLiteral(args[1] ?? "");
    if (!name || !description) continue;

    result.set(name, description);
  }

  return result;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

const expectedBySurface = new Map<McpSurface, Set<string>>();
for (const surface of Object.keys(SURFACE_FILES) as McpSurface[]) {
  expectedBySurface.set(surface, new Set());
}

const seenContracts = new Set<string>();
const contractIssues: string[] = [];
for (const contract of MCP_TOOL_CONTRACTS) {
  if (seenContracts.has(contract.name)) {
    contractIssues.push(`Duplicate MCP tool contract: ${contract.name}`);
  }
  seenContracts.add(contract.name);

  const contractSurfaces = [...contract.surfaces];
  if (contractSurfaces.length === 0) {
    contractIssues.push(`MCP tool contract has no surfaces: ${contract.name}`);
  }

  for (const surface of contractSurfaces) {
    expectedBySurface.get(surface)?.add(contract.name);
  }
}

const issues: Issue[] = [];
const schemaKeysBySurface = new Map<McpSurface, Map<string, string[]>>();
const descriptionsBySurface = new Map<McpSurface, Map<string, string>>();
for (const [surface, file] of Object.entries(SURFACE_FILES) as [McpSurface, string][]) {
  const actualNames = extractToolNames(file);
  const actual = new Set(actualNames);
  const expected = expectedBySurface.get(surface) ?? new Set<string>();
  schemaKeysBySurface.set(surface, extractToolSchemaKeys(file));
  descriptionsBySurface.set(surface, extractToolDescriptions(file));

  for (const name of sorted(actual)) {
    if (!expected.has(name)) {
      issues.push({ surface, tool: name, message: "registered but not declared in src/mcp/tool-manifest.ts" });
    }
  }

  for (const name of sorted(expected)) {
    if (!actual.has(name)) {
      issues.push({ surface, tool: name, message: `declared for ${surface} but missing from ${relative(process.cwd(), file)}` });
    }
  }

  const duplicates = actualNames.filter((name, index) => actualNames.indexOf(name) !== index);
  for (const name of sorted(new Set(duplicates))) {
    issues.push({ surface, tool: name, message: "registered more than once" });
  }
}

for (const contract of MCP_TOOL_CONTRACTS) {
  const keySets = new Map<string, McpSurface[]>();
  for (const surface of contract.surfaces) {
    const keys = schemaKeysBySurface.get(surface)?.get(contract.name) ?? [];
    const fingerprint = keys.join(",");
    keySets.set(fingerprint, [...(keySets.get(fingerprint) ?? []), surface]);
  }

  if (keySets.size > 1) {
    const details = [...keySets.entries()]
      .map(([fingerprint, surfaces]) => `${surfaces.join("+")}: ${fingerprint || "(no input schema)"}`)
      .join("; ");
    issues.push({ surface: contract.surfaces[0], tool: contract.name, message: `input schema keys drift across surfaces: ${details}` });
  }

  const descriptionSets = new Map<string, McpSurface[]>();
  for (const surface of contract.surfaces) {
    if (surface === "cli") continue;
    const description = descriptionsBySurface.get(surface)?.get(contract.name);
    if (!description) continue;
    descriptionSets.set(description, [...(descriptionSets.get(description) ?? []), surface]);
  }

  if (descriptionSets.size > 1) {
    const details = [...descriptionSets.entries()]
      .map(([description, surfaces]) => `${surfaces.join("+")}: ${description || "(no description)"}`)
      .join("; ");
    issues.push({ surface: contract.surfaces[0], tool: contract.name, message: `description drifts across surfaces: ${details}` });
  }
}

if (contractIssues.length > 0 || issues.length > 0) {
  for (const issue of contractIssues) {
    console.error(issue);
  }
  for (const issue of issues) {
    console.error(`[${issue.surface}] ${issue.tool}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(`MCP tool contracts verified: ${MCP_TOOL_CONTRACTS.length} tools across ${Object.keys(SURFACE_FILES).length} surfaces`);
