#!/usr/bin/env node
import WebSocket from "ws";
import type { RawData } from "ws";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sendNotification } from "./notify.js";
import { executeWithClaude, formatExecutionReply } from "./executor.js";
import { classifyCommand, loadPolicy } from "./policy.js";

const CONFIG_FILE = join(homedir(), ".trunk", "config.json");
const PUSH_URL = process.env.TRUNK_PUSH_URL || "wss://push.trunk.bot";
const RELAY_URL = process.env.TRUNK_RELAY_URL || "https://trunk.bot";
const EXECUTE_MODE = process.argv.includes("--execute");

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

  ws.on("message", async (data: RawData) => {
    try {
      const msg = JSON.parse(data.toString());
      const messageId = msg.message?.id;
      const content = msg.message?.payload?.content || "(no content)";
      const type = msg.message?.type || "message";
      const fromAgent = msg.message?.from_agent || "unknown";

      // OS notification
      sendNotification(
        `Trunk: new ${type}`,
        content.length > 100 ? content.slice(0, 100) + "..." : content
      );

      // Console log
      console.log(`[trunk-daemon] ${type} from ${fromAgent}: ${content}`);
      if (EXECUTE_MODE) {
        await handleExecutableMessage(config, messageId, type, content);
      }
    } catch (e) {
      console.error("[trunk-daemon] failed to parse message:", e);
    }
  });

  ws.on("close", () => {
    console.log("[trunk-daemon] disconnected, reconnecting in 5s...");
    setTimeout(() => connect(config), 5000);
  });

  ws.on("error", (err: Error) => {
    console.error("[trunk-daemon] websocket error:", err.message);
  });
}

async function handleExecutableMessage(config: Config, messageId: string | undefined, type: string, content: string) {
  if (!messageId) return;
  if (type !== "handoff" && type !== "question") return;

  const decision = classifyCommand(content, loadPolicy());

  if (decision === "block") {
    await reply(config, messageId, "decision", "Blocked. This command requires an interactive session.");
    return;
  }

  if (decision === "confirm") {
    await reply(config, messageId, "question", `About to execute through Claude Code:\n\n${content}\n\nReply yes to confirm.`);
    return;
  }

  await reply(config, messageId, "ack", `Executing through Claude Code:\n\n${content}`);
  const result = await executeWithClaude(content);
  await reply(config, messageId, result.ok ? "update" : "decision", formatExecutionReply(result));
}

async function reply(config: Config, messageId: string, type: string, content: string) {
  const res = await fetch(`${RELAY_URL}/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.secret}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      type,
      payload: { content, source: "daemon" },
    }),
  });
  if (!res.ok) {
    console.error(`[trunk-daemon] failed to reply to ${messageId}: ${res.status}`);
  }
}

// --- Main ---

const config = loadConfig();
if (!config) {
  console.error("[trunk-daemon] No config found at ~/.trunk/config.json");
  console.error("[trunk-daemon] Register first: tell your agent 'register with Trunk'");
  process.exit(1);
}

console.log(`[trunk-daemon] Trunk daemon starting in ${EXECUTE_MODE ? "execute" : "notify"} mode...`);
connect(config);

// Keep alive
process.on("SIGINT", () => {
  console.log("\n[trunk-daemon] shutting down");
  process.exit(0);
});
