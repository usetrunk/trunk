import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Config ---

const RELAY_URL = process.env.TRUNK_RELAY_URL || "https://trunk.vercel.app";
const PUSH_URL = process.env.TRUNK_PUSH_URL || "wss://trunk-push.koji-e6d.workers.dev";
const CONFIG_DIR = join(homedir(), ".trunk");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

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

function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// --- Relay API helper ---

async function relay(path: string, opts: { method?: string; body?: unknown; secret?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.secret) headers["Authorization"] = `Bearer ${opts.secret}`;

  const res = await fetch(`${RELAY_URL}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  return res.json() as Promise<any>;
}

// --- WebSocket push listener ---

let ws: WebSocket | null = null;
let pendingNotifications: Array<{ type: string; payload: any }> = [];

function connectWebSocket(config: Config) {
  const url = `${PUSH_URL}/connect/${config.agent_id}?secret=${config.secret}`;
  ws = new WebSocket(url);

  ws.on("open", () => {
    process.stderr.write("[trunk] connected to push channel\n");
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      pendingNotifications.push(msg);
      // Write to stderr so the user/agent sees it
      const content = msg.message?.payload?.content || "(no content)";
      const type = msg.message?.type || "message";
      process.stderr.write(`[trunk] NEW ${type}: ${content}\n`);
    } catch {}
  });

  ws.on("close", () => {
    process.stderr.write("[trunk] push disconnected, reconnecting in 5s...\n");
    setTimeout(() => connectWebSocket(config), 5000);
  });

  ws.on("error", () => {
    // Will trigger close -> reconnect
  });
}

// --- MCP Server ---

const server = new McpServer({ name: "trunk", version: "0.1.0" });

server.tool(
  "trunk_register",
  "Register a new agent with Trunk. Stores credentials locally in ~/.trunk/config.json.",
  { name: z.string().describe("Display name for your agent"), owner: z.string().optional().describe("Your name") },
  async ({ name, owner }) => {
    const existing = loadConfig();
    if (existing) {
      return { content: [{ type: "text", text: JSON.stringify({ already_registered: true, agent_id: existing.agent_id, pairing_code: existing.pairing_code, name: existing.name }, null, 2) }] };
    }

    const result = await relay("/agents/register", { method: "POST", body: { name, owner } });
    const config: Config = { agent_id: result.agent_id, secret: result.secret, pairing_code: result.pairing_code, name };
    saveConfig(config);
    connectWebSocket(config);

    return { content: [{ type: "text", text: JSON.stringify({ registered: true, agent_id: result.agent_id, pairing_code: result.pairing_code, instructions: "Share your pairing_code with contacts." }, null, 2) }] };
  }
);

server.tool(
  "trunk_pair",
  "Pair with another agent using their pairing code.",
  { code: z.string().describe("The other agent's pairing code") },
  async ({ code }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered. Call trunk_register first." }], isError: true };

    const result = await relay("/contacts/pair", { method: "POST", secret: config.secret, body: { code } });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_send",
  "Send a structured message to a paired contact.",
  {
    to: z.string().describe("Recipient agent ID"),
    type: z.string().describe("Message type: question, decision, review, handoff, update, ack"),
    content: z.string().describe("Message content"),
    thread_id: z.string().optional().describe("Thread ID to continue a conversation"),
    context: z.string().optional().describe("Background context"),
    urgency: z.enum(["sync", "async"]).optional(),
    finality: z.enum(["proposed", "decided", "fyi"]).optional(),
  },
  async ({ to, type, content, thread_id, context, urgency, finality }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const payload: Record<string, unknown> = { content };
    if (context) payload.context = context;
    if (urgency) payload.urgency = urgency;
    if (finality) payload.finality = finality;

    const result = await relay("/messages", { method: "POST", secret: config.secret, body: { to, type, payload, thread_id } });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_inbox",
  "Check for new messages. Also returns any real-time messages that arrived via push.",
  {},
  async () => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/messages/inbox", { secret: config.secret });
    const msgs = result.messages || [];

    // Include any push notifications that haven't been polled yet
    const pushCount = pendingNotifications.length;
    pendingNotifications = [];

    if (msgs.length === 0 && pushCount === 0) {
      return { content: [{ type: "text", text: "No new messages." }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ messages: msgs, count: msgs.length }, null, 2) }] };
  }
);

server.tool(
  "trunk_reply",
  "Reply to a message in-thread.",
  {
    message_id: z.string().describe("ID of the message to reply to"),
    type: z.string().describe("Response type"),
    content: z.string().describe("Reply content"),
    finality: z.enum(["proposed", "decided", "fyi"]).optional(),
  },
  async ({ message_id, type, content, finality }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const payload: Record<string, unknown> = { content };
    if (finality) payload.finality = finality;

    const result = await relay(`/messages/${message_id}/reply`, { method: "POST", secret: config.secret, body: { type, payload } });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_contacts",
  "List your paired contacts.",
  {},
  async () => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/contacts", { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_thread",
  "View full thread history.",
  { thread_id: z.string().describe("Thread ID") },
  async ({ thread_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/messages/thread/${thread_id}`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_status",
  "Show connection status, identity, and pairing code.",
  {},
  async () => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Not registered. Call trunk_register to get started." }] };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          agent_id: config.agent_id,
          name: config.name,
          pairing_code: config.pairing_code,
          push_connected: ws?.readyState === WebSocket.OPEN,
          pending_notifications: pendingNotifications.length,
        }, null, 2),
      }],
    };
  }
);

// --- Start ---

async function main() {
  // Auto-connect WebSocket if already registered
  const config = loadConfig();
  if (config) {
    connectWebSocket(config);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[trunk] MCP server running (stdio)\n");
}

main().catch((e) => {
  process.stderr.write(`[trunk] fatal: ${e.message}\n`);
  process.exit(1);
});
