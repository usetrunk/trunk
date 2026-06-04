#!/usr/bin/env node
/**
 * Push-based agent harness daemon.
 *
 * Connects to Trunk WebSocket for each agent profile, listens for task events,
 * and spawns the appropriate agent in a zellij tab on demand. No polling.
 * Agents only run when there's actual work.
 *
 * Usage:
 *   trunk harness daemon [--config ~/.trunk/agents.json]
 */

import WebSocket from "ws";
import type { RawData } from "ws";
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const STATE_DIR = join(homedir(), ".trunk");
const SESSION_NAME = "trunk-harness";

const PUSH_URL = process.env.TRUNK_PUSH_URL || "wss://push.trunk.bot";
const RELAY_URL = process.env.TRUNK_RELAY_URL || "https://trunk.bot";

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
  poll?: boolean;           // run on a timer instead of event-driven
  pollInterval?: number;    // seconds between polls (default: 120)
};

type HarnessConfig = {
  workspace?: string;
  agents: AgentConfig[];
};

type ProfileConfig = {
  agent_id: string;
  secret: string;
  name: string;
};

// --- Role routing ---

type TaskEvent = {
  event: string;
  room_id: string;
  task: {
    id: string;
    title: string;
    description?: string;
    status: string;
    priority: string;
    owner?: string;
    created_by: string;
    group?: string;
  };
};

/**
 * Map a task event to which agent role should handle it.
 * Returns the profile name of the agent to wake, or null if no action needed.
 */
function routeEvent(event: TaskEvent, agents: AgentConfig[]): AgentConfig | null {
  const task = event.task;
  const eventType = event.event;

  // Find agents by role pattern in their name
  const findAgent = (pattern: RegExp) => agents.find(a => pattern.test(a.name.toLowerCase()));

  const builder = findAgent(/build/);
  const reviewer = findAgent(/review/);
  const planner = findAgent(/plan/);
  const merger = findAgent(/merge/);
  const qa = findAgent(/qa|test/);
  const docs = findAgent(/doc/);

  switch (eventType) {
    case "task.created":
      // New task — wake the planner to triage, or builder if it's assigned
      if (task.owner) {
        // Task is assigned — find the agent whose profile matches the owner
        const assigned = agents.find(a => {
          const configPath = join(STATE_DIR, `config.${a.profile}.json`);
          try {
            const config = JSON.parse(readFileSync(configPath, "utf-8"));
            return config.agent_id === task.owner;
          } catch { return false; }
        });
        return assigned || builder || null;
      }
      if (task.group === "bugs") return builder || qa || null;
      if (task.group === "tests") return qa || builder || null;
      if (task.group === "docs") return docs || null;
      if (task.group === "security") return builder || null;
      if (task.group === "human") return null; // Human escalation — don't wake an agent
      return builder || planner || null;

    case "task.updated":
      // Task status changed — route based on new status
      if (task.status === "done") return docs || null; // Docs should check if guide needed
      if (task.status === "open") return builder || null; // Newly open = ready for work
      if (task.status === "blocked") return planner || null; // Planner should re-triage
      return null;

    case "task.unblocked":
      // Dependency resolved — wake builder to claim it
      return builder || null;

    case "task.deleted":
      return null; // No action needed

    default:
      return null;
  }
}

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
echo "[daemon] Waiting for next event..."
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
      console.log(`[daemon] ${config.name} finished, ready for next event`);
    }
  }, 5000);
}

// --- WebSocket connections ---

function loadProfileConfig(profile: string): ProfileConfig | null {
  const configPath = join(STATE_DIR, `config.${profile}.json`);
  try {
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

function connectAgent(agentConfig: AgentConfig, allAgents: AgentConfig[]) {
  const profileConfig = loadProfileConfig(agentConfig.profile);
  if (!profileConfig) {
    console.error(`[daemon] no config for profile "${agentConfig.profile}" — agent needs to register first`);
    return;
  }

  const url = `${PUSH_URL}/connect/${profileConfig.agent_id}?secret=${profileConfig.secret}`;
  let ws: WebSocket;

  function connect() {
    ws = new WebSocket(url);

    ws.on("open", () => {
      console.log(`[daemon] ${agentConfig.name} connected to push (${profileConfig.agent_id.slice(0, 8)}...)`);
    });

    ws.on("message", (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle task events
        if (msg.event?.startsWith("task.")) {
          const taskEvent = msg as TaskEvent;
          console.log(`[daemon] ${msg.event}: "${taskEvent.task?.title}" (${taskEvent.task?.status})`);

          const target = routeEvent(taskEvent, allAgents);
          if (target) {
            const context = `Event: ${msg.event}\nTask: ${taskEvent.task.title}\nStatus: ${taskEvent.task.status}\nGroup: ${taskEvent.task.group || "none"}\nPriority: ${taskEvent.task.priority}\nRoom: ${taskEvent.room_id}`;
            spawnAgent(target, context);
          }
        }

        // Handle message events (existing behavior)
        if (msg.event === "message.received") {
          const content = msg.message?.payload?.content || "(no content)";
          const type = msg.message?.type || "message";
          console.log(`[daemon] message.${type}: ${content.slice(0, 80)}`);
        }
      } catch (e) {
        console.error(`[daemon] failed to parse event:`, e);
      }
    });

    ws.on("close", () => {
      console.log(`[daemon] ${agentConfig.name} disconnected, reconnecting in 5s...`);
      setTimeout(connect, 5000);
    });

    ws.on("error", (err: Error) => {
      console.error(`[daemon] ${agentConfig.name} ws error: ${err.message}`);
    });
  }

  connect();
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

console.log(`[daemon] Push-based harness daemon starting`);
console.log(`[daemon] ${config.agents.length} agents configured`);
console.log(`[daemon] Connecting WebSockets...`);
console.log(``);

// Connect a WebSocket for each agent that has a profile config
// We only need one connection per unique profile to receive room events
const connectedProfiles = new Set<string>();

for (const agent of config.agents) {
  if (connectedProfiles.has(agent.profile)) continue;

  const profileConfig = loadProfileConfig(agent.profile);
  if (!profileConfig) {
    console.log(`[daemon] skipping ${agent.name} — no profile config (needs registration)`);
    continue;
  }

  connectAgent(agent, config.agents);
  connectedProfiles.add(agent.profile);
}

console.log(`[daemon] ${connectedProfiles.size} WebSocket connections established`);

// Start polling loops for agents with poll: true
const pollingAgents = config.agents.filter(a => a.poll);
for (const agent of pollingAgents) {
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

const eventAgents = config.agents.filter(a => !a.poll);
console.log(`[daemon] ${eventAgents.length} event-driven, ${pollingAgents.length} polling`);
console.log(`[daemon] Listening for task events... (Ctrl+C to stop)`);
console.log(`[daemon] Agents will spawn in zellij session "${SESSION_NAME}" on demand`);
console.log(``);

process.on("SIGINT", () => {
  console.log("\n[daemon] shutting down");
  process.exit(0);
});
