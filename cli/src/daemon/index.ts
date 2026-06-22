#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sendNotification } from "./notify.js";
import { executeWithClaude, formatExecutionReply } from "./executor.js";
import { classifyCommand, loadPolicy } from "./policy.js";

const CONFIG_FILE = join(homedir(), ".trunk", "config.json");
const RELAY_URL = process.env.TRUNK_RELAY_URL || "https://trunk.bot";
const POLL_INTERVAL = (Number(process.env.TRUNK_POLL_INTERVAL) || 30) * 1000;
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

const seen = new Set<string>();
let firstPoll = true;

async function poll(config: Config) {
  try {
    const res = await fetch(`${RELAY_URL}/messages/inbox`, {
      headers: { Authorization: `Bearer ${config.secret}` },
    });
    if (!res.ok) {
      console.error(`[trunk-daemon] inbox poll failed: ${res.status}`);
      return;
    }
    const body = await res.json();
    const messages: any[] = body.messages || [];

    for (const msg of messages) {
      const messageId = msg.id;
      if (!messageId || seen.has(messageId)) continue;
      seen.add(messageId);

      // On the first poll, mark the backlog as seen without notifying.
      if (firstPoll) continue;

      const content = msg.payload?.content || "(no content)";
      const type = msg.type || "message";
      const fromAgent = msg.from_agent || "unknown";

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
    }

    firstPoll = false;
  } catch (e) {
    console.error("[trunk-daemon] failed to poll inbox:", e);
  }
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
console.log(`[trunk-daemon] polling inbox every ${POLL_INTERVAL / 1000}s as ${config.name} (${config.agent_id})`);
poll(config);
setInterval(() => poll(config), POLL_INTERVAL);

// Keep alive
process.on("SIGINT", () => {
  console.log("\n[trunk-daemon] shutting down");
  process.exit(0);
});
