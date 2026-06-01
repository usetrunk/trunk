#!/usr/bin/env node
import WebSocket from "ws";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sendNotification } from "./notify.js";

const CONFIG_FILE = join(homedir(), ".trunk", "config.json");
const PUSH_URL = process.env.TRUNK_PUSH_URL || "wss://push.trunk.bot";

type Config = {
  agent_id: string;
  secret: string;
  pairing_code: string;
  name: string;
};

function loadConfig(): Config | null {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function connect(config: Config) {
  const url = `${PUSH_URL}/connect/${config.agent_id}?secret=${config.secret}`;
  const ws = new WebSocket(url);

  ws.on("open", () => {
    console.log(`[trunk-daemon] connected as ${config.name} (${config.agent_id})`);
    console.log(`[trunk-daemon] listening for messages...`);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const content = msg.message?.payload?.content || "(no content)";
      const type = msg.message?.type || "message";
      const fromAgent = msg.message?.fromAgent || "unknown";

      // OS notification
      sendNotification(
        `Trunk: new ${type}`,
        content.length > 100 ? content.slice(0, 100) + "..." : content
      );

      // Console log
      console.log(`[trunk-daemon] ${type} from ${fromAgent}: ${content}`);
    } catch (e) {
      console.error("[trunk-daemon] failed to parse message:", e);
    }
  });

  ws.on("close", () => {
    console.log("[trunk-daemon] disconnected, reconnecting in 5s...");
    setTimeout(() => connect(config), 5000);
  });

  ws.on("error", (err) => {
    console.error("[trunk-daemon] websocket error:", err.message);
  });
}

// --- Main ---

const config = loadConfig();
if (!config) {
  console.error("[trunk-daemon] No config found at ~/.trunk/config.json");
  console.error("[trunk-daemon] Register first: tell your agent 'register with Trunk'");
  process.exit(1);
}

console.log("[trunk-daemon] Trunk notification daemon starting...");
connect(config);

// Keep alive
process.on("SIGINT", () => {
  console.log("\n[trunk-daemon] shutting down");
  process.exit(0);
});
