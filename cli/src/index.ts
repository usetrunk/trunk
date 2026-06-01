import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import type { RawData } from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Config ---

const RELAY_URL = process.env.TRUNK_RELAY_URL || "https://trunk.bot";
const PUSH_URL = process.env.TRUNK_PUSH_URL || "wss://push.trunk.bot";
const PROFILE = process.env.TRUNK_PROFILE;
const CONFIG_DIR = join(homedir(), ".trunk");
const CONFIG_FILE = join(CONFIG_DIR, PROFILE ? `config.${PROFILE}.json` : "config.json");

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

async function relay(path: string, opts: { method?: string; body?: unknown; secret?: string; idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.secret) headers["Authorization"] = `Bearer ${opts.secret}`;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

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

  ws.on("message", (data: RawData) => {
    try {
      const msg = JSON.parse(data.toString());
      pendingNotifications.push(msg);
      const content = msg.message?.payload?.content || "(no content)";
      const type = msg.message?.type || "message";
      const from = msg.message?.fromAgent || "unknown";

      // Send MCP logging notification — this is the real-time push to Claude Code
      server.server.sendLoggingMessage({
        level: "info",
        logger: "trunk",
        data: `[TRUNK MESSAGE] New ${type} from ${from}: ${content}`,
      }).catch(() => {});

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
    reply_to: z.string().optional().describe("Message ID this message replies to"),
    idempotency_key: z.string().optional().describe("Optional stable key for retry-safe sends"),
    context: z.string().optional().describe("Background context"),
    urgency: z.enum(["sync", "async"]).optional(),
    finality: z.enum(["proposed", "decided", "fyi"]).optional(),
  },
  async ({ to, type, content, thread_id, reply_to, idempotency_key, context, urgency, finality }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const payload: Record<string, unknown> = { content };
    if (context) payload.context = context;
    if (urgency) payload.urgency = urgency;
    if (finality) payload.finality = finality;

    const result = await relay("/messages", {
      method: "POST",
      secret: config.secret,
      idempotencyKey: idempotency_key ?? crypto.randomUUID(),
      body: { to, type, payload, thread_id, reply_to },
    });
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
    reply_to: z.string().optional().describe("Message ID this reply directly answers"),
    idempotency_key: z.string().optional().describe("Optional stable key for retry-safe replies"),
    finality: z.enum(["proposed", "decided", "fyi"]).optional(),
  },
  async ({ message_id, type, content, reply_to, idempotency_key, finality }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const payload: Record<string, unknown> = { content };
    if (finality) payload.finality = finality;

    const result = await relay(`/messages/${message_id}/reply`, {
      method: "POST",
      secret: config.secret,
      idempotencyKey: idempotency_key ?? crypto.randomUUID(),
      body: { type, payload, reply_to },
    });
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
  "trunk_task_create",
  "Create a task for a contact. Both agents can see and update it.",
  {
    contact_id: z.string().describe("Agent ID of the contact this task is for"),
    title: z.string().describe("Task title"),
    description: z.string().optional().describe("Task description / details"),
    owner: z.string().optional().describe("Agent ID of who's responsible (defaults to contact)"),
    due: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    context_ref: z.string().optional().describe("Reference to a thread or message"),
  },
  async ({ contact_id, title, description, owner, due, context_ref }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/tasks", {
      method: "POST",
      secret: config.secret,
      body: { contact_id, title, description, owner, due, context_ref },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_task_list",
  "List tasks with a contact. Filter by status or owner.",
  {
    contact_id: z.string().describe("Agent ID of the contact"),
    status: z.string().optional().describe("Filter: open, in-progress, done, blocked"),
    owner: z.string().optional().describe("Filter by owner agent ID"),
  },
  async ({ contact_id, status, owner }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    let path = `/tasks/${contact_id}`;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (owner) params.set("owner", owner);
    const query = params.toString();
    if (query) path += `?${query}`;

    const result = await relay(path, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_task_update",
  "Update a task — change status, owner, title, due date, etc.",
  {
    contact_id: z.string().describe("Agent ID of the contact"),
    task_id: z.string().describe("Task ID to update"),
    status: z.string().optional().describe("New status: open, in-progress, done, blocked"),
    owner: z.string().optional().describe("Reassign to a different agent"),
    title: z.string().optional().describe("Update the title"),
    description: z.string().optional().describe("Update the description"),
    due: z.string().optional().describe("Update due date (YYYY-MM-DD)"),
  },
  async ({ contact_id, task_id, status, owner, title, description, due }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const body: Record<string, unknown> = {};
    if (status !== undefined) body.status = status;
    if (owner !== undefined) body.owner = owner;
    if (title !== undefined) body.title = title;
    if (description !== undefined) body.description = description;
    if (due !== undefined) body.due = due;

    const result = await relay(`/tasks/${contact_id}/${task_id}`, {
      method: "PATCH",
      secret: config.secret,
      body,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Room tools (consolidated) ---

server.tool(
  "trunk_room",
  "Manage rooms (projects). Actions: create, join, list, members. Rooms are shared spaces for tasks visible to all members.",
  {
    action: z.enum(["create", "join", "list", "members"]).describe("What to do"),
    name: z.string().optional().describe("Room name (for create)"),
    code: z.string().optional().describe("Join code (for join)"),
    room_id: z.string().optional().describe("Room ID (for members)"),
  },
  async ({ action, name, code, room_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    if (action === "create") {
      if (!name) return { content: [{ type: "text", text: "Error: name required for create" }], isError: true };
      const result = await relay("/rooms", { method: "POST", secret: config.secret, body: { name } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "join") {
      if (!code) return { content: [{ type: "text", text: "Error: code required for join" }], isError: true };
      const result = await relay("/rooms/join", { method: "POST", secret: config.secret, body: { code } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "list") {
      const result = await relay("/rooms", { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "members") {
      if (!room_id) return { content: [{ type: "text", text: "Error: room_id required for members" }], isError: true };
      const result = await relay(`/rooms/${room_id}/members`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    return { content: [{ type: "text", text: "Unknown action" }], isError: true };
  }
);

server.tool(
  "trunk_workspace",
  "Manage workspaces — groups of agents that share contacts. Actions: create, join, status, members, leave.",
  {
    action: z.enum(["create", "join", "status", "members", "leave"]).describe("Action to perform"),
    name: z.string().optional().describe("Workspace name (for create)"),
    code: z.string().optional().describe("Workspace pairing code (for join)"),
  },
  async ({ action, name, code }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    if (action === "create") {
      if (!name) return { content: [{ type: "text", text: "Error: name required for create" }], isError: true };
      const result = await relay("/workspaces", { method: "POST", secret: config.secret, body: { name } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "join") {
      if (!code) return { content: [{ type: "text", text: "Error: code required for join" }], isError: true };
      const result = await relay("/workspaces/join", { method: "POST", secret: config.secret, body: { code } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "status") {
      const result = await relay("/workspaces/me", { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "members") {
      const ws = await relay("/workspaces/me", { secret: config.secret });
      if (ws.error) return { content: [{ type: "text", text: `Error: ${ws.error}` }], isError: true };
      const result = await relay(`/workspaces/${ws.workspace.id}/members`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "leave") {
      const result = await relay("/workspaces/leave", { method: "POST", secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    return { content: [{ type: "text", text: "Unknown action" }], isError: true };
  }
);

server.tool(
  "trunk_project",
  "Read .trunk file from a directory OR initialize one. Shows linked room, members, open tasks. Auto-joins the room.",
  {
    action: z.enum(["status", "init"]).optional().describe("init = create room + .trunk file. status (default) = read existing."),
    room_name: z.string().optional().describe("Room name (for init)"),
    directory: z.string().optional().describe("Directory (defaults to cwd)"),
  },
  async ({ action, room_name, directory }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const dir = directory || process.cwd();
    const trunkFile = join(dir, ".trunk");

    if (action === "init") {
      if (!room_name) return { content: [{ type: "text", text: "Error: room_name required for init" }], isError: true };
      const room = await relay("/rooms", { method: "POST", secret: config.secret, body: { name: room_name } });
      const trunkConfig = { project: room_name, room_id: room.id, join_code: room.pairing_code };
      writeFileSync(trunkFile, JSON.stringify(trunkConfig, null, 2) + "\n");
      return { content: [{ type: "text", text: JSON.stringify({ initialized: true, ...trunkConfig, instructions: `Share join code ${room.pairing_code} with collaborators.` }, null, 2) }] };
    }

    // Default: status
    if (!existsSync(trunkFile)) {
      return { content: [{ type: "text", text: `No .trunk file found in ${dir}. Use trunk_project with action=init to set up.` }] };
    }
    const trunkConfig = JSON.parse(readFileSync(trunkFile, "utf-8"));
    await relay("/rooms/join", { method: "POST", secret: config.secret, body: { code: trunkConfig.join_code } }).catch(() => {});
    const tasks = await relay(`/tasks/room/${trunkConfig.room_id}?status=open`, { secret: config.secret }).catch(() => ({ tasks: [] }));
    const members = await relay(`/rooms/${trunkConfig.room_id}/members`, { secret: config.secret }).catch(() => ({ members: [] }));
    return { content: [{ type: "text", text: JSON.stringify({ project: trunkConfig.project, room_id: trunkConfig.room_id, join_code: trunkConfig.join_code, members: members.members || [], open_tasks: tasks.tasks || [] }, null, 2) }] };
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
