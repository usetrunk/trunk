#!/usr/bin/env node
/**
 * Trunk CLI — standalone commands (not MCP).
 *
 * Usage:
 *   npx @usetrunk/cli daemon install   — install as background service
 *   npx @usetrunk/cli daemon start     — run in foreground
 *   npx @usetrunk/cli daemon status    — check if running
 *   npx @usetrunk/cli status           — show agent info
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";

const CONFIG_FILE = join(homedir(), ".trunk", "config.json");

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
    console.log("Usage: trunk daemon [install|start|status]");
  }
} else if (command === "status") {
  const config = loadConfig();
  if (!config) {
    console.log("Not registered. Set up the MCP server and tell your agent to register.");
  } else {
    console.log(`Agent: ${config.name}`);
    console.log(`ID: ${config.agent_id}`);
    console.log(`Pairing code: ${config.pairing_code}`);
    console.log(`Config: ${CONFIG_FILE}`);
  }
} else {
  console.log(`Trunk CLI v0.1.0

Commands:
  daemon install   Install notification daemon as background service
  daemon start     Run daemon in foreground
  daemon status    Check if daemon is running
  status           Show agent identity and config

MCP server (for Claude Code):
  claude mcp add --transport stdio --scope user trunk -- npx tsx ${join(import.meta.dirname, "index.ts")}
`);
}
