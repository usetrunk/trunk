#!/usr/bin/env node
/**
 * Trunk CLI — standalone commands (not MCP).
 *
 * Usage:
 *   npx @usetrunk/cli daemon install   — install as background service
 *   npx @usetrunk/cli daemon start     — run in foreground
 *   npx @usetrunk/cli daemon start --execute — run foreground executor
 *   npx @usetrunk/cli daemon status    — check if running
 *   npx @usetrunk/cli status           — show agent info
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";

const PROFILE = process.env.TRUNK_PROFILE;
const CONFIG_FILE = join(homedir(), ".trunk", PROFILE ? `config.${PROFILE}.json` : "config.json");

function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch { return null; }
}

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

if (command === "daemon") {
  if (subcommand === "install") {
    await import("./daemon/install.js");
  } else if (subcommand === "start") {
    await import("./daemon/index.js");
  } else if (subcommand === "status") {
    const os = platform();
    try {
      if (os === "darwin") {
        const result = execSync("launchctl list bot.trunk.daemon 2>&1", { encoding: "utf-8" });
        console.log("Trunk daemon: running");
        console.log(result);
      } else if (os === "linux") {
        const result = execSync("systemctl --user status trunk-daemon 2>&1", { encoding: "utf-8" });
        console.log(result);
      } else {
        console.log("Check Task Manager for trunk-daemon.bat");
      }
    } catch {
      console.log("Trunk daemon: not running");
    }
  } else {
    console.log("Usage: trunk daemon [install|start|status] [--execute]");
  }
} else if (command === "harness") {
  if (subcommand === "daemon") {
    // Poll-based harness daemon — agents spawn on a timer to check the room
    process.argv = ["node", "harness-daemon", ...args.slice(2)];
    await import("./daemon/harness-daemon.js");
  } else {
    // Polling-based harness — agents loop on a timer
    process.argv = ["node", "harness", ...args.slice(1)];
    await import("./harness.js");
  }
} else if (command === "status") {
  const config = loadConfig();
  if (!config) {
    console.log("Not registered. Set up the MCP server and tell your agent to register.");
  } else {
    console.log(`Agent:        ${config.name}`);
    console.log(`ID:           ${config.agent_id}`);
    console.log(`Pairing code: ${config.pairing_code}`);
    if (config.role) console.log(`Role:         ${config.role}`);
    if (config.workspace_code) console.log(`Workspace:    ${config.workspace_code}`);
    if (config.projects?.length) console.log(`Projects:     ${config.projects.join(", ")}`);
    if (config.metadata && Object.keys(config.metadata).length > 0) {
      console.log(`Metadata:     ${JSON.stringify(config.metadata)}`);
    }
    console.log(`Config:       ${CONFIG_FILE}`);
  }
} else {
  console.log(`Trunk CLI v0.1.0

Commands:
  daemon install   Install notification daemon as background service
  daemon start     Run daemon in foreground
  daemon start --execute
                   Execute eligible handoff/question messages through claude -p
  daemon status    Check if daemon is running
  harness daemon   Push mode — agents spawn on demand from task events (recommended)
  harness start    Poll mode — agents loop on a timer
  harness start --api  Poll mode with claude -p (API credits)
  harness attach   Attach to the zellij agent session
  harness spawn    Spawn a single agent
  harness list     Show running agents
  harness stop     Stop an agent
  harness stop-all Stop all agents
  status           Show agent identity and config

MCP server (for Claude Code):
  claude mcp add --transport stdio --scope user trunk -- npx tsx ${join(import.meta.dirname, "index.ts")}
`);
}
