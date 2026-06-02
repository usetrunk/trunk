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
  role?: string;
  workspace_code?: string;
  projects?: string[];
  metadata?: Record<string, unknown>;
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
  {
    name: z.string().describe("Display name for your agent"),
    owner: z.string().optional().describe("Your name"),
    role: z.string().optional().describe("Your role or job description (e.g. 'developer agent', 'planner')"),
    workspace_code: z.string().optional().describe("Workspace pairing code to auto-join on registration"),
    projects: z.array(z.string()).optional().describe("Project names or URLs this agent works on"),
    metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata to attach to your profile"),
  },
  async ({ name, owner, role, workspace_code, projects, metadata }) => {
    const existing = loadConfig();
    if (existing) {
      return { content: [{ type: "text", text: JSON.stringify({ already_registered: true, agent_id: existing.agent_id, pairing_code: existing.pairing_code, name: existing.name, role: existing.role, workspace_code: existing.workspace_code, projects: existing.projects }, null, 2) }] };
    }

    const result = await relay("/agents/register", { method: "POST", body: { name, owner } });
    const config: Config = {
      agent_id: result.agent_id,
      secret: result.secret,
      pairing_code: result.pairing_code,
      name,
      role,
      workspace_code,
      projects,
      metadata,
    };
    saveConfig(config);
    connectWebSocket(config);

    // Sync profile fields to server if provided
    if (role !== undefined || projects !== undefined || metadata !== undefined) {
      await relay("/agents/me", { method: "PATCH", secret: result.secret, body: { role, projects, metadata } });
    }

    // Auto-join workspace if workspace_code provided
    let workspaceResult: Record<string, unknown> | undefined;
    if (workspace_code) {
      workspaceResult = await relay("/workspaces/join", { method: "POST", secret: result.secret, body: { code: workspace_code } });
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          registered: true,
          agent_id: result.agent_id,
          pairing_code: result.pairing_code,
          role,
          workspace_code,
          projects,
          workspace: workspaceResult,
          instructions: "Share your pairing_code with contacts.",
        }, null, 2),
      }],
    };
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
  "trunk_sent",
  "View messages you have sent (outbox). Filter by recipient or message type.",
  {
    to: z.string().optional().describe("Filter by recipient agent ID"),
    type: z.string().optional().describe("Filter by message type (e.g. question, update, ack)"),
    limit: z.number().optional().describe("Max messages to return (default 50, max 100)"),
  },
  async ({ to, type, limit }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const params = new URLSearchParams();
    if (to) params.set("to", to);
    if (type) params.set("type", type);
    if (limit !== undefined) params.set("limit", String(limit));
    const query = params.toString();

    const result = await relay(`/messages/sent${query ? `?${query}` : ""}`, { secret: config.secret });
    const msgs = result.messages || [];

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No sent messages found." }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ messages: msgs, count: msgs.length }, null, 2) }] };
  }
);

server.tool(
  "trunk_search",
  "Search your messages by content, type, contact, and date range.",
  {
    q: z.string().optional().describe("Text to search for in message content"),
    type: z.string().optional().describe("Filter by message type (e.g. question, update, ack)"),
    contact: z.string().optional().describe("Filter to messages with a specific agent ID"),
    after: z.string().optional().describe("Only messages after this ISO date"),
    before: z.string().optional().describe("Only messages before this ISO date"),
    limit: z.number().optional().describe("Max results (default 50, max 100)"),
  },
  async ({ q, type, contact, after, before, limit }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Not registered. Use trunk_register first." }] };

    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (type) search.set("type", type);
    if (contact) search.set("contact", contact);
    if (after) search.set("after", after);
    if (before) search.set("before", before);
    if (limit !== undefined) search.set("limit", String(limit));
    const query = search.toString();

    const result = await relay(`/messages/search${query ? `?${query}` : ""}`, { secret: config.secret });
    const msgs = result.messages || [];
    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No messages found matching your search." }] };
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
  "trunk_ack_bulk",
  "Acknowledge multiple messages at once (mark as read/processed). Useful for clearing inbox backlog.",
  {
    message_ids: z.array(z.string()).describe("Array of message IDs to acknowledge (max 100)"),
  },
  async ({ message_ids }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/messages/ack-bulk", {
      method: "POST",
      body: { message_ids },
      secret: config.secret,
    });

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
  "trunk_edit_message",
  "Edit a sent message's payload. Only the original sender can edit.",
  {
    message_id: z.string().describe("ID of the message to edit"),
    content: z.string().describe("New message content"),
    context: z.string().optional().describe("Updated context"),
  },
  async ({ message_id, content, context }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const payload: Record<string, unknown> = { content };
    if (context) payload.context = context;

    const result = await relay(`/messages/${message_id}`, {
      method: "PATCH",
      secret: config.secret,
      body: { payload },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_task_create",
  "Create a task. Scoped to a contact pair, room, or workspace.",
  {
    title: z.string().describe("Task title"),
    contact_id: z.string().optional().describe("Agent ID of the contact (contact-scoped task)"),
    room_id: z.string().optional().describe("Room ID (room-scoped task)"),
    workspace_id: z.string().optional().describe("Workspace ID (workspace-scoped task)"),
    description: z.string().optional().describe("Task description / details"),
    priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Task priority (default: medium)"),
    owner: z.string().optional().describe("Agent ID of who's responsible"),
    due: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    start_date: z.string().optional().describe("Start date for planning (YYYY-MM-DD)"),
    group: z.string().optional().describe("Module/epic grouping (e.g. 'payments', 'auth')"),
    depends_on: z.array(z.string()).optional().describe("Array of task IDs that must be done first"),
    sequence: z.number().optional().describe("Ordering within a group"),
    estimate: z.number().optional().describe("Estimated hours/days"),
    context_ref: z.string().optional().describe("Reference to a thread or message"),
  },
  async ({ title, contact_id, room_id, workspace_id, description, priority, owner, due, start_date, group, depends_on, sequence, estimate, context_ref }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/tasks", {
      method: "POST",
      secret: config.secret,
      body: { contact_id, room_id, workspace_id, title, description, priority, owner, due, start_date, group, depends_on, sequence, estimate, context_ref },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_task_list",
  "List tasks for a contact, room, or workspace.",
  {
    contact_id: z.string().optional().describe("Agent ID of the contact"),
    room_id: z.string().optional().describe("Room ID"),
    workspace_id: z.string().optional().describe("Workspace ID"),
    status: z.string().optional().describe("Filter: open, in-progress, done, blocked"),
    owner: z.string().optional().describe("Filter by owner agent ID"),
    group: z.string().optional().describe("Filter by group/epic"),
  },
  async ({ contact_id, room_id, workspace_id, status, owner, group }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    let path: string;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (owner) params.set("owner", owner);
    if (group) params.set("group", group);
    const query = params.toString();
    if (workspace_id) {
      path = `/tasks/workspace/${workspace_id}${query ? `?${query}` : ""}`;
    } else if (room_id) {
      path = `/tasks/room/${room_id}${query ? `?${query}` : ""}`;
    } else {
      path = `/tasks/${contact_id}${query ? `?${query}` : ""}`;
    }

    const result = await relay(path, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_task_update",
  "Update a task — change status, owner, title, due date, etc.",
  {
    contact_id: z.string().optional().describe("Agent ID of the contact (for contact-scoped tasks)"),
    room_id: z.string().optional().describe("Room ID (for room-scoped tasks)"),
    workspace_id: z.string().optional().describe("Workspace ID (for workspace-scoped tasks)"),
    task_id: z.string().describe("Task ID to update"),
    status: z.string().optional().describe("New status: open, in-progress, done, blocked"),
    priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Update the priority"),
    owner: z.string().optional().describe("Reassign to a different agent"),
    title: z.string().optional().describe("Update the title"),
    description: z.string().optional().describe("Update the description"),
    due: z.string().optional().describe("Update due date (YYYY-MM-DD)"),
    start_date: z.string().optional().describe("Update start date (YYYY-MM-DD)"),
    group: z.string().optional().describe("Update group/epic"),
    depends_on: z.array(z.string()).optional().describe("Update dependency task IDs"),
    sequence: z.number().optional().describe("Update ordering within group"),
    estimate: z.number().optional().describe("Update estimate (hours/days)"),
  },
  async ({ contact_id, room_id, workspace_id, task_id, status, priority, owner, title, description, due, start_date, group, depends_on, sequence, estimate }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const scopeId = contact_id || room_id || workspace_id;
    const body: Record<string, unknown> = {};
    if (status !== undefined) body.status = status;
    if (priority !== undefined) body.priority = priority;
    if (owner !== undefined) body.owner = owner;
    if (title !== undefined) body.title = title;
    if (description !== undefined) body.description = description;
    if (due !== undefined) body.due = due;
    if (start_date !== undefined) body.start_date = start_date;
    if (group !== undefined) body.group = group;
    if (depends_on !== undefined) body.depends_on = depends_on;
    if (sequence !== undefined) body.sequence = sequence;
    if (estimate !== undefined) body.estimate = estimate;

    const result = await relay(`/tasks/${scopeId}/${task_id}`, {
      method: "PATCH",
      secret: config.secret,
      body,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_task_delete",
  "Delete a task permanently.",
  {
    contact_id: z.string().optional().describe("Agent ID of the contact (for contact-scoped tasks)"),
    room_id: z.string().optional().describe("Room ID (for room-scoped tasks)"),
    workspace_id: z.string().optional().describe("Workspace ID (for workspace-scoped tasks)"),
    task_id: z.string().describe("Task ID to delete"),
  },
  async ({ contact_id, room_id, workspace_id, task_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const scopeId = contact_id || room_id || workspace_id;
    const result = await relay(`/tasks/${scopeId}/${task_id}`, {
      method: "DELETE",
      secret: config.secret,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Room tools (consolidated) ---

server.tool(
  "trunk_room",
  "Manage rooms (projects). Actions: create, join, list, members, leave. Rooms are shared spaces for tasks visible to all members.",
  {
    action: z.enum(["create", "join", "list", "members", "leave"]).describe("What to do"),
    name: z.string().optional().describe("Room name (for create)"),
    code: z.string().optional().describe("Join code (for join)"),
    room_id: z.string().optional().describe("Room ID (for members/leave)"),
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
    if (action === "leave") {
      if (!room_id) return { content: [{ type: "text", text: "Error: room_id required for leave" }], isError: true };
      const result = await relay(`/rooms/${room_id}/leave`, { method: "POST", secret: config.secret });
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

    const status: Record<string, unknown> = {
      agent_id: config.agent_id,
      name: config.name,
      pairing_code: config.pairing_code,
      push_connected: ws?.readyState === WebSocket.OPEN,
      pending_notifications: pendingNotifications.length,
    };
    if (config.role !== undefined) status.role = config.role;
    if (config.workspace_code !== undefined) status.workspace_code = config.workspace_code;
    if (config.projects !== undefined) status.projects = config.projects;
    if (config.metadata !== undefined) status.metadata = config.metadata;

    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
);

server.tool(
  "trunk_config",
  "Update your local agent config and sync to server. Set role, workspace_code, projects, or arbitrary metadata without re-registering.",
  {
    role: z.string().optional().describe("Your role description (e.g. 'developer agent', 'planner')"),
    workspace_code: z.string().optional().describe("Workspace pairing code — also auto-joins the workspace"),
    projects: z.array(z.string()).optional().describe("Project names or URLs this agent works on"),
    metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata to merge into your profile"),
  },
  async ({ role, workspace_code, projects, metadata }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    if (role !== undefined) config.role = role;
    if (workspace_code !== undefined) config.workspace_code = workspace_code;
    if (projects !== undefined) config.projects = projects;
    if (metadata !== undefined) config.metadata = { ...(config.metadata ?? {}), ...metadata };
    saveConfig(config);

    // Sync to server
    const serverUpdates: Record<string, unknown> = {};
    if (role !== undefined) serverUpdates.role = role;
    if (projects !== undefined) serverUpdates.projects = projects;
    if (metadata !== undefined) serverUpdates.metadata = metadata;
    if (Object.keys(serverUpdates).length > 0) {
      await relay("/agents/me", { method: "PATCH", secret: config.secret, body: serverUpdates });
    }

    // Auto-join workspace if workspace_code changed
    let workspaceResult: Record<string, unknown> | undefined;
    if (workspace_code) {
      workspaceResult = await relay("/workspaces/join", { method: "POST", secret: config.secret, body: { code: workspace_code } });
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          updated: true,
          role: config.role,
          workspace_code: config.workspace_code,
          projects: config.projects,
          metadata: config.metadata,
          workspace: workspaceResult,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "trunk_profile",
  "Look up another agent's public profile (role, projects, metadata). They must be a contact or workspace co-member.",
  { agent_id: z.string().describe("The agent ID to look up") },
  async ({ agent_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/agents/${agent_id}`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Documents ---

server.tool(
  "trunk_document",
  "Manage shared documents with a contact. Actions: create, list, get, update.",
  {
    action: z.enum(["create", "list", "get", "update"]).describe("Action to perform"),
    contact_id: z.string().describe("Agent ID of the contact (documents are scoped to a contact pair)"),
    doc_id: z.string().optional().describe("Document ID (for get, update)"),
    name: z.string().optional().describe("Document name (for create)"),
    body: z.string().optional().describe("Document body (for create, update)"),
    content_type: z.string().optional().describe("Content type (for create, default: text/markdown)"),
  },
  async ({ action, contact_id, doc_id, name, body, content_type }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    if (action === "create") {
      if (!name || !body) return { content: [{ type: "text", text: "Error: name and body are required for create" }], isError: true };
      const result = await relay(`/documents/${contact_id}`, { method: "POST", secret: config.secret, body: { name, body, content_type } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "list") {
      const result = await relay(`/documents/${contact_id}`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "get") {
      if (!doc_id) return { content: [{ type: "text", text: "Error: doc_id is required for get" }], isError: true };
      const result = await relay(`/documents/${contact_id}/${doc_id}`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "update") {
      if (!doc_id || !body) return { content: [{ type: "text", text: "Error: doc_id and body are required for update" }], isError: true };
      const payload: Record<string, unknown> = { body };
      if (name) payload.name = name;
      const result = await relay(`/documents/${contact_id}/${doc_id}`, { method: "PUT", secret: config.secret, body: payload });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    return { content: [{ type: "text", text: "Error: Unknown action" }], isError: true };
  }
);

// --- Facts (shared context) ---

server.tool(
  "trunk_fact",
  "Manage shared facts (key-value context) with a contact. Actions: get, put, delete.",
  {
    action: z.enum(["get", "put", "delete"]).describe("Action to perform"),
    contact_id: z.string().describe("Agent ID of the contact"),
    key: z.string().describe("Fact key (alphanumeric, dots, hyphens, underscores)"),
    value: z.unknown().optional().describe("Fact value (for put)"),
  },
  async ({ action, contact_id, key, value }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    if (action === "get") {
      const result = await relay(`/context/${contact_id}/facts/${encodeURIComponent(key)}`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "put") {
      if (value === undefined) return { content: [{ type: "text", text: "Error: value is required for put" }], isError: true };
      const result = await relay(`/context/${contact_id}/facts/${encodeURIComponent(key)}`, { method: "PUT", secret: config.secret, body: { value } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "delete") {
      const result = await relay(`/context/${contact_id}/facts/${encodeURIComponent(key)}`, { method: "DELETE", secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    return { content: [{ type: "text", text: "Error: Unknown action" }], isError: true };
  }
);

// --- Billing ---

server.tool(
  "trunk_billing",
  "Check billing status, create a checkout session to upgrade, or open the billing portal. Actions: status, checkout, portal.",
  {
    action: z.enum(["status", "checkout", "portal"]).describe("Billing action"),
    success_url: z.string().optional().describe("Redirect URL after successful checkout"),
    cancel_url: z.string().optional().describe("Redirect URL if checkout is canceled"),
  },
  async ({ action, success_url, cancel_url }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    let path: string;
    let method = "GET";
    let body: Record<string, unknown> | undefined;

    switch (action) {
      case "status":
        path = "/billing/status";
        break;
      case "checkout":
        path = "/billing/checkout";
        method = "POST";
        body = {};
        if (success_url) body.success_url = success_url;
        if (cancel_url) body.cancel_url = cancel_url;
        break;
      case "portal":
        path = "/billing/portal";
        method = "POST";
        break;
    }

    const result = await relay(path, { method, body, secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
