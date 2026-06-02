#!/usr/bin/env node
/**
 * Trunk Harness — spawn, manage, and stop Claude Code agents.
 *
 * Default mode uses zellij — each agent gets a tab in a shared session.
 * Agents run interactively (subscription credits, not API).
 *
 * Usage:
 *   trunk harness start [--config agents.json]   — spawn all agents in zellij
 *   trunk harness start --api                     — spawn agents with claude -p (API credits)
 *   trunk harness spawn --name X --cwd Y --prompt Z  — spawn one agent
 *   trunk harness list                            — show running agents
 *   trunk harness stop <name>                     — stop one agent
 *   trunk harness stop-all                        — stop all agents
 *   trunk harness attach                          — attach to the zellij session
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// Resolve binary paths
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

const ZELLIJ_BIN = findBin("zellij", ["/opt/homebrew/bin/zellij", "/usr/local/bin/zellij"]);

const STATE_DIR = join(homedir(), ".trunk");
const STATE_FILE = join(STATE_DIR, "harness-state.json");
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
};

type HarnessConfig = {
  workspace?: string;
  loop?: boolean;
  loopDelay?: number;
  agents: AgentConfig[];
};

type RunningAgent = {
  name: string;
  profile: string;
  pid: number;
  cwd: string;
  startedAt: string;
  mode: "zellij" | "api";
};

// --- State management ---

function loadState(): RunningAgent[] {
  try {
    if (!existsSync(STATE_FILE)) return [];
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveState(agents: RunningAgent[]) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(agents, null, 2));
}

function addAgent(agent: RunningAgent) {
  const state = loadState().filter(a => a.name !== agent.name);
  state.push(agent);
  saveState(state);
}

function removeAgent(name: string) {
  saveState(loadState().filter(a => a.name !== name));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- MCP config helper ---

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

// --- Prompt builder ---

function buildPrompt(config: AgentConfig): string {
  return [
    config.prompt,
    "",
    `Your Trunk profile is "${config.profile}". You have Trunk MCP tools available.`,
    "Check your Trunk inbox at the start. Coordinate with other agents through Trunk, not the human.",
    config.workspace ? `Join workspace ${config.workspace} if not already joined.` : "",
    "When you finish a task, broadcast completion to the workspace and pick the next one.",
  ].filter(Boolean).join("\n");
}

// --- Zellij mode ---

function isZellijSessionRunning(): boolean {
  try {
    const output = execSync(`${ZELLIJ_BIN} list-sessions 2>/dev/null`, { encoding: "utf-8" });
    return output.includes(SESSION_NAME);
  } catch {
    return false;
  }
}

/**
 * Write the bash wrapper script for an agent.
 * Handles loop/respawn, banner, and prompt injection.
 */
function writeAgentScript(config: AgentConfig): string {
  const expandedCwd = config.cwd.replace(/^~/, homedir());
  const mcpConfigPath = writeMcpConfig(config.profile);
  const fullPrompt = buildPrompt(config);
  const loopEnabled = config.loop !== false;
  const loopDelay = config.loopDelay ?? 30;

  const escapedPrompt = fullPrompt.replace(/'/g, "'\\''");
  const escapedResume = `You are resuming work. Check your Trunk inbox for new messages and the project room for tasks. Pick up where you left off or claim the next available task. ${fullPrompt}`.replace(/'/g, "'\\''");

  const scriptContent = `#!/bin/bash
cd '${expandedCwd.replace(/'/g, "'\\''")}'
export TRUNK_PROFILE='${config.profile}'

# Unset API key so claude uses OAuth/subscription instead of API credits
unset ANTHROPIC_API_KEY

PROMPT='${escapedPrompt}'
RESUME_PROMPT='${escapedResume}'
FIRST_RUN=1
LOG_FILE="${join(STATE_DIR, `agent-${config.profile}.log`)}"

${loopEnabled ? "while true; do" : ""}
  if [ "$FIRST_RUN" = "1" ]; then
    CURRENT_PROMPT="$PROMPT"
    FIRST_RUN=0
  else
    CURRENT_PROMPT="$RESUME_PROMPT"
  fi

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  [harness] Starting ${config.name} (${config.profile})"
  echo "  [harness] cwd: ${expandedCwd}"
  echo "  [harness] $(date)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Run directly on the TTY (no pipes — pipes cause stdout buffering)
  ${CLAUDE_BIN} \\
    --dangerously-skip-permissions \\
    --mcp-config '${mcpConfigPath}' \\
    -p "$CURRENT_PROMPT"

  EXIT_CODE=$?
  echo ""
  echo "[harness] ${config.name} exited with code $EXIT_CODE"

${loopEnabled ? `
  echo "[harness] ${config.name} will respawn in ${loopDelay}s... (Ctrl+C to stop)"
  sleep ${loopDelay}
` : `
  echo "[harness] ${config.name} finished (no loop). Press Enter for a shell."
  read
  exec bash
`}
${loopEnabled ? "done" : ""}
`;

  const wrapperScript = join(STATE_DIR, `agent-${config.profile}.sh`);
  writeFileSync(wrapperScript, scriptContent, { mode: 0o755 });
  return wrapperScript;
}

/**
 * Generate a KDL layout string for zellij with one tab per agent.
 */
function buildZellijLayout(agents: AgentConfig[]): string {
  const tabs = agents.map(agent => {
    const expandedCwd = agent.cwd.replace(/^~/, homedir());
    const script = writeAgentScript(agent);
    // KDL layout tab: run the wrapper script in a pane
    return `    tab name="${agent.profile}" cwd="${expandedCwd}" {
        pane command="bash" {
            args "${script}"
        }
    }`;
  });

  return `layout {
${tabs.join("\n")}
}`;
}

/**
 * Start all agents in a new zellij session using a layout.
 */
function startZellijSession(configs: AgentConfig[]): void {
  // Validate all cwds first
  for (const config of configs) {
    const expandedCwd = config.cwd.replace(/^~/, homedir());
    if (!existsSync(expandedCwd)) {
      console.error(`[harness] ERROR: cwd does not exist for ${config.name}: ${expandedCwd}`);
      return;
    }
  }

  const layout = buildZellijLayout(configs);
  const layoutPath = join(STATE_DIR, "harness-layout.kdl");
  writeFileSync(layoutPath, layout);

  // Start zellij detached with the layout
  const child = spawn(ZELLIJ_BIN!, [
    "-s", SESSION_NAME,
    "-n", layoutPath,
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Track all agents in state
  for (const config of configs) {
    const expandedCwd = config.cwd.replace(/^~/, homedir());
    addAgent({
      name: config.name,
      profile: config.profile,
      pid: 0,
      cwd: expandedCwd,
      startedAt: new Date().toISOString(),
      mode: "zellij",
    });
    console.log(`[harness] ${config.name} → tab "${config.profile}"`);
  }
}

/**
 * Add a single agent tab to an existing zellij session.
 */
function addZellijAgent(config: AgentConfig): void {
  const expandedCwd = config.cwd.replace(/^~/, homedir());
  if (!existsSync(expandedCwd)) {
    console.error(`[harness] ERROR: cwd does not exist: ${expandedCwd}`);
    return;
  }

  const script = writeAgentScript(config);

  // Build a single-tab layout to add to the existing session
  const tabLayout = `layout {
    tab name="${config.profile}" cwd="${expandedCwd}" {
        pane command="bash" {
            args "${script}"
        }
    }
}`;
  const tabLayoutPath = join(STATE_DIR, `harness-tab-${config.profile}.kdl`);
  writeFileSync(tabLayoutPath, tabLayout);

  try {
    execSync(`${ZELLIJ_BIN} -s ${SESSION_NAME} -l ${tabLayoutPath}`, {
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (e: any) {
    console.error(`[harness] failed to add tab for ${config.name}: ${e.message}`);
    return;
  }

  addAgent({
    name: config.name,
    profile: config.profile,
    pid: 0,
    cwd: expandedCwd,
    startedAt: new Date().toISOString(),
    mode: "zellij",
  });
  console.log(`[harness] ${config.name} added to tab "${config.profile}"`);
}

function stopZellijAgent(name: string): boolean {
  const state = loadState();
  const agent = state.find(a => a.name === name);
  if (!agent) {
    console.log(`[harness] agent "${name}" not found`);
    return false;
  }

  if (agent.mode === "zellij") {
    // We can't easily close a specific tab from outside zellij without focus.
    // Best we can do is note it — user can close the tab from inside, or stop-all kills the session.
    console.log(`[harness] removed ${name} from tracking.`);
    console.log(`[harness] to close the tab: attach to the session and close it manually,`);
    console.log(`[harness] or use "trunk harness stop-all" to kill the entire session.`);
    removeAgent(name);
    return true;
  }

  // API mode — kill by PID
  try {
    process.kill(agent.pid, "SIGTERM");
    console.log(`[harness] sent SIGTERM to ${name} (pid ${agent.pid})`);
    removeAgent(name);
    return true;
  } catch (e: any) {
    if (e.code === "ESRCH") {
      console.log(`[harness] ${name} already stopped (pid ${agent.pid} not found)`);
      removeAgent(name);
      return true;
    }
    console.error(`[harness] failed to stop ${name}: ${e.message}`);
    return false;
  }
}

// --- API mode (claude -p, uses API credits) ---

function spawnApiAgent(config: AgentConfig): ChildProcess {
  const expandedCwd = config.cwd.replace(/^~/, homedir());

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    TRUNK_PROFILE: config.profile,
  };

  const fullPrompt = buildPrompt(config);
  const spawnTime = Date.now();
  console.log(`[harness] spawning ${config.name} (profile: ${config.profile}, cwd: ${expandedCwd}, mode: api)`);

  if (!existsSync(expandedCwd)) {
    console.error(`[harness] ERROR: cwd does not exist: ${expandedCwd}`);
    return null as unknown as ChildProcess;
  }

  const mcpConfigPath = writeMcpConfig(config.profile);

  const child = spawn(CLAUDE_BIN, [
    "--dangerously-skip-permissions",
    "--bare",
    "--mcp-config",
    mcpConfigPath,
    "-p",
    fullPrompt,
  ], {
    cwd: expandedCwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.on("error", (err: Error) => {
    console.error(`[harness] failed to spawn ${config.name}: ${err.message}`);
    removeAgent(config.name);
  });

  let firstOutput = true;
  let lastOutput = "";
  child.stdout?.on("data", (data: Buffer) => {
    if (firstOutput) {
      const elapsed = Math.round((Date.now() - spawnTime) / 1000);
      console.log(`[harness] ${config.name} is ready (${elapsed}s startup)`);
      firstOutput = false;
    }
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      console.log(`[${config.name}] ${line}`);
      lastOutput = line;
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      console.error(`[${config.name}:err] ${line}`);
    }
  });

  child.on("exit", (code) => {
    console.log(`[harness] ${config.name} exited with code ${code}`);
    removeAgent(config.name);

    const isCreditError = lastOutput.toLowerCase().includes("credit") ||
                          lastOutput.toLowerCase().includes("balance") ||
                          lastOutput.toLowerCase().includes("billing") ||
                          lastOutput.toLowerCase().includes("rate limit");
    if (isCreditError) {
      console.error(`[harness] ${config.name} hit a billing/credit error — pausing respawn.`);
      return;
    }

    if (config.loop !== false) {
      const delay = config.loopDelay ?? 30;
      console.log(`[harness] ${config.name} will respawn in ${delay}s (loop mode)`);
      setTimeout(() => {
        console.log(`[harness] respawning ${config.name}...`);
        spawnApiAgent({
          ...config,
          prompt: `You are resuming work. Check your Trunk inbox for new messages and the project room for tasks. Pick up where you left off or claim the next available task. ${config.prompt}`,
        });
      }, delay * 1000);
    }
  });

  if (child.pid) {
    addAgent({
      name: config.name,
      profile: config.profile,
      pid: child.pid,
      cwd: expandedCwd,
      startedAt: new Date().toISOString(),
      mode: "api",
    });
  }

  return child;
}

// --- Commands ---

const args = process.argv.slice(2);
const command = args[0];

if (command === "start") {
  const configPath = args.includes("--config")
    ? args[args.indexOf("--config") + 1]
    : "agents.json";

  // Check for private config in ~/.trunk/ if not found in cwd
  const resolvedConfig = existsSync(configPath) ? configPath : join(STATE_DIR, "agents.json");

  if (!existsSync(resolvedConfig)) {
    console.error(`[harness] config not found: ${configPath}`);
    console.log(`\nCreate an agents.json (in cwd or ~/.trunk/):\n`);
    console.log(JSON.stringify({
      workspace: "XXXX1234",
      agents: [
        { name: "Developer", profile: "dev", cwd: "~/dev/myproject", prompt: "Check Trunk inbox and pick a task." },
      ],
    }, null, 2));
    process.exit(1);
  }

  const apiMode = args.includes("--api");

  if (!apiMode && !ZELLIJ_BIN) {
    console.error("[harness] zellij not found. Install it (brew install zellij) or use --api mode.");
    process.exit(1);
  }

  const config: HarnessConfig = JSON.parse(readFileSync(resolvedConfig, "utf-8"));
  const loopMode = args.includes("--no-loop") ? false : (config.loop ?? true);
  const loopDelay = config.loopDelay ?? 30;

  console.log(`[harness] starting ${config.agents.length} agents from ${resolvedConfig} (mode: ${apiMode ? "api" : "zellij"})`);

  // Apply defaults to all agents
  for (const agentConfig of config.agents) {
    if (config.workspace && !agentConfig.workspace) agentConfig.workspace = config.workspace;
    if (agentConfig.loop === undefined) agentConfig.loop = loopMode;
    if (agentConfig.loopDelay === undefined) agentConfig.loopDelay = loopDelay;
  }

  if (apiMode) {
    // --- API mode: spawn child processes with claude -p ---
    const children: ChildProcess[] = [];
    for (const agentConfig of config.agents) {
      children.push(spawnApiAgent(agentConfig));
    }

    console.log(`[harness] ${children.length} agents spawned (loop: ${loopMode}, delay: ${loopDelay}s)`);
    console.log(`[harness] press Ctrl+C to detach (agents keep running)\n`);

    process.on("SIGINT", () => {
      console.log("\n[harness] detaching — agents keep running in background");
      process.exit(0);
    });
  } else {
    // --- Zellij mode ---
    if (isZellijSessionRunning()) {
      console.log(`[harness] session "${SESSION_NAME}" already exists — adding agents to it.`);
      for (const agentConfig of config.agents) {
        addZellijAgent(agentConfig);
      }
    } else {
      startZellijSession(config.agents);
    }

    console.log(`\n[harness] ${config.agents.length} agents running in zellij session "${SESSION_NAME}"`);
    console.log(`[harness] loop: ${loopMode}, delay: ${loopDelay}s\n`);
    console.log(`  Attach:     trunk harness attach`);
    console.log(`              zellij attach ${SESSION_NAME}`);
    console.log(`  List:       trunk harness list`);
    console.log(`  Stop one:   trunk harness stop <name>`);
    console.log(`  Stop all:   trunk harness stop-all`);
  }

} else if (command === "spawn") {
  const name = args[args.indexOf("--name") + 1];
  const cwd = args[args.indexOf("--cwd") + 1];
  const prompt = args[args.indexOf("--prompt") + 1];
  const profile = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : name.toLowerCase().replace(/\s+/g, "-");
  const workspace = args.includes("--workspace") ? args[args.indexOf("--workspace") + 1] : undefined;
  const apiMode = args.includes("--api");

  if (!name || !cwd || !prompt) {
    console.log("Usage: trunk harness spawn --name <name> --cwd <dir> --prompt <prompt> [--profile P] [--workspace W] [--api]");
    process.exit(1);
  }

  if (apiMode) {
    const child = spawnApiAgent({ name, profile, cwd, prompt, workspace });
    console.log(`[harness] ${name} spawned (pid ${child.pid}, mode: api)`);
    process.on("SIGINT", () => {
      console.log("\n[harness] detaching — agent keeps running");
      process.exit(0);
    });
  } else {
    if (!ZELLIJ_BIN) {
      console.error("[harness] zellij not found. Install it (brew install zellij) or use --api mode.");
      process.exit(1);
    }
    if (isZellijSessionRunning()) {
      addZellijAgent({ name, profile, cwd, prompt, workspace });
    } else {
      startZellijSession([{ name, profile, cwd, prompt, workspace }]);
    }
    console.log(`[harness] attach with: zellij attach ${SESSION_NAME}`);
  }

} else if (command === "attach") {
  if (!ZELLIJ_BIN) {
    console.error("[harness] zellij not found.");
    process.exit(1);
  }
  if (!isZellijSessionRunning()) {
    console.log(`[harness] no active session. Run "trunk harness start" first.`);
    process.exit(1);
  }
  try {
    execSync(`${ZELLIJ_BIN} attach ${SESSION_NAME}`, { stdio: "inherit" });
  } catch {
    // Normal exit when user detaches
  }

} else if (command === "list") {
  const state = loadState();
  if (state.length === 0) {
    console.log("No running agents.");
  } else {
    const zellijRunning = ZELLIJ_BIN ? isZellijSessionRunning() : false;

    console.log(`${state.length} agent(s):\n`);
    for (const agent of state) {
      let status: string;
      if (agent.mode === "zellij") {
        status = zellijRunning ? "running (zellij)" : "stopped";
      } else {
        status = isProcessRunning(agent.pid) ? "running (api)" : "stopped";
      }
      const age = Math.floor((Date.now() - new Date(agent.startedAt).getTime()) / 60000);
      console.log(`  ${agent.name}`);
      console.log(`    profile: ${agent.profile} | status: ${status} | uptime: ${age}m`);
      console.log(`    cwd: ${agent.cwd}`);
      console.log();
    }
  }

  // Clean up stopped agents
  const zellijRunning = ZELLIJ_BIN ? isZellijSessionRunning() : false;
  const cleaned = state.filter(a => {
    if (a.mode === "zellij") return zellijRunning;
    return isProcessRunning(a.pid);
  });
  if (cleaned.length !== state.length) {
    saveState(cleaned);
  }

} else if (command === "stop") {
  const name = args[1];
  if (!name) {
    console.log("Usage: trunk harness stop <name>");
    process.exit(1);
  }
  stopZellijAgent(name);

} else if (command === "stop-all") {
  const state = loadState();
  if (state.length === 0 && !(ZELLIJ_BIN && isZellijSessionRunning())) {
    console.log("No running agents.");
  } else {
    if (state.length > 0) {
      console.log(`[harness] clearing ${state.length} agents from state...`);
      saveState([]);
    }

    // Kill the zellij session and clean it up
    if (ZELLIJ_BIN) {
      try {
        execSync(`${ZELLIJ_BIN} kill-session ${SESSION_NAME} 2>/dev/null`);
        console.log(`[harness] killed zellij session "${SESSION_NAME}"`);
      } catch {
        // already dead
      }
      try {
        execSync(`${ZELLIJ_BIN} delete-session ${SESSION_NAME} 2>/dev/null`);
      } catch {
        // already gone
      }
    }

    // Kill any API-mode agents by PID
    for (const agent of state) {
      if (agent.mode === "api" && agent.pid) {
        try {
          process.kill(agent.pid, "SIGTERM");
          console.log(`[harness] sent SIGTERM to ${agent.name} (pid ${agent.pid})`);
        } catch {
          // already dead
        }
      }
    }

    console.log("[harness] all agents stopped.");
  }

} else {
  console.log(`Trunk Harness — spawn and manage Claude Code agents

Default mode runs agents in zellij (subscription credits).
Use --api to run with claude -p (API credits).

Commands:
  start [--config agents.json]   Start all agents in zellij tabs
  start --api                    Start agents with claude -p (API credits)
  spawn --name X --cwd Y --prompt Z [--profile P] [--workspace W] [--api]
                                 Spawn a single agent
  attach                         Attach to the zellij session
  list                           Show running agents
  stop <name>                    Stop one agent
  stop-all                       Stop all agents

Example agents.json:
${JSON.stringify({
  workspace: "ZDUJ7TB2",
  agents: [
    { name: "Koji Developer", profile: "koji-dev", cwd: "~/dev/koji/playbook/koji", prompt: "Check Trunk inbox, claim a task, build." },
    { name: "Trunk Builder", profile: "trunk-dev", cwd: "~/dev/trunk/trunk", prompt: "Pick a room task and ship it." },
  ],
}, null, 2)}
`);
}
