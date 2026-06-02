#!/usr/bin/env node
/**
 * Trunk Harness — spawn, manage, and stop Claude Code agents.
 *
 * Usage:
 *   trunk harness start [--config agents.json]   — spawn all agents from config
 *   trunk harness spawn --name X --cwd Y --prompt Z  — spawn one agent
 *   trunk harness list                            — show running agents
 *   trunk harness stop <name>                     — stop one agent
 *   trunk harness stop-all                        — stop all agents
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// Resolve claude binary path — needed because child_process may not inherit full PATH
function findClaude(): string {
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    // Common locations
    const candidates = [
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      join(homedir(), ".npm-global/bin/claude"),
      join(homedir(), ".local/bin/claude"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return "claude"; // fall back, let it fail with a clear error
  }
}

const CLAUDE_BIN = findClaude();

const STATE_DIR = join(homedir(), ".trunk");
const STATE_FILE = join(STATE_DIR, "harness-state.json");

type AgentConfig = {
  name: string;
  profile: string;
  cwd: string;
  prompt: string;
  workspace?: string;
  model?: string;
  loop?: boolean;         // respawn after exit (default: true in start mode)
  loopDelay?: number;     // seconds between respawns (default: 30)
};

type HarnessConfig = {
  workspace?: string;
  loop?: boolean;         // default loop setting for all agents
  loopDelay?: number;     // default delay for all agents
  agents: AgentConfig[];
};

type RunningAgent = {
  name: string;
  profile: string;
  pid: number;
  cwd: string;
  startedAt: string;
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

// --- Process management ---

function spawnAgent(config: AgentConfig): ChildProcess {
  const expandedCwd = config.cwd.replace(/^~/, homedir());
  const cliPath = resolve(import.meta.dirname, "index.ts");

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    TRUNK_PROFILE: config.profile,
  };

  // Build the initial prompt that includes Trunk coordination instructions
  const fullPrompt = [
    config.prompt,
    "",
    `Your Trunk profile is "${config.profile}". You have Trunk MCP tools available.`,
    "Check your Trunk inbox at the start. Coordinate with other agents through Trunk, not the human.",
    config.workspace ? `Join workspace ${config.workspace} if not already joined.` : "",
    "When you finish a task, broadcast completion to the workspace and pick the next one.",
  ].filter(Boolean).join("\n");

  const spawnTime = Date.now();
  console.log(`[harness] spawning ${config.name} (profile: ${config.profile}, cwd: ${expandedCwd})`);

  // Verify cwd exists
  if (!existsSync(expandedCwd)) {
    console.error(`[harness] ERROR: cwd does not exist: ${expandedCwd}`);
    return null as unknown as ChildProcess;
  }

  // Write MCP config to a temp file so claude can load Trunk tools in -p mode
  // Use pre-compiled JS if available, fall back to tsx
  const compiledCli = resolve(import.meta.dirname, "../dist/index.js");
  const sourceCli = resolve(import.meta.dirname, "index.ts");
  const useCompiled = existsSync(compiledCli);
  const mcpCommand = useCompiled ? "node" : "npx";
  const mcpArgs = useCompiled ? [compiledCli] : ["tsx", sourceCli];

  const mcpConfigPath = join(STATE_DIR, `mcp-${config.profile}.json`);
  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      trunk: {
        type: "stdio",
        command: mcpCommand,
        args: mcpArgs,
        env: { TRUNK_PROFILE: config.profile },
      },
    },
  }, null, 2));

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
  child.stdout?.on("data", (data: Buffer) => {
    if (firstOutput) {
      const elapsed = Math.round((Date.now() - spawnTime) / 1000);
      console.log(`[harness] ✓ ${config.name} is ready (${elapsed}s startup)`);
      firstOutput = false;
    }
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      console.log(`[${config.name}] ${line}`);
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

    // Respawn if looping
    if (config.loop !== false) {
      const delay = config.loopDelay ?? 30;
      console.log(`[harness] ${config.name} will respawn in ${delay}s (loop mode)`);
      setTimeout(() => {
        console.log(`[harness] respawning ${config.name}...`);
        spawnAgent({
          ...config,
          prompt: `You are resuming work. Check your Trunk inbox for new messages and the project room for tasks. Pick up where you left off or claim the next available task. ${config.prompt}`,
        });
      }, delay * 1000);
    }
  });

  // Track the process
  if (child.pid) {
    addAgent({
      name: config.name,
      profile: config.profile,
      pid: child.pid,
      cwd: expandedCwd,
      startedAt: new Date().toISOString(),
    });
  }

  return child;
}

function stopAgent(name: string): boolean {
  const state = loadState();
  const agent = state.find(a => a.name === name);
  if (!agent) {
    console.log(`[harness] agent "${name}" not found`);
    return false;
  }

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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Commands ---

const args = process.argv.slice(2);
const command = args[0];

if (command === "start") {
  const configPath = args.includes("--config")
    ? args[args.indexOf("--config") + 1]
    : "agents.json";

  if (!existsSync(configPath)) {
    console.error(`[harness] config not found: ${configPath}`);
    console.log(`\nCreate an agents.json:\n`);
    console.log(JSON.stringify({
      workspace: "XXXX1234",
      agents: [
        { name: "Developer", profile: "dev", cwd: "~/dev/myproject", prompt: "Check Trunk inbox and pick a task." },
      ],
    }, null, 2));
    process.exit(1);
  }

  const config: HarnessConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  console.log(`[harness] starting ${config.agents.length} agents from ${configPath}`);

  const loopMode = args.includes("--no-loop") ? false : (config.loop ?? true);
  const loopDelay = config.loopDelay ?? 30;

  // Stagger agent spawns to avoid resource contention
  const STAGGER_DELAY_MS = 10000; // 10s between spawns
  const children: ChildProcess[] = [];

  for (let i = 0; i < config.agents.length; i++) {
    const agentConfig = config.agents[i];
    if (config.workspace && !agentConfig.workspace) {
      agentConfig.workspace = config.workspace;
    }
    if (agentConfig.loop === undefined) agentConfig.loop = loopMode;
    if (agentConfig.loopDelay === undefined) agentConfig.loopDelay = loopDelay;

    if (i > 0) {
      console.log(`[harness] waiting ${STAGGER_DELAY_MS / 1000}s before next spawn...`);
      await new Promise(r => setTimeout(r, STAGGER_DELAY_MS));
    }
    children.push(spawnAgent(agentConfig));
  }

  console.log(`[harness] ${children.length} agents spawned (loop: ${loopMode}, delay: ${loopDelay}s). Output streaming below.`);
  console.log(`[harness] use "trunk harness list" to check status`);
  console.log(`[harness] use "trunk harness stop <name>" to stop an agent`);
  console.log(`[harness] use "trunk harness stop-all" to stop everything`);
  console.log(`[harness] press Ctrl+C to detach (agents keep running)\n`);

  // Keep the harness alive to stream output
  process.on("SIGINT", () => {
    console.log("\n[harness] detaching — agents keep running in background");
    console.log("[harness] use 'trunk harness stop-all' to stop them");
    process.exit(0);
  });

} else if (command === "spawn") {
  const name = args[args.indexOf("--name") + 1];
  const cwd = args[args.indexOf("--cwd") + 1];
  const prompt = args[args.indexOf("--prompt") + 1];
  const profile = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : name.toLowerCase().replace(/\s+/g, "-");
  const workspace = args.includes("--workspace") ? args[args.indexOf("--workspace") + 1] : undefined;

  if (!name || !cwd || !prompt) {
    console.log("Usage: trunk harness spawn --name <name> --cwd <dir> --prompt <prompt> [--profile <profile>] [--workspace <code>]");
    process.exit(1);
  }

  const child = spawnAgent({ name, profile, cwd, prompt, workspace });
  console.log(`[harness] ${name} spawned (pid ${child.pid})`);

  // Stream output, Ctrl+C detaches
  process.on("SIGINT", () => {
    console.log("\n[harness] detaching — agent keeps running");
    process.exit(0);
  });

} else if (command === "list") {
  const state = loadState();
  if (state.length === 0) {
    console.log("No running agents.");
  } else {
    console.log(`${state.length} agent(s):\n`);
    for (const agent of state) {
      const running = isProcessRunning(agent.pid);
      const status = running ? "running" : "stopped";
      const age = Math.floor((Date.now() - new Date(agent.startedAt).getTime()) / 60000);
      console.log(`  ${agent.name}`);
      console.log(`    profile: ${agent.profile} | pid: ${agent.pid} | status: ${status} | uptime: ${age}m`);
      console.log(`    cwd: ${agent.cwd}`);
      console.log();
    }
  }

  // Clean up stopped agents
  const cleaned = state.filter(a => isProcessRunning(a.pid));
  if (cleaned.length !== state.length) {
    saveState(cleaned);
  }

} else if (command === "stop") {
  const name = args[1];
  if (!name) {
    console.log("Usage: trunk harness stop <name>");
    process.exit(1);
  }
  stopAgent(name);

} else if (command === "stop-all") {
  const state = loadState();
  if (state.length === 0) {
    console.log("No running agents.");
  } else {
    console.log(`[harness] stopping ${state.length} agents...`);
    for (const agent of state) {
      stopAgent(agent.name);
    }
  }

} else {
  console.log(`Trunk Harness — spawn and manage Claude Code agents

Commands:
  start [--config agents.json]   Start all agents from config file
  spawn --name X --cwd Y --prompt Z [--profile P] [--workspace W]
                                 Spawn a single agent
  list                           Show running agents
  stop <name>                    Stop one agent
  stop-all                       Stop all agents

Example agents.json:
${JSON.stringify({
  workspace: "ZDUJ7TB2",
  agents: [
    { name: "Koji Developer", profile: "koji-dev", cwd: "~/dev/koji/koji", prompt: "Check Trunk inbox, claim a task, build." },
    { name: "Superkey Planner", profile: "sk-plan", cwd: "~/dev/superkey", prompt: "Plan the v2 migration." },
    { name: "Trunk Builder", profile: "trunk-dev", cwd: "~/dev/trunk/trunk", prompt: "Pick a room task and ship it." },
  ],
}, null, 2)}
`);
}
