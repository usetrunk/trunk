#!/usr/bin/env node
/**
 * Poll-based agent harness daemon.
 *
 * Spawns each configured agent in a zellij tab on a timer. Every agent is
 * woken on startup and then re-checked on its poll interval; an agent that is
 * still running is skipped until it finishes. Agents inspect the room for
 * tasks that need attention and act on them.
 *
 * Usage:
 *   trunk harness daemon [--config ~/.trunk/agents.json]
 */

import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const STATE_DIR = join(homedir(), ".trunk");
const SESSION_NAME = "trunk-harness";

type AgentConfig = {
  name: string;
  profile: string;
  cwd: string;
  prompt: string;
  workspace?: string;
  model?: string;
  loop?: boolean;
  loopDelay?: number;
  runtime?: "claude" | "goose";
  gooseProvider?: string;
  gooseModel?: string;
  maxTurns?: number;
  pollInterval?: number;    // seconds between polls (default: 120)
};

type HarnessConfig = {
  workspace?: string;
  agents: AgentConfig[];
};

// --- Agent spawning ---

const activeAgents = new Map<string, boolean>(); // profile -> running

function findBin(name: string, extraPaths: string[] = []): string | null {
  try {
    return execSync(`which ${name}`, { encoding: "utf-8" }).trim();
  } catch {
    for (const p of extraPaths) {
      if (existsSync(p)) return p;
    }
    return null;
  }
}

const CLAUDE_BIN = findBin("claude", [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  join(homedir(), ".npm-global/bin/claude"),
  join(homedir(), ".local/bin/claude"),
]) || "claude";

const GOOSE_BIN = findBin("goose", ["/opt/homebrew/bin/goose", "/usr/local/bin/goose"]) || "goose";
const ZELLIJ_BIN = findBin("zellij", ["/opt/homebrew/bin/zellij", "/usr/local/bin/zellij"]);

function writeMcpConfig(profile: string): string {
  const compiledCli = resolve(import.meta.dirname, "../dist/index.js");
  const sourceCli = resolve(import.meta.dirname, "index.ts");
  const useCompiled = existsSync(compiledCli);
  const mcpCommand = useCompiled ? "node" : "npx";
  const mcpArgs = useCompiled ? [compiledCli] : ["tsx", sourceCli];

  const mcpConfigPath = join(STATE_DIR, `mcp-${profile}.json`);
  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      trunk: {
        type: "stdio",
        command: mcpCommand,
        args: mcpArgs,
        env: { TRUNK_PROFILE: profile },
      },
    },
  }, null, 2));
  return mcpConfigPath;
}

function spawnAgent(config: AgentConfig, taskContext: string) {
  if (activeAgents.get(config.profile)) {
    console.log(`[daemon] ${config.name} is already running, skipping`);
    return;
  }

  activeAgents.set(config.profile, true);

  const expandedCwd = config.cwd.replace(/^~/, homedir());
  const mcpConfigPath = writeMcpConfig(config.profile);
  const runtime = config.runtime || "claude";

  const prompt = `${config.prompt}\n\nYou were woken up because of this event:\n${taskContext}`;

  // Write a one-shot script (no loop — daemon handles re-triggering)
  const scriptPath = join(STATE_DIR, `daemon-agent-${config.profile}.sh`);

  let runCommand: string;
  if (runtime === "goose") {
    const gooseProvider = config.gooseProvider || "ollama";
    const gooseModel = config.gooseModel || "qwen3:32b";
    const maxTurns = config.maxTurns ?? 10;
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    runCommand = `${GOOSE_BIN} run \
      --provider '${gooseProvider}' \
      --model '${gooseModel}' \
      --no-profile \
      --no-session \
      --max-turns ${maxTurns} \
      --with-extension 'TRUNK_PROFILE=${config.profile} npx -y -p @usetrunk/cli trunk-mcp' \
      -t '${escapedPrompt}'`;
  } else {
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    runCommand = `${CLAUDE_BIN} \
      --dangerously-skip-permissions \
      --mcp-config '${mcpConfigPath}' \
      -p '${escapedPrompt}'`;
  }

  const scriptContent = `#!/bin/bash
cd '${expandedCwd.replace(/'/g, "'\\''")}'
export TRUNK_PROFILE='${config.profile}'
${runtime === "claude" ? "unset ANTHROPIC_API_KEY" : ""}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  [daemon] ${config.name} woken up"
echo "  [daemon] runtime: ${runtime}"
echo "  [daemon] $(date)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

${runCommand}

echo ""
echo "[daemon] ${config.name} finished at $(date)"
echo "[daemon] Waiting for next poll..."
`;

  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

  if (!ZELLIJ_BIN) {
    console.error("[daemon] zellij not found");
    activeAgents.set(config.profile, false);
    return;
  }

  // Check if the zellij session exists and is alive
  let sessionExists = false;
  try {
    const output = execSync(`${ZELLIJ_BIN} list-sessions 2>/dev/null`, { encoding: "utf-8" });
    // Only count it as existing if it's not EXITED
    const line = output.split("\n").find(l => l.includes(SESSION_NAME));
    sessionExists = !!line && !line.includes("EXITED");
  } catch {}

  if (!sessionExists) {
    // Create session with a layout for this first agent
    const layoutPath = join(STATE_DIR, "daemon-layout.kdl");
    writeFileSync(layoutPath, `layout {
    tab name="${config.profile}" cwd="${expandedCwd}" {
        pane command="bash" {
            args "${scriptPath}"
        }
    }
}`);
    const child = spawn(ZELLIJ_BIN!, ["-s", SESSION_NAME, "-n", layoutPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // Wait for session to be ready
    for (let i = 0; i < 10; i++) {
      execSync("sleep 0.5");
      try {
        const out = execSync(`${ZELLIJ_BIN} list-sessions 2>/dev/null`, { encoding: "utf-8" });
        if (out.includes(SESSION_NAME)) break;
      } catch {}
    }
  } else {
    // Add a tab to existing session
    const tabLayoutPath = join(STATE_DIR, `daemon-tab-${config.profile}.kdl`);
    writeFileSync(tabLayoutPath, `layout {
    tab name="${config.profile}" cwd="${expandedCwd}" {
        pane command="bash" {
            args "${scriptPath}"
        }
    }
}`);
    try {
      execSync(`${ZELLIJ_BIN} -s ${SESSION_NAME} -l ${tabLayoutPath}`, {
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (e: any) {
      console.error(`[daemon] failed to create tab for ${config.name}: ${e.message}`);
      activeAgents.set(config.profile, false);
      return;
    }
  }

  console.log(`[daemon] spawned ${config.name} in tab "${config.profile}"`);

  // Monitor: mark agent as not running when the tab's process exits
  // We poll for simplicity — the tab script exits and zellij shows "Exited" in the pane
  const checkInterval = setInterval(() => {
    // Simple heuristic: check if the script process is still running
    try {
      const result = execSync(`pgrep -f "daemon-agent-${config.profile}.sh"`, { encoding: "utf-8" });
      if (!result.trim()) throw new Error("not running");
    } catch {
      activeAgents.set(config.profile, false);
      clearInterval(checkInterval);
      console.log(`[daemon] ${config.name} finished, ready for next poll`);
    }
  }, 5000);
}

// --- Main ---

const args = process.argv.slice(2);
const configPath = args.includes("--config")
  ? args[args.indexOf("--config") + 1]
  : join(STATE_DIR, "agents.json");

if (!existsSync(configPath)) {
  console.error(`[daemon] config not found: ${configPath}`);
  process.exit(1);
}

const config: HarnessConfig = JSON.parse(readFileSync(configPath, "utf-8"));

console.log(`[daemon] Poll-based harness daemon starting`);
console.log(`[daemon] ${config.agents.length} agents configured`);
console.log(``);

// Poll every agent: wake it on startup, then on its interval. An agent that is
// still running is skipped until it finishes.
for (const agent of config.agents) {
  const interval = (agent.pollInterval ?? 120) * 1000;
  console.log(`[daemon] ${agent.name} will poll every ${agent.pollInterval ?? 120}s`);

  // Run immediately on startup, then on interval
  spawnAgent(agent, "Scheduled poll — check the room for tasks that need attention.");

  setInterval(() => {
    if (!activeAgents.get(agent.profile)) {
      console.log(`[daemon] polling: waking ${agent.name}`);
      spawnAgent(agent, "Scheduled poll — check the room for tasks that need attention.");
    } else {
      console.log(`[daemon] polling: ${agent.name} still running, skipping`);
    }
  }, interval);
}

console.log(`[daemon] Polling ${config.agents.length} agents... (Ctrl+C to stop)`);
console.log(`[daemon] Agents will spawn in zellij session "${SESSION_NAME}" on demand`);
console.log(``);

process.on("SIGINT", () => {
  console.log("\n[daemon] shutting down");
  process.exit(0);
});
