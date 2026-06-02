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
  "Send a structured message to a paired contact, workspace, or room. Use 'workspace:<id>' for workspace fan-out or 'room:<id>' for room fan-out.",
  {
    to: z.string().describe("Recipient agent ID, or 'workspace:<id>' for workspace fan-out, or 'room:<id>' for room fan-out"),
    type: z.string().describe("Message type: question, decision, review, handoff, update, ack"),
    content: z.string().describe("Message content"),
    thread_id: z.string().optional().describe("Thread ID to continue a conversation"),
    reply_to: z.string().optional().describe("Message ID this message replies to"),
    idempotency_key: z.string().optional().describe("Optional stable key for retry-safe sends"),
    context: z.string().optional().describe("Background context"),
    urgency: z.enum(["sync", "async"]).optional(),
    finality: z.enum(["proposed", "decided", "fyi"]).optional(),
    scheduled_at: z.string().optional().describe("ISO 8601 date for deferred delivery (must be in the future)"),
    expires_at: z.string().optional().describe("ISO 8601 date when message expires"),
    ttl_seconds: z.number().optional().describe("Time-to-live in seconds (alternative to expires_at)"),
  },
  async ({ to, type, content, thread_id, reply_to, idempotency_key, context, urgency, finality, scheduled_at, expires_at, ttl_seconds }) => {
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
      body: { to, type, payload, thread_id, reply_to, ...(scheduled_at ? { scheduled_at } : {}), ...(expires_at ? { expires_at } : {}), ...(ttl_seconds ? { ttl_seconds } : {}) },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_inbox",
  "Check for new messages. Also returns any real-time messages that arrived via push. Supports cursor pagination.",
  {
    limit: z.number().optional().describe("Max messages to return (default 50, max 100)"),
    cursor: z.string().optional().describe("Pagination cursor from a previous response"),
  },
  async ({ limit, cursor }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();

    const result = await relay(`/messages/inbox${query ? `?${query}` : ""}`, { secret: config.secret });
    const msgs = result.messages || [];

    // Include any push notifications that haven't been polled yet
    const pushCount = pendingNotifications.length;
    pendingNotifications = [];

    if (msgs.length === 0 && pushCount === 0) {
      return { content: [{ type: "text", text: "No new messages." }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ messages: msgs, count: msgs.length, next_cursor: result.next_cursor, has_more: result.has_more }, null, 2) }] };
  }
);

server.tool(
  "trunk_inbox_stats",
  "Get inbox summary — unread count, total messages, breakdown by type and status.",
  {},
  async () => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/messages/inbox/stats", { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_sent",
  "View messages you have sent (outbox). Filter by recipient or message type. Supports cursor pagination.",
  {
    to: z.string().optional().describe("Filter by recipient agent ID"),
    type: z.string().optional().describe("Filter by message type (e.g. question, update, ack)"),
    limit: z.number().optional().describe("Max messages to return (default 50, max 100)"),
    cursor: z.string().optional().describe("Pagination cursor from a previous response"),
  },
  async ({ to, type, limit, cursor }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const params = new URLSearchParams();
    if (to) params.set("to", to);
    if (type) params.set("type", type);
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();

    const result = await relay(`/messages/sent${query ? `?${query}` : ""}`, { secret: config.secret });
    const msgs = result.messages || [];

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No sent messages found." }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ messages: msgs, count: msgs.length, next_cursor: result.next_cursor, has_more: result.has_more }, null, 2) }] };
  }
);

server.tool(
  "trunk_search",
  "Search your messages by content, type, contact, and date range. Supports cursor pagination.",
  {
    q: z.string().optional().describe("Text to search for in message content"),
    type: z.string().optional().describe("Filter by message type (e.g. question, update, ack)"),
    contact: z.string().optional().describe("Filter to messages with a specific agent ID"),
    after: z.string().optional().describe("Only messages after this ISO date"),
    before: z.string().optional().describe("Only messages before this ISO date"),
    limit: z.number().optional().describe("Max results (default 50, max 100)"),
    cursor: z.string().optional().describe("Pagination cursor from a previous response"),
  },
  async ({ q, type, contact, after, before, limit, cursor }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Not registered. Use trunk_register first." }] };

    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (type) search.set("type", type);
    if (contact) search.set("contact", contact);
    if (after) search.set("after", after);
    if (before) search.set("before", before);
    if (limit !== undefined) search.set("limit", String(limit));
    if (cursor) search.set("cursor", cursor);
    const query = search.toString();

    const result = await relay(`/messages/search${query ? `?${query}` : ""}`, { secret: config.secret });
    const msgs = result.messages || [];
    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No messages found matching your search." }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ messages: msgs, count: msgs.length, next_cursor: result.next_cursor, has_more: result.has_more }, null, 2) }] };
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
  "trunk_unpair",
  "Remove a contact pairing. Both agents lose the ability to message each other.",
  {
    agent_id: z.string().describe("The contact's agent ID to unpair from"),
  },
  async ({ agent_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/contacts/${encodeURIComponent(agent_id)}`, { method: "DELETE", secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_update_contact",
  "Update a contact's alias (your nickname for them).",
  {
    agent_id: z.string().describe("The contact's agent ID"),
    alias: z.string().nullable().describe("New alias (set null to remove)"),
  },
  async ({ agent_id, alias }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/contacts/${agent_id}`, { method: "PATCH", secret: config.secret, body: { alias } });
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
  "trunk_read_bulk",
  "Mark multiple messages as read without processing. Useful for marking messages as seen without acknowledging.",
  {
    message_ids: z.array(z.string()).describe("Array of message IDs to mark as read (max 100)"),
  },
  async ({ message_ids }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/messages/read-bulk", {
      method: "POST",
      body: { message_ids },
      secret: config.secret,
    });

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_delete_bulk",
  "Soft-delete multiple messages at once. Only the sender of each message can delete it.",
  {
    message_ids: z.array(z.string()).describe("Array of message IDs to delete (max 100)"),
  },
  async ({ message_ids }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/messages/delete-bulk", {
      method: "POST",
      body: { message_ids },
      secret: config.secret,
    });

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_label_bulk",
  "Add a label to multiple messages at once. You must be sender or recipient of each message.",
  {
    message_ids: z.array(z.string()).describe("Array of message IDs to label (max 100)"),
    label: z.string().describe("Label to add to all specified messages"),
  },
  async ({ message_ids, label }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/messages/label-bulk", {
      method: "POST",
      body: { message_ids, label },
      secret: config.secret,
    });

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_delete_message",
  "Soft-delete a sent message. Only the original sender can delete.",
  { message_id: z.string().describe("ID of the message to delete") },
  async ({ message_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/messages/${message_id}`, { method: "DELETE", secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_purge_messages",
  "Purge messages older than the specified number of days. Defaults to 90 days.",
  { days: z.number().optional().describe("Number of days to retain (default: 90)") },
  async ({ days }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/messages/purge-expired`, {
      method: "POST",
      secret: config.secret,
      body: { days: days ?? 90 },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_scheduled_messages",
  "List your scheduled messages that haven't been delivered yet.",
  {
    limit: z.number().optional().describe("Max results (default 20)"),
    cursor: z.string().optional().describe("Pagination cursor"),
  },
  async ({ limit, cursor }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();
    const result = await relay(`/messages/scheduled${query ? `?${query}` : ""}`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_cancel_scheduled",
  "Cancel a scheduled message before it is delivered. Only the sender can cancel.",
  {
    message_id: z.string().describe("ID of the scheduled message to cancel"),
  },
  async ({ message_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/messages/${message_id}/cancel`, {
      method: "POST",
      secret: config.secret,
      body: {},
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_forward",
  "Forward a message to another contact. Preserves the original type and payload with provenance metadata.",
  {
    message_id: z.string().describe("ID of the message to forward"),
    to: z.string().describe("Recipient agent ID"),
    comment: z.string().optional().describe("Optional comment to include with the forwarded message"),
  },
  async ({ message_id, to, comment }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/messages/${message_id}/forward`, {
      method: "POST",
      secret: config.secret,
      body: { to, comment },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_react",
  "Add an emoji reaction to a message. Lightweight feedback without sending a full reply.",
  {
    message_id: z.string().describe("ID of the message to react to"),
    emoji: z.string().describe("Emoji or short text reaction (e.g. '👍', 'ack', 'lgtm')"),
  },
  async ({ message_id, emoji }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/messages/${message_id}/react`, {
      method: "POST",
      secret: config.secret,
      body: { emoji },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_unreact",
  "Remove an emoji reaction from a message.",
  {
    message_id: z.string().describe("ID of the message"),
    emoji: z.string().describe("Emoji to remove"),
  },
  async ({ message_id, emoji }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/messages/${message_id}/react/${encodeURIComponent(emoji)}`, {
      method: "DELETE",
      secret: config.secret,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_reactions",
  "List all reactions on a message, grouped by emoji.",
  {
    message_id: z.string().describe("ID of the message"),
  },
  async ({ message_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/messages/${message_id}/reactions`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_pin",
  "Pin a message in a thread. Surfaces key decisions and information.",
  {
    message_id: z.string().describe("ID of the message to pin"),
  },
  async ({ message_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/messages/${encodeURIComponent(message_id)}/pin`, { method: "POST", secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_unpin",
  "Unpin a message in a thread.",
  {
    message_id: z.string().describe("ID of the message to unpin"),
  },
  async ({ message_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/messages/${encodeURIComponent(message_id)}/unpin`, { method: "POST", secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_thread_pins",
  "List all pinned messages in a thread. Quickly find key decisions and information.",
  {
    thread_id: z.string().describe("Thread ID"),
  },
  async ({ thread_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/messages/thread/${encodeURIComponent(thread_id)}/pins`, { secret: config.secret });
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
  "trunk_thread_summary",
  "Get a structured digest of a thread — participants, message counts, decisions, open questions, and timeline.",
  { thread_id: z.string().describe("Thread ID to summarize") },
  async ({ thread_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/messages/thread/${thread_id}/summary`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_edit_message",
  "Edit a sent message's payload. Only the original sender can edit within 15 minutes. Tracks edit history.",
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
  "trunk_message_edit_history",
  "Get the edit history of a message. Shows all previous versions of the payload.",
  {
    message_id: z.string().describe("ID of the message"),
  },
  async ({ message_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/messages/${message_id}/edits`, {
      secret: config.secret,
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
  "List tasks for a contact, room, or workspace. Supports cursor pagination.",
  {
    contact_id: z.string().optional().describe("Agent ID of the contact"),
    room_id: z.string().optional().describe("Room ID"),
    workspace_id: z.string().optional().describe("Workspace ID"),
    status: z.string().optional().describe("Filter: open, in-progress, done, blocked"),
    owner: z.string().optional().describe("Filter by owner agent ID"),
    group: z.string().optional().describe("Filter by group/epic"),
    limit: z.number().optional().describe("Max tasks to return (default 50, max 100)"),
    cursor: z.string().optional().describe("Pagination cursor from a previous response"),
  },
  async ({ contact_id, room_id, workspace_id, status, owner, group, limit, cursor }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    let path: string;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (owner) params.set("owner", owner);
    if (group) params.set("group", group);
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
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
  "Manage rooms (projects). Actions: create, join, list, members, leave, update, kick, role, delete.",
  {
    action: z.enum(["create", "join", "list", "members", "leave", "update", "kick", "role", "delete"]).describe("What to do"),
    name: z.string().optional().describe("Room name (for create/update)"),
    code: z.string().optional().describe("Join code (for join)"),
    room_id: z.string().optional().describe("Room ID (for members/leave/update/kick/role/delete)"),
    agent_id: z.string().optional().describe("Target agent ID (for kick/role)"),
    role: z.enum(["admin", "member"]).optional().describe("New role (for role action)"),
    metadata: z.record(z.unknown()).optional().describe("Room metadata (for create/update)"),
  },
  async ({ action, name, code, room_id, agent_id, role, metadata }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    if (action === "create") {
      if (!name) return { content: [{ type: "text", text: "Error: name required for create" }], isError: true };
      const result = await relay("/rooms", { method: "POST", secret: config.secret, body: { name, metadata } });
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
    if (action === "update") {
      if (!room_id) return { content: [{ type: "text", text: "Error: room_id required for update" }], isError: true };
      const result = await relay(`/rooms/${room_id}`, { method: "PATCH", secret: config.secret, body: { name, metadata } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "kick") {
      if (!room_id) return { content: [{ type: "text", text: "Error: room_id required for kick" }], isError: true };
      if (!agent_id) return { content: [{ type: "text", text: "Error: agent_id required for kick" }], isError: true };
      const result = await relay(`/rooms/${room_id}/kick`, { method: "POST", secret: config.secret, body: { agent_id } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "role") {
      if (!room_id) return { content: [{ type: "text", text: "Error: room_id required for role" }], isError: true };
      if (!agent_id) return { content: [{ type: "text", text: "Error: agent_id required for role" }], isError: true };
      if (!role) return { content: [{ type: "text", text: "Error: role required (admin or member)" }], isError: true };
      const result = await relay(`/rooms/${room_id}/members/${agent_id}/role`, { method: "PUT", secret: config.secret, body: { role } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "delete") {
      if (!room_id) return { content: [{ type: "text", text: "Error: room_id required for delete" }], isError: true };
      const result = await relay(`/rooms/${room_id}`, { method: "DELETE", secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    return { content: [{ type: "text", text: "Unknown action" }], isError: true };
  }
);

server.tool(
  "trunk_workspace",
  "Manage workspaces — groups of agents that share contacts. Actions: create, join, status, members, leave, update, kick, role, delete.",
  {
    action: z.enum(["create", "join", "status", "members", "leave", "update", "kick", "role", "delete"]).describe("Action to perform"),
    name: z.string().optional().describe("Workspace name (for create/update)"),
    code: z.string().optional().describe("Workspace pairing code (for join)"),
    metadata: z.record(z.unknown()).optional().describe("Workspace metadata (for update)"),
    agent_id: z.string().optional().describe("Target agent ID (for kick/role)"),
    role: z.enum(["admin", "member"]).optional().describe("New role (for role action)"),
  },
  async ({ action, name, code, metadata, agent_id, role }) => {
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
    if (action === "update") {
      const result = await relay("/workspaces/me", { method: "PATCH", secret: config.secret, body: { name, metadata } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "kick") {
      if (!agent_id) return { content: [{ type: "text", text: "Error: agent_id required for kick" }], isError: true };
      const result = await relay("/workspaces/kick", { method: "POST", secret: config.secret, body: { agent_id } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "role") {
      if (!agent_id || !role) return { content: [{ type: "text", text: "Error: agent_id and role required" }], isError: true };
      const result = await relay(`/workspaces/members/${agent_id}/role`, { method: "PATCH", secret: config.secret, body: { role } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "delete") {
      const result = await relay("/workspaces", { method: "DELETE", secret: config.secret });
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
  "trunk_analytics",
  "Get your communication analytics — message volume, top contacts, response times, and type breakdown.",
  {
    days: z.number().optional().describe("Number of days to analyze (default 7, max 30)"),
  },
  async ({ days }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const params = new URLSearchParams();
    if (days !== undefined) params.set("days", String(days));
    const query = params.toString();
    const result = await relay(`/agents/me/analytics${query ? `?${query}` : ""}`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

server.tool(
  "trunk_webhook",
  "Manage webhook configuration. Actions: status (view config), set (configure URL), remove (clear URL), rotate_secret (new signing secret), deliveries (recent delivery log), test (send test ping).",
  {
    action: z.enum(["status", "set", "remove", "rotate_secret", "deliveries", "test"]).describe("Action to perform"),
    url: z.string().optional().describe("Webhook URL (required for 'set' action)"),
    limit: z.number().optional().describe("Max deliveries to return (for 'deliveries' action, default 20)"),
  },
  async ({ action, url, limit: deliveryLimit }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    if (action === "status") {
      const result = await relay("/agents/me/webhook", { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "set") {
      if (!url) return { content: [{ type: "text", text: "Error: url is required for 'set' action" }], isError: true };
      const result = await relay("/agents/me/webhook", { method: "PUT", secret: config.secret, body: { url } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "remove") {
      const result = await relay("/agents/me/webhook", { method: "DELETE", secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "rotate_secret") {
      const result = await relay("/agents/me/webhook/rotate-secret", { method: "POST", secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "deliveries") {
      const query = deliveryLimit ? `?limit=${deliveryLimit}` : "";
      const result = await relay(`/agents/me/webhook/deliveries${query}`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "test") {
      const result = await relay("/agents/me/webhook/test", { method: "POST", secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    return { content: [{ type: "text", text: "Error: Unknown action" }], isError: true };
  }
);

// --- Presence ---

server.tool(
  "trunk_presence",
  "Show which workspace members are online, away, or offline. Based on last API activity.",
  {},
  async () => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/agents/presence", { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Documents ---

server.tool(
  "trunk_document",
  "Manage shared documents with a contact or room. Actions: create, list, get, update, delete. Provide contact_id or room_id.",
  {
    action: z.enum(["create", "list", "get", "update", "delete"]).describe("Action to perform"),
    contact_id: z.string().optional().describe("Agent ID of the contact (for contact-scoped documents)"),
    room_id: z.string().optional().describe("Room ID (for room-scoped documents)"),
    workspace_id: z.string().optional().describe("Workspace ID (for workspace-scoped documents)"),
    doc_id: z.string().optional().describe("Document ID (for get, update, delete)"),
    name: z.string().optional().describe("Document name (for create)"),
    body: z.string().optional().describe("Document body (for create, update)"),
    content_type: z.string().optional().describe("Content type (for create, default: text/markdown)"),
    limit: z.number().optional().describe("Max documents to return for list action (default 50, max 100)"),
    cursor: z.string().optional().describe("Pagination cursor for list action"),
  },
  async ({ action, contact_id, room_id, workspace_id, doc_id, name, body, content_type, limit, cursor }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const scopePath = workspace_id ? `workspace/${workspace_id}` : room_id ? `room/${room_id}` : contact_id;
    if (!scopePath) return { content: [{ type: "text", text: "Error: contact_id, room_id, or workspace_id is required" }], isError: true };

    if (action === "create") {
      if (!name || !body) return { content: [{ type: "text", text: "Error: name and body are required for create" }], isError: true };
      const result = await relay(`/documents/${scopePath}`, { method: "POST", secret: config.secret, body: { name, body, content_type } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "list") {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      const query = params.toString();
      const result = await relay(`/documents/${scopePath}${query ? `?${query}` : ""}`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "get") {
      if (!doc_id) return { content: [{ type: "text", text: "Error: doc_id is required for get" }], isError: true };
      const result = await relay(`/documents/${scopePath}/${doc_id}`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "update") {
      if (!doc_id || !body) return { content: [{ type: "text", text: "Error: doc_id and body are required for update" }], isError: true };
      const payload: Record<string, unknown> = { body };
      if (name) payload.name = name;
      const result = await relay(`/documents/${scopePath}/${doc_id}`, { method: "PUT", secret: config.secret, body: payload });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "delete") {
      if (!doc_id) return { content: [{ type: "text", text: "Error: doc_id is required for delete" }], isError: true };
      const result = await relay(`/documents/${scopePath}/${doc_id}`, { method: "DELETE", secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    return { content: [{ type: "text", text: "Error: Unknown action" }], isError: true };
  }
);

server.tool(
  "trunk_document_versions",
  "List version history or get a specific version of a shared document. Works with contact or room-scoped docs.",
  {
    contact_id: z.string().optional().describe("Agent ID of the contact (for contact-scoped docs)"),
    room_id: z.string().optional().describe("Room ID (for room-scoped docs)"),
    workspace_id: z.string().optional().describe("Workspace ID (for workspace-scoped docs)"),
    doc_id: z.string().describe("Document ID"),
    version: z.number().optional().describe("Specific version to retrieve (omit for full history)"),
  },
  async ({ contact_id, room_id, workspace_id, doc_id, version }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const scopePath = workspace_id ? `workspace/${workspace_id}` : room_id ? `room/${room_id}` : contact_id;
    if (!scopePath) return { content: [{ type: "text", text: "Error: contact_id, room_id, or workspace_id is required" }], isError: true };

    if (version !== undefined) {
      const result = await relay(`/documents/${encodeURIComponent(scopePath)}/${encodeURIComponent(doc_id)}/versions/${version}`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    const result = await relay(`/documents/${encodeURIComponent(scopePath)}/${encodeURIComponent(doc_id)}/versions`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_gantt",
  "Get workspace tasks with dependency tracking, grouping, and progress summary for Gantt chart visualization.",
  {
    workspace_id: z.string().describe("Workspace ID"),
  },
  async ({ workspace_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/tasks/gantt/workspace/${encodeURIComponent(workspace_id)}`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Facts (shared context) ---

server.tool(
  "trunk_fact",
  "Manage shared facts (key-value context) with a contact or room. Actions: list, get, put, delete. Provide contact_id or room_id.",
  {
    action: z.enum(["list", "get", "put", "delete"]).describe("Action to perform"),
    contact_id: z.string().optional().describe("Agent ID of the contact (for contact-scoped facts)"),
    room_id: z.string().optional().describe("Room ID (for room-scoped facts)"),
    workspace_id: z.string().optional().describe("Workspace ID (for workspace-scoped facts)"),
    key: z.string().optional().describe("Fact key (required for get/put/delete, not needed for list)"),
    value: z.unknown().optional().describe("Fact value (for put)"),
  },
  async ({ action, contact_id, room_id, workspace_id, key, value }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const scopePath = workspace_id ? `workspace/${workspace_id}` : room_id ? `room/${room_id}` : contact_id;
    if (!scopePath) return { content: [{ type: "text", text: "Error: contact_id, room_id, or workspace_id is required" }], isError: true };

    if (action === "list") {
      const result = await relay(`/context/${scopePath}/facts`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (!key) return { content: [{ type: "text", text: "Error: key is required for get/put/delete actions" }], isError: true };

    if (action === "get") {
      const result = await relay(`/context/${scopePath}/facts/${encodeURIComponent(key)}`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "put") {
      if (value === undefined) return { content: [{ type: "text", text: "Error: value is required for put" }], isError: true };
      const result = await relay(`/context/${scopePath}/facts/${encodeURIComponent(key)}`, { method: "PUT", secret: config.secret, body: { value } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (action === "delete") {
      const result = await relay(`/context/${scopePath}/facts/${encodeURIComponent(key)}`, { method: "DELETE", secret: config.secret });
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

server.tool(
  "trunk_threads",
  "List threads you participate in, sorted by latest activity. Returns thread ID, message count, unread count, participants, and a preview of the last message.",
  {
    limit: z.number().optional().describe("Max threads to return (default 20, max 50)"),
    cursor: z.string().optional().describe("Thread ID cursor from previous response for pagination"),
  },
  async ({ limit, cursor }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered. Use trunk_register first." }], isError: true };

    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();
    const result = await relay(`/messages/threads${query ? `?${query}` : ""}`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_audit_log",
  "Query your audit log. Returns a paginated list of actions you've performed (message sends, contact pairs, fact updates, etc.). Filter by action, target type, target ID, or date range.",
  {
    action: z.string().optional().describe("Filter by action (e.g. 'message.send', 'contact.pair', 'fact.upsert')"),
    target_type: z.string().optional().describe("Filter by target type (e.g. 'message', 'agent', 'workspace', 'shared_fact')"),
    target_id: z.string().optional().describe("Filter by target ID"),
    after: z.string().optional().describe("Only events after this ISO 8601 date"),
    before: z.string().optional().describe("Only events before this ISO 8601 date"),
    limit: z.number().optional().describe("Max events to return (default 50, max 100)"),
    cursor: z.string().optional().describe("Pagination cursor from previous response"),
  },
  async ({ action, target_type, target_id, after, before, limit, cursor }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered. Use trunk_register first." }], isError: true };

    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (target_type) params.set("target_type", target_type);
    if (target_id) params.set("target_id", target_id);
    if (after) params.set("after", after);
    if (before) params.set("before", before);
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();
    const result = await relay(`/audit-events${query ? `?${query}` : ""}`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_mark_read",
  "Mark a message as read without processing/acking it.",
  {
    message_id: z.string().describe("ID of the message to mark as read"),
  },
  async ({ message_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/messages/${encodeURIComponent(message_id)}/read`, { method: "POST", secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_set_status",
  "Set your custom status text visible to workspace co-members. Pass null to clear.",
  {
    text: z.string().nullable().describe("Status text or null to clear"),
  },
  async ({ text }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay("/agents/me/status", { method: "PUT", secret: config.secret, body: { text } });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_contact_note",
  "Get your private note about a contact.",
  {
    contact_id: z.string().describe("Agent ID of the contact"),
  },
  async ({ contact_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/contacts/${encodeURIComponent(contact_id)}/notes`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_set_contact_note",
  "Set or update your private note about a contact. Notes are only visible to you.",
  {
    contact_id: z.string().describe("Agent ID of the contact"),
    content: z.string().describe("Note content"),
  },
  async ({ contact_id, content }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/contacts/${encodeURIComponent(contact_id)}/notes`, { method: "PUT", secret: config.secret, body: { content } });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_delete_contact_note",
  "Delete your private note about a contact.",
  {
    contact_id: z.string().describe("Agent ID of the contact"),
  },
  async ({ contact_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/contacts/${encodeURIComponent(contact_id)}/notes`, { method: "DELETE", secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_block_contact",
  "Block an agent from sending you messages. Blocking is one-directional — you can still send to them.",
  {
    agent_id: z.string().describe("ID of the agent to block"),
    reason: z.string().optional().describe("Optional reason for blocking"),
  },
  async ({ agent_id, reason }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/contacts/${encodeURIComponent(agent_id)}/block`, { method: "POST", secret: config.secret, body: { reason } });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_unblock_contact",
  "Unblock an agent so they can send you messages again.",
  {
    agent_id: z.string().describe("ID of the agent to unblock"),
  },
  async ({ agent_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/contacts/${encodeURIComponent(agent_id)}/block`, { method: "DELETE", secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_blocked_list",
  "List all agents you have blocked.",
  {},
  async () => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay("/contacts/blocked", { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_notification_prefs",
  "Get or set notification preferences for a contact. Omit muted/urgency_filter to just read current prefs.",
  {
    contact_id: z.string().describe("Agent ID of the contact"),
    muted: z.boolean().optional().describe("Set to true to mute notifications"),
    urgency_filter: z.enum(["all", "sync_only"]).optional().describe("Filter: 'all' or 'sync_only'"),
  },
  async ({ contact_id, muted, urgency_filter }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    if (muted === undefined && urgency_filter === undefined) {
      const result = await relay(`/contacts/${contact_id}/notifications`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    const body: Record<string, unknown> = {};
    if (muted !== undefined) body.muted = muted;
    if (urgency_filter) body.urgency_filter = urgency_filter;
    const result = await relay(`/contacts/${contact_id}/notifications`, {
      method: "PUT",
      body,
      secret: config.secret,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_tag_contact",
  "Add a tag to a contact for organization (e.g., 'team', 'vendor', 'priority').",
  {
    contact_id: z.string().describe("Agent ID of the contact"),
    tag: z.string().describe("Tag to add (lowercased, max 50 chars)"),
  },
  async ({ contact_id, tag }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/contacts/${contact_id}/tags`, { method: "POST", body: { tag }, secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_untag_contact",
  "Remove a tag from a contact.",
  {
    contact_id: z.string().describe("Agent ID of the contact"),
    tag: z.string().describe("Tag to remove"),
  },
  async ({ contact_id, tag }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/contacts/${contact_id}/tags/${encodeURIComponent(tag)}`, { method: "DELETE", secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_contact_tags",
  "List tags for a contact, or list all your tags.",
  {
    contact_id: z.string().optional().describe("Agent ID to list tags for (omit for all tags)"),
    tag: z.string().optional().describe("Tag to list contacts by"),
  },
  async ({ contact_id, tag }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    if (contact_id) {
      const result = await relay(`/contacts/${contact_id}/tags`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (tag) {
      const result = await relay(`/contacts/by-tag/${encodeURIComponent(tag)}`, { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    const result = await relay("/contacts/tags/all", { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_label_message",
  "Add a label/tag to a message for organization. Labels are private to you. Good for marking messages as 'important', 'action-required', 'reviewed', etc.",
  {
    message_id: z.string().describe("ID of the message to label"),
    label: z.string().describe("Label to add (will be lowercased, max 50 chars)"),
  },
  async ({ message_id, label }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/messages/${encodeURIComponent(message_id)}/labels`, { method: "POST", secret: config.secret, body: { label } });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_unlabel_message",
  "Remove a label from a message.",
  {
    message_id: z.string().describe("ID of the message"),
    label: z.string().describe("Label to remove"),
  },
  async ({ message_id, label }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/messages/${encodeURIComponent(message_id)}/labels/${encodeURIComponent(label)}`, { method: "DELETE", secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_message_labels",
  "List your labels on a message.",
  {
    message_id: z.string().describe("ID of the message"),
  },
  async ({ message_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay(`/messages/${encodeURIComponent(message_id)}/labels`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_labels_list",
  "List all labels you've used across all messages, with counts.",
  {},
  async () => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const result = await relay("/messages/labels/all", { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_messages_by_label",
  "List messages that have a specific label.",
  {
    label: z.string().describe("Label to filter by"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ label, limit }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    const query = params.toString();
    const result = await relay(`/messages/by-label/${encodeURIComponent(label)}${query ? `?${query}` : ""}`, { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Saved Searches ---

server.tool(
  "trunk_saved_searches",
  "List, save, or delete saved message searches.",
  {
    action: z.enum(["list", "save", "delete"]).describe("Action to perform"),
    name: z.string().optional().describe("Name for the search (for save)"),
    query: z.record(z.string(), z.string()).optional().describe("Search params: q, type, contact, after, before"),
    search_id: z.string().optional().describe("ID of search to delete"),
  },
  async ({ action, name, query, search_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    if (action === "list") {
      const result = await relay("/messages/searches", { secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "save") {
      const result = await relay("/messages/searches", { method: "POST", body: { name, query }, secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (action === "delete" && search_id) {
      const result = await relay(`/messages/searches/${search_id}`, { method: "DELETE", secret: config.secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    return { content: [{ type: "text", text: "Error: Invalid action or missing params." }], isError: true };
  }
);

// --- Templates ---

server.tool(
  "trunk_list_templates",
  "List all message templates for your agent.",
  {},
  async () => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/templates", { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_create_template",
  "Create a reusable message template.",
  {
    name: z.string().describe("Unique name for the template"),
    type: z.string().describe("Message type (e.g., update, handoff, question)"),
    payload: z.record(z.string(), z.unknown()).describe("Default payload structure"),
    description: z.string().optional().describe("Description of when to use this template"),
  },
  async ({ name, type, payload, description }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/templates", {
      method: "POST",
      body: { name, type, payload, description },
      secret: config.secret,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_update_template",
  "Update an existing message template.",
  {
    template_id: z.string().describe("ID of the template to update"),
    name: z.string().optional().describe("New name"),
    type: z.string().optional().describe("New message type"),
    payload: z.record(z.string(), z.unknown()).optional().describe("New payload structure"),
    description: z.string().optional().describe("New description"),
  },
  async ({ template_id, name, type, payload, description }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    if (type) body.type = type;
    if (payload) body.payload = payload;
    if (description !== undefined) body.description = description;

    const result = await relay(`/templates/${template_id}`, {
      method: "PATCH",
      body,
      secret: config.secret,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_delete_template",
  "Delete a message template.",
  {
    template_id: z.string().describe("ID of the template to delete"),
  },
  async ({ template_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/templates/${template_id}`, {
      method: "DELETE",
      secret: config.secret,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Attachments ---

server.tool(
  "trunk_upload_attachment",
  "Upload a file attachment, optionally linked to a message. Returns attachment ID. Max 10MB, base64-encoded.",
  {
    filename: z.string().describe("Original filename"),
    data: z.string().describe("Base64-encoded file content"),
    content_type: z.string().optional().describe("MIME type (default: application/octet-stream)"),
    message_id: z.string().optional().describe("Message ID to link this attachment to"),
  },
  async ({ filename, data, content_type, message_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/attachments", {
      method: "POST",
      body: { filename, data, content_type, message_id },
      secret: config.secret,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_get_attachment",
  "Download an attachment by ID. Returns metadata and base64-encoded content.",
  {
    attachment_id: z.string().describe("Attachment ID"),
  },
  async ({ attachment_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/attachments/${attachment_id}`, {
      secret: config.secret,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_list_attachments",
  "List your uploaded attachments.",
  {},
  async () => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay("/attachments", { secret: config.secret });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_message_attachments",
  "List attachments for a specific message.",
  {
    message_id: z.string().describe("Message ID"),
  },
  async ({ message_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/attachments/message/${message_id}`, {
      secret: config.secret,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "trunk_delete_attachment",
  "Delete an attachment you uploaded.",
  {
    attachment_id: z.string().describe("Attachment ID to delete"),
  },
  async ({ attachment_id }) => {
    const config = loadConfig();
    if (!config) return { content: [{ type: "text", text: "Error: Not registered." }], isError: true };

    const result = await relay(`/attachments/${attachment_id}`, {
      method: "DELETE",
      secret: config.secret,
    });
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
