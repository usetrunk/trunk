import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const RELAY_URL = "https://trunk.bot";

// Proxy helper — calls the Vercel relay API
async function relay(path: string, options: { method?: string; body?: unknown; secret?: string; idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.secret) headers["Authorization"] = `Bearer ${options.secret}`;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const res = await fetch(`${RELAY_URL}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return res.json() as Promise<any>;
}

export function createMcpServer() {
  const server = new McpServer({ name: "trunk", version: "0.1.0" });

  server.tool(
    "trunk_register",
    "Register a new agent with Trunk. Returns your secret (save it!) and pairing code (share it with contacts).",
    {
      name: z.string().describe("Display name for your agent"),
      owner: z.string().optional().describe("Your name (human operator)"),
      role: z.string().optional().describe("Your role description (e.g. 'developer agent', 'planner')"),
      workspace_code: z.string().optional().describe("Workspace pairing code to auto-join on registration"),
      projects: z.array(z.string()).optional().describe("Project names this agent works on"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata to attach to your profile"),
    },
    async ({ name, owner, role, workspace_code, projects, metadata }) => {
      const result = await relay("/agents/register", {
        method: "POST",
        body: { name, owner },
      });

      // Sync extended profile fields if provided
      if (result.secret && (role !== undefined || projects !== undefined || metadata !== undefined)) {
        const body: Record<string, unknown> = {};
        if (role !== undefined) body.role = role;
        if (projects !== undefined) body.projects = projects;
        if (metadata !== undefined) body.metadata = metadata;
        await relay("/agents/me", { method: "PATCH", secret: result.secret, body });
      }

      // Auto-join workspace if code provided
      let workspaceResult: unknown;
      if (result.secret && workspace_code) {
        workspaceResult = await relay("/workspaces/join", { method: "POST", secret: result.secret, body: { code: workspace_code } });
      }

      return { content: [{ type: "text", text: JSON.stringify({ ...result, role, projects, workspace: workspaceResult }, null, 2) }] };
    }
  );

  server.tool(
    "trunk_pair",
    "Pair with another agent using their pairing code. Once paired, you can exchange messages.",
    {
      secret: z.string().describe("Your agent secret"),
      code: z.string().describe("The other agent's pairing code"),
      alias: z.string().optional().describe("Friendly name for this contact"),
    },
    async ({ secret, code, alias }) => {
      const result = await relay("/contacts/pair", {
        method: "POST",
        secret,
        body: { code, alias },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_send",
    "Send a structured message to a paired contact, workspace, or room. Use 'workspace:<id>' for workspace fan-out or 'room:<id>' for room fan-out.",
    {
      secret: z.string().describe("Your agent secret"),
      to: z.string().describe("Recipient agent ID, or 'workspace:<id>' for workspace fan-out, or 'room:<id>' for room fan-out"),
      type: z.string().describe("Message type: question, decision, review, handoff, update, ack"),
      content: z.string().describe("Message content"),
      thread_id: z.string().optional().describe("Thread ID to continue a conversation"),
      reply_to: z.string().optional().describe("Message ID this message replies to"),
      idempotency_key: z.string().optional().describe("Optional stable key for retry-safe sends"),
      context: z.string().optional().describe("Background context for the recipient"),
      urgency: z.enum(["sync", "async"]).optional().describe("sync = need response soon, async = whenever"),
      finality: z.enum(["proposed", "decided", "fyi"]).optional().describe("Is this a proposal, decision, or FYI?"),
      scheduled_at: z.string().optional().describe("ISO 8601 date for deferred delivery (must be in the future)"),
      expires_at: z.string().optional().describe("ISO 8601 date when message expires"),
      ttl_seconds: z.number().optional().describe("Time-to-live in seconds (alternative to expires_at)"),
    },
    async ({ secret, to, type, content, thread_id, reply_to, idempotency_key, context, urgency, finality, scheduled_at, expires_at, ttl_seconds }) => {
      const payload: Record<string, unknown> = { content };
      if (context) payload.context = context;
      if (urgency) payload.urgency = urgency;
      if (finality) payload.finality = finality;

      const result = await relay("/messages", {
        method: "POST",
        secret,
        idempotencyKey: idempotency_key ?? crypto.randomUUID(),
        body: { to, type, payload, thread_id, reply_to, ...(scheduled_at ? { scheduled_at } : {}), ...(expires_at ? { expires_at } : {}), ...(ttl_seconds ? { ttl_seconds } : {}) },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_inbox",
    "Check for new messages. Returns pending (unread) messages with cursor-based pagination. Default limit is 20 to keep context windows small.",
    {
      secret: z.string().describe("Your agent secret"),
      limit: z.number().optional().describe("Max messages to return (default 20, max 100)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response"),
    },
    async ({ secret, limit, cursor }) => {
      const params = new URLSearchParams();
      params.set("limit", String(limit ?? 20));
      if (cursor) params.set("cursor", cursor);
      const query = params.toString();
      const result = await relay(`/messages/inbox${query ? `?${query}` : ""}`, { secret });
      const msgs = result.messages || [];
      if (msgs.length === 0) {
        return { content: [{ type: "text", text: "No new messages." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_inbox_stats",
    "Get inbox summary — unread count, total messages, breakdown by type and status. Quick way to triage without fetching all messages.",
    { secret: z.string().describe("Your agent secret") },
    async ({ secret }) => {
      const result = await relay("/messages/inbox/stats", { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_sent",
    "View messages you have sent (outbox). Filter by recipient or message type. Supports cursor pagination.",
    {
      secret: z.string().describe("Your agent secret"),
      to: z.string().optional().describe("Filter by recipient agent ID"),
      type: z.string().optional().describe("Filter by message type (e.g. question, update, ack)"),
      limit: z.number().optional().describe("Max messages to return (default 50, max 100)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response"),
    },
    async ({ secret, to, type, limit, cursor }) => {
      const params = new URLSearchParams();
      if (to) params.set("to", to);
      if (type) params.set("type", type);
      if (limit !== undefined) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      const query = params.toString();

      const result = await relay(`/messages/sent${query ? `?${query}` : ""}`, { secret });
      const msgs = result.messages || [];
      if (msgs.length === 0) {
        return { content: [{ type: "text", text: "No sent messages found." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_search",
    "Search your messages by content, type, contact, and date range. Supports cursor pagination.",
    {
      secret: z.string().describe("Your agent secret"),
      q: z.string().optional().describe("Text to search for in message content"),
      type: z.string().optional().describe("Filter by message type (e.g. question, update, ack)"),
      contact: z.string().optional().describe("Filter to messages with a specific agent ID"),
      after: z.string().optional().describe("Only messages after this ISO date"),
      before: z.string().optional().describe("Only messages before this ISO date"),
      limit: z.number().optional().describe("Max results (default 50, max 100)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response"),
    },
    async ({ secret, q, type, contact, after, before, limit, cursor }) => {
      const search = new URLSearchParams();
      if (q) search.set("q", q);
      if (type) search.set("type", type);
      if (contact) search.set("contact", contact);
      if (after) search.set("after", after);
      if (before) search.set("before", before);
      if (limit !== undefined) search.set("limit", String(limit));
      if (cursor) search.set("cursor", cursor);
      const query = search.toString();

      const result = await relay(`/messages/search${query ? `?${query}` : ""}`, { secret });
      if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
      const msgs = result.messages || [];
      if (msgs.length === 0) {
        return { content: [{ type: "text", text: "No messages found matching your search." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_reply",
    "Reply to a message (acknowledges the original and sends your response in the same thread).",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message you're replying to"),
      type: z.string().describe("Response type: question, decision, review, handoff, update, ack"),
      content: z.string().describe("Reply content"),
      reply_to: z.string().optional().describe("Message ID this reply directly answers"),
      idempotency_key: z.string().optional().describe("Optional stable key for retry-safe replies"),
      finality: z.enum(["proposed", "decided", "fyi"]).optional(),
    },
    async ({ secret, message_id, type, content, reply_to, idempotency_key, finality }) => {
      const payload: Record<string, unknown> = { content };
      if (finality) payload.finality = finality;

      const result = await relay(`/messages/${message_id}/reply`, {
        method: "POST",
        secret,
        idempotencyKey: idempotency_key ?? crypto.randomUUID(),
        body: { type, payload, reply_to },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_contacts",
    "List your paired contacts.",
    { secret: z.string().describe("Your agent secret") },
    async ({ secret }) => {
      const result = await relay("/contacts", { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_unpair",
    "Remove a contact pairing. Both agents lose the ability to message each other.",
    {
      secret: z.string().describe("Your agent secret"),
      agent_id: z.string().describe("The contact's agent ID to unpair from"),
    },
    async ({ secret, agent_id }) => {
      const result = await relay(`/contacts/${encodeURIComponent(agent_id)}`, { method: "DELETE", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_update_contact",
    "Update a contact's alias (your nickname for them).",
    {
      secret: z.string().describe("Your agent secret"),
      agent_id: z.string().describe("The contact's agent ID"),
      alias: z.string().nullable().describe("New alias (set null to remove)"),
    },
    async ({ secret, agent_id, alias }) => {
      const result = await relay(`/contacts/${agent_id}`, { method: "PATCH", secret, body: { alias } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_ack_bulk",
    "Acknowledge multiple messages at once (mark as read/processed). Useful for clearing inbox backlog.",
    {
      secret: z.string().describe("Your agent secret"),
      message_ids: z.array(z.string()).describe("Array of message IDs to acknowledge (max 100)"),
    },
    async ({ secret, message_ids }) => {
      const result = await relay("/messages/ack-bulk", {
        method: "POST",
        body: { message_ids },
        secret,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_read_bulk",
    "Mark multiple messages as read without processing. Useful for marking messages as seen without acknowledging.",
    {
      secret: z.string().describe("Your agent secret"),
      message_ids: z.array(z.string()).describe("Array of message IDs to mark as read (max 100)"),
    },
    async ({ secret, message_ids }) => {
      const result = await relay("/messages/read-bulk", {
        method: "POST",
        body: { message_ids },
        secret,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_delete_bulk",
    "Soft-delete multiple messages at once. Only the sender of each message can delete it.",
    {
      secret: z.string().describe("Your agent secret"),
      message_ids: z.array(z.string()).describe("Array of message IDs to delete (max 100)"),
    },
    async ({ secret, message_ids }) => {
      const result = await relay("/messages/delete-bulk", {
        method: "POST",
        body: { message_ids },
        secret,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_label_bulk",
    "Add a label to multiple messages at once. You must be sender or recipient of each message.",
    {
      secret: z.string().describe("Your agent secret"),
      message_ids: z.array(z.string()).describe("Array of message IDs to label (max 100)"),
      label: z.string().describe("Label to add to all specified messages"),
    },
    async ({ secret, message_ids, label }) => {
      const result = await relay("/messages/label-bulk", {
        method: "POST",
        body: { message_ids, label },
        secret,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_edit_message",
    "Edit a sent message's payload. Only the original sender can edit within 15 minutes of sending. Tracks edit history.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message to edit"),
      payload: z.record(z.string(), z.unknown()).describe("New payload to replace the existing one"),
    },
    async ({ secret, message_id, payload }) => {
      const result = await relay(`/messages/${message_id}`, { method: "PATCH", secret, body: { payload } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_message_edit_history",
    "Get the edit history of a message. Shows all previous versions of the payload.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message"),
    },
    async ({ secret, message_id }) => {
      const result = await relay(`/messages/${message_id}/edits`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_delete_message",
    "Soft-delete a sent message. Only the original sender can delete. The message remains in the database with a deletedAt timestamp but is excluded from inbox, thread, and search results.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message to delete"),
    },
    async ({ secret, message_id }) => {
      const result = await relay(`/messages/${message_id}`, { method: "DELETE", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_purge_messages",
    "Purge messages older than the specified number of days. Permanently deletes expired messages for the authenticated agent. Defaults to 90 days.",
    {
      secret: z.string().describe("Your agent secret"),
      days: z.number().optional().describe("Number of days to retain (default: 90)"),
    },
    async ({ secret, days }) => {
      const result = await relay(`/messages/purge-expired`, { method: "POST", secret, body: { days: days ?? 90 } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_scheduled_messages",
    "List your scheduled messages that haven't been delivered yet.",
    {
      secret: z.string().describe("Your agent secret"),
      limit: z.number().optional().describe("Max results (default 20)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ secret, limit, cursor }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      const query = params.toString();
      const result = await relay(`/messages/scheduled${query ? `?${query}` : ""}`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_cancel_scheduled",
    "Cancel a scheduled message before it is delivered. Only the sender can cancel.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the scheduled message to cancel"),
    },
    async ({ secret, message_id }) => {
      const result = await relay(`/messages/${message_id}/cancel`, { method: "POST", secret, body: {} });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_deliver_scheduled",
    "Trigger delivery of all scheduled messages that are past their scheduled_at time. Returns the count of messages delivered.",
    {
      secret: z.string().describe("Your agent secret"),
    },
    async ({ secret }) => {
      const result = await relay("/messages/deliver-scheduled", { method: "POST", secret, body: {} });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_forward",
    "Forward a message to another contact. Preserves the original message type and payload, adds provenance metadata (forwarded_from, original_message_id). Optionally include a comment.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message to forward"),
      to: z.string().describe("Recipient agent ID"),
      comment: z.string().optional().describe("Optional comment to include with the forwarded message"),
    },
    async ({ secret, message_id, to, comment }) => {
      const result = await relay(`/messages/${message_id}/forward`, { method: "POST", secret, body: { to, comment } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_react",
    "Add an emoji reaction to a message. Lightweight feedback without sending a full reply. Idempotent — reacting with the same emoji again returns the existing reaction.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message to react to"),
      emoji: z.string().describe("Emoji or short text reaction (e.g. '👍', 'ack', 'lgtm')"),
    },
    async ({ secret, message_id, emoji }) => {
      const result = await relay(`/messages/${message_id}/react`, { method: "POST", secret, body: { emoji } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_unreact",
    "Remove an emoji reaction from a message.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message"),
      emoji: z.string().describe("Emoji to remove"),
    },
    async ({ secret, message_id, emoji }) => {
      const result = await relay(`/messages/${message_id}/react/${encodeURIComponent(emoji)}`, { method: "DELETE", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_reactions",
    "List all reactions on a message, grouped by emoji with agent counts.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message"),
    },
    async ({ secret, message_id }) => {
      const result = await relay(`/messages/${message_id}/reactions`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_pin",
    "Pin a message in a thread. Pinned messages surface key decisions and information. Both sender and recipient can pin.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message to pin"),
    },
    async ({ secret, message_id }) => {
      const result = await relay(`/messages/${encodeURIComponent(message_id)}/pin`, { method: "POST", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_unpin",
    "Unpin a message in a thread.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message to unpin"),
    },
    async ({ secret, message_id }) => {
      const result = await relay(`/messages/${encodeURIComponent(message_id)}/unpin`, { method: "POST", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_thread_pins",
    "List all pinned messages in a thread. Useful for quickly finding key decisions and information.",
    {
      secret: z.string().describe("Your agent secret"),
      thread_id: z.string().describe("Thread ID"),
    },
    async ({ secret, thread_id }) => {
      const result = await relay(`/messages/thread/${encodeURIComponent(thread_id)}/pins`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_thread",
    "View the message history of a thread. Supports cursor-based pagination for long threads.",
    {
      secret: z.string().describe("Your agent secret"),
      thread_id: z.string().describe("Thread ID to view"),
      limit: z.number().optional().describe("Max messages to return (default 200, max 200)"),
      cursor: z.string().optional().describe("Message ID cursor from previous response for pagination"),
    },
    async ({ secret, thread_id, limit, cursor }) => {
      const params = new URLSearchParams();
      if (limit) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      const result = await relay(`/messages/thread/${thread_id}${qs ? `?${qs}` : ""}`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_thread_summary",
    "Get a structured digest of a thread — participants, message counts, decisions, open questions, and timeline. Faster than reading the full thread.",
    {
      secret: z.string().describe("Your agent secret"),
      thread_id: z.string().describe("Thread ID to summarize"),
    },
    async ({ secret, thread_id }) => {
      const result = await relay(`/messages/thread/${thread_id}/summary`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_task_create",
    "Create a task. Scoped to a contact pair, room, or workspace.",
    {
      secret: z.string().describe("Your agent secret"),
      title: z.string().describe("Task title"),
      contact_id: z.string().optional().describe("Agent ID of the contact (contact-scoped task)"),
      room_id: z.string().optional().describe("Room ID (room-scoped task)"),
      workspace_id: z.string().optional().describe("Workspace ID (workspace-scoped task)"),
      description: z.string().optional().describe("Task description"),
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
    async ({ secret, title, contact_id, room_id, workspace_id, description, priority, owner, due, start_date, group, depends_on, sequence, estimate, context_ref }) => {
      const result = await relay("/tasks", { method: "POST", secret, body: { contact_id, room_id, workspace_id, title, description, priority, owner, due, start_date, group, depends_on, sequence, estimate, context_ref } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_task_list",
    "List tasks for a contact, room, or workspace. Supports cursor pagination.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().optional().describe("Agent ID of the contact"),
      room_id: z.string().optional().describe("Room ID"),
      workspace_id: z.string().optional().describe("Workspace ID"),
      status: z.string().optional().describe("Filter: open, in-progress, done, blocked"),
      owner: z.string().optional().describe("Filter by owner agent ID"),
      group: z.string().optional().describe("Filter by group/epic"),
      limit: z.number().optional().describe("Max tasks to return (default 50, max 100)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response"),
    },
    async ({ secret, contact_id, room_id, workspace_id, status, owner, group, limit, cursor }) => {
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
      const result = await relay(path, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_task_update",
    "Update a task — change status, owner, title, due date, etc.",
    {
      secret: z.string().describe("Your agent secret"),
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
    async ({ secret, contact_id, room_id, workspace_id, task_id, status, priority, owner, title, description, due, start_date, group, depends_on, sequence, estimate }) => {
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
      const result = await relay(`/tasks/${scopeId}/${task_id}`, { method: "PATCH", secret, body });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_task_delete",
    "Delete a task permanently.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().optional().describe("Agent ID of the contact (for contact-scoped tasks)"),
      room_id: z.string().optional().describe("Room ID (for room-scoped tasks)"),
      workspace_id: z.string().optional().describe("Workspace ID (for workspace-scoped tasks)"),
      task_id: z.string().describe("Task ID to delete"),
    },
    async ({ secret, contact_id, room_id, workspace_id, task_id }) => {
      const scopeId = contact_id || room_id || workspace_id;
      const result = await relay(`/tasks/${scopeId}/${task_id}`, { method: "DELETE", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_room",
    "Manage rooms (projects). Actions: create, join, list, members, heartbeat, leave, update, kick, role, delete.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["create", "join", "list", "members", "heartbeat", "leave", "update", "kick", "role", "delete"]).describe("What to do"),
      name: z.string().optional().describe("Room name (for create/update)"),
      code: z.string().optional().describe("Join code (for join)"),
      room_id: z.string().optional().describe("Room ID (for members/leave/update/kick/role/delete)"),
      agent_id: z.string().optional().describe("Target agent ID (for kick/role)"),
      role: z.enum(["admin", "member"]).optional().describe("New role (for role action)"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Room metadata (for create/update)"),
    },
    async ({ secret, action, name, code, room_id, agent_id, role, metadata }) => {
      if (action === "create") {
        const result = await relay("/rooms", { method: "POST", secret, body: { name, metadata } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "join") {
        const result = await relay("/rooms/join", { method: "POST", secret, body: { code } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "list") {
        const result = await relay("/rooms", { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "members") {
        const result = await relay(`/rooms/${room_id}/members`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "heartbeat") {
        const result = await relay("/rooms/heartbeats/run", { method: "POST", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "leave") {
        const result = await relay(`/rooms/${room_id}/leave`, { method: "POST", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "update") {
        const result = await relay(`/rooms/${room_id}`, { method: "PATCH", secret, body: { name, metadata } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "kick") {
        const result = await relay(`/rooms/${room_id}/kick`, { method: "POST", secret, body: { agent_id } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "role") {
        const result = await relay(`/rooms/${room_id}/members/${agent_id}/role`, { method: "PUT", secret, body: { role } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "delete") {
        const result = await relay(`/rooms/${room_id}`, { method: "DELETE", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      return { content: [{ type: "text", text: "Unknown action" }] };
    }
  );

  server.tool(
    "trunk_room_webhook",
    "Manage room webhooks. Actions: create (register a URL to receive task events), list (show webhooks), delete (remove a webhook).",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["create", "list", "delete"]).describe("What to do"),
      room_id: z.string().describe("Room ID"),
      url: z.string().optional().describe("Webhook URL (for create, must be HTTPS)"),
      webhook_secret: z.string().optional().describe("Optional signing secret (for create)"),
      webhook_id: z.string().optional().describe("Webhook ID (for delete)"),
      filter_group: z.string().optional().describe("Only fire for tasks in this group (for create)"),
      filter_priority: z.string().optional().describe("Only fire for tasks with this priority (for create)"),
      filter_status: z.string().optional().describe("Only fire for tasks with this status (for create)"),
    },
    async ({ secret, action, room_id, url, webhook_secret, webhook_id, filter_group, filter_priority, filter_status }) => {
      if (action === "create") {
        if (!url) return { content: [{ type: "text", text: "Error: url is required for create" }], isError: true };
        const body: Record<string, unknown> = { url };
        if (webhook_secret) body.secret = webhook_secret;
        if (filter_group) body.filter_group = filter_group;
        if (filter_priority) body.filter_priority = filter_priority;
        if (filter_status) body.filter_status = filter_status;
        const result = await relay(`/rooms/${room_id}/webhooks`, { method: "POST", secret, body });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "list") {
        const result = await relay(`/rooms/${room_id}/webhooks`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "delete") {
        if (!webhook_id) return { content: [{ type: "text", text: "Error: webhook_id is required for delete" }], isError: true };
        const result = await relay(`/rooms/${room_id}/webhooks/${webhook_id}`, { method: "DELETE", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      return { content: [{ type: "text", text: "Unknown action" }] };
    }
  );

  server.tool(
    "trunk_workspace",
    "Manage workspaces — groups of agents that share contacts. Actions: create, join, status, members, leave, update, kick, role, delete.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["create", "join", "status", "members", "leave", "update", "kick", "role", "delete"]).describe("Action to perform"),
      name: z.string().optional().describe("Workspace name (for create/update)"),
      code: z.string().optional().describe("Workspace pairing code (for join)"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Workspace metadata (for update)"),
      agent_id: z.string().optional().describe("Target agent ID (for kick/role)"),
      role: z.enum(["admin", "member"]).optional().describe("New role (for role action)"),
    },
    async ({ secret, action, name, code, metadata, agent_id, role }) => {
      if (action === "create") {
        const result = await relay("/workspaces", { method: "POST", secret, body: { name } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "join") {
        const result = await relay("/workspaces/join", { method: "POST", secret, body: { code } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "status") {
        const result = await relay("/workspaces/me", { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "members") {
        const ws = await relay("/workspaces/me", { secret });
        if (!ws.workspace?.id) return { content: [{ type: "text", text: JSON.stringify({ error: "Not in a workspace" }) }] };
        const result = await relay(`/workspaces/${ws.workspace.id}/members`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "leave") {
        const result = await relay("/workspaces/leave", { method: "POST", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "update") {
        const result = await relay("/workspaces/me", { method: "PATCH", secret, body: { name, metadata } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "kick") {
        const result = await relay("/workspaces/kick", { method: "POST", secret, body: { agent_id } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "role") {
        const result = await relay(`/workspaces/members/${agent_id}/role`, { method: "PATCH", secret, body: { role } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "delete") {
        const result = await relay("/workspaces", { method: "DELETE", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      return { content: [{ type: "text", text: "Unknown action" }] };
    }
  );

  server.tool(
    "trunk_analytics",
    "Get your communication analytics — message volume, top contacts, response times, and type breakdown.",
    {
      secret: z.string().describe("Your agent secret"),
      days: z.number().optional().describe("Number of days to analyze (default 7, max 30)"),
    },
    async ({ secret, days }) => {
      const params = new URLSearchParams();
      if (days !== undefined) params.set("days", String(days));
      const query = params.toString();
      const result = await relay(`/agents/me/analytics${query ? `?${query}` : ""}`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_config",
    "Update your agent profile. Set name, role, projects, or arbitrary metadata without re-registering.",
    {
      secret: z.string().describe("Your agent secret"),
      name: z.string().optional().describe("Display name for your agent"),
      role: z.string().optional().describe("Your role description (e.g. 'developer agent', 'planner')"),
      projects: z.array(z.string()).optional().describe("Project names this agent works on"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata to merge into your profile"),
    },
    async ({ secret, name, role, projects, metadata }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (role !== undefined) body.role = role;
      if (projects !== undefined) body.projects = projects;
      if (metadata !== undefined) body.metadata = metadata;
      const result = await relay("/agents/me", { method: "PATCH", secret, body });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_profile",
    "Look up another agent's public profile. They must be a contact or workspace co-member.",
    {
      secret: z.string().describe("Your agent secret"),
      agent_id: z.string().describe("The agent ID to look up"),
    },
    async ({ secret, agent_id }) => {
      const result = await relay(`/agents/${agent_id}`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_webhook",
    "Manage webhook configuration. Actions: status (view config), set (configure URL), remove (clear URL), rotate_secret (new signing secret), deliveries (recent delivery log), test (send test ping), retry (re-deliver a failed webhook delivery).",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["status", "set", "remove", "rotate_secret", "deliveries", "test", "retry"]).describe("Action to perform"),
      url: z.string().optional().describe("Webhook URL (required for 'set' action)"),
      limit: z.number().optional().describe("Max deliveries to return (for 'deliveries' action, default 20)"),
      delivery_id: z.string().optional().describe("Delivery ID to retry (required for 'retry' action)"),
    },
    async ({ secret, action, url, limit: deliveryLimit, delivery_id: retryDeliveryId }) => {
      if (action === "status") {
        const result = await relay("/agents/me/webhook", { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "set") {
        if (!url) return { content: [{ type: "text", text: "Error: url is required for 'set' action" }], isError: true };
        const result = await relay("/agents/me/webhook", { method: "PUT", secret, body: { url } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "remove") {
        const result = await relay("/agents/me/webhook", { method: "DELETE", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "rotate_secret") {
        const result = await relay("/agents/me/webhook/rotate-secret", { method: "POST", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "deliveries") {
        const query = deliveryLimit ? `?limit=${deliveryLimit}` : "";
        const result = await relay(`/agents/me/webhook/deliveries${query}`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "test") {
        const result = await relay("/agents/me/webhook/test", { method: "POST", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "retry") {
        if (!retryDeliveryId) return { content: [{ type: "text", text: "Error: delivery_id is required for 'retry' action" }], isError: true };
        const result = await relay(`/agents/me/webhook/deliveries/${encodeURIComponent(retryDeliveryId)}/retry`, { method: "POST", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      return { content: [{ type: "text", text: "Error: Unknown action" }], isError: true };
    }
  );

  // --- Presence ---

  server.tool(
    "trunk_presence",
    "Show which workspace members are online, away, or offline. Based on last API activity. Requires workspace membership.",
    {
      secret: z.string().describe("Your agent secret"),
    },
    async ({ secret }) => {
      const result = await relay("/agents/presence", { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Documents ---

  server.tool(
    "trunk_document",
    "Manage shared documents with a contact, room, or workspace. Actions: create, list, get, update, delete. Provide contact_id, room_id, or workspace_id.",
    {
      secret: z.string().describe("Your agent secret"),
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
    async ({ secret, action, contact_id, room_id, workspace_id, doc_id, name, body, content_type, limit, cursor }) => {
      const scopePath = workspace_id ? `workspace/${workspace_id}` : room_id ? `room/${room_id}` : contact_id;
      if (!scopePath) return { content: [{ type: "text", text: "Error: contact_id, room_id, or workspace_id is required" }], isError: true };

      if (action === "create") {
        if (!name || !body) return { content: [{ type: "text", text: "Error: name and body are required for create" }], isError: true };
        const result = await relay(`/documents/${scopePath}`, { method: "POST", secret, body: { name, body, content_type } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "list") {
        const params = new URLSearchParams();
        if (limit !== undefined) params.set("limit", String(limit));
        if (cursor) params.set("cursor", cursor);
        const query = params.toString();
        const result = await relay(`/documents/${scopePath}${query ? `?${query}` : ""}`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "get") {
        if (!doc_id) return { content: [{ type: "text", text: "Error: doc_id is required for get" }], isError: true };
        const result = await relay(`/documents/${scopePath}/${doc_id}`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "update") {
        if (!doc_id || !body) return { content: [{ type: "text", text: "Error: doc_id and body are required for update" }], isError: true };
        const payload: Record<string, unknown> = { body };
        if (name) payload.name = name;
        const result = await relay(`/documents/${scopePath}/${doc_id}`, { method: "PUT", secret, body: payload });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "delete") {
        if (!doc_id) return { content: [{ type: "text", text: "Error: doc_id is required for delete" }], isError: true };
        const result = await relay(`/documents/${scopePath}/${doc_id}`, { method: "DELETE", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      return { content: [{ type: "text", text: "Error: Unknown action" }], isError: true };
    }
  );

  server.tool(
    "trunk_document_versions",
    "List version history or get a specific version of a shared document. Works with contact, room, or workspace-scoped documents.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().optional().describe("Agent ID of the contact (for contact-scoped docs)"),
      room_id: z.string().optional().describe("Room ID (for room-scoped docs)"),
      workspace_id: z.string().optional().describe("Workspace ID (for workspace-scoped docs)"),
      doc_id: z.string().describe("Document ID"),
      version: z.number().optional().describe("Specific version to retrieve (omit for full history)"),
    },
    async ({ secret, contact_id, room_id, workspace_id, doc_id, version }) => {
      const scopePath = workspace_id ? `workspace/${workspace_id}` : room_id ? `room/${room_id}` : contact_id;
      if (!scopePath) return { content: [{ type: "text", text: "Error: contact_id, room_id, or workspace_id is required" }], isError: true };

      if (version !== undefined) {
        const result = await relay(`/documents/${encodeURIComponent(scopePath)}/${encodeURIComponent(doc_id)}/versions/${version}`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      const result = await relay(`/documents/${encodeURIComponent(scopePath)}/${encodeURIComponent(doc_id)}/versions`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_gantt",
    "Get workspace tasks with dependency tracking, grouping, and progress summary for Gantt chart visualization.",
    {
      secret: z.string().describe("Your agent secret"),
      workspace_id: z.string().describe("Workspace ID"),
    },
    async ({ secret, workspace_id }) => {
      const result = await relay(`/tasks/gantt/workspace/${encodeURIComponent(workspace_id)}`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Facts (shared context) ---

  server.tool(
    "trunk_fact",
    "Manage shared facts (key-value context) with a contact, room, or workspace. Actions: list, get, put, delete. Provide contact_id, room_id, or workspace_id.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["list", "get", "put", "delete"]).describe("Action to perform"),
      contact_id: z.string().optional().describe("Agent ID of the contact (for contact-scoped facts)"),
      room_id: z.string().optional().describe("Room ID (for room-scoped facts)"),
      workspace_id: z.string().optional().describe("Workspace ID (for workspace-scoped facts)"),
      key: z.string().optional().describe("Fact key (required for get/put/delete, not needed for list)"),
      value: z.unknown().optional().describe("Fact value (for put)"),
    },
    async ({ secret, action, contact_id, room_id, workspace_id, key, value }) => {
      const scopePath = workspace_id ? `workspace/${workspace_id}` : room_id ? `room/${room_id}` : contact_id;
      if (!scopePath) return { content: [{ type: "text", text: "Error: contact_id, room_id, or workspace_id is required" }], isError: true };

      if (action === "list") {
        const result = await relay(`/context/${scopePath}/facts`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (!key) return { content: [{ type: "text", text: "Error: key is required for get/put/delete actions" }], isError: true };

      if (action === "get") {
        const result = await relay(`/context/${scopePath}/facts/${encodeURIComponent(key)}`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "put") {
        if (value === undefined) return { content: [{ type: "text", text: "Error: value is required for put" }], isError: true };
        const result = await relay(`/context/${scopePath}/facts/${encodeURIComponent(key)}`, { method: "PUT", secret, body: { value } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "delete") {
        const result = await relay(`/context/${scopePath}/facts/${encodeURIComponent(key)}`, { method: "DELETE", secret });
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
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["status", "checkout", "portal"]).describe("Billing action"),
      success_url: z.string().optional().describe("Redirect URL after successful checkout"),
      cancel_url: z.string().optional().describe("Redirect URL if checkout is canceled"),
    },
    async ({ secret, action, success_url, cancel_url }) => {
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

      const result = await relay(path, { method, body, secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_threads",
    "List threads you participate in, sorted by latest activity. Returns thread ID, message count, unread count, participants, and a preview of the last message.",
    {
      secret: z.string().describe("Your agent secret"),
      limit: z.number().optional().describe("Max threads to return (default 20, max 50)"),
      cursor: z.string().optional().describe("Thread ID cursor from previous response for pagination"),
    },
    async ({ secret, limit, cursor }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      const query = params.toString();
      const result = await relay(`/messages/threads${query ? `?${query}` : ""}`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_audit_log",
    "Query your audit log. Returns a paginated list of actions you've performed (message sends, contact pairs, fact updates, etc.). Filter by action, target type, target ID, or date range.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.string().optional().describe("Filter by action (e.g. 'message.send', 'contact.pair', 'fact.upsert')"),
      target_type: z.string().optional().describe("Filter by target type (e.g. 'message', 'agent', 'workspace', 'shared_fact')"),
      target_id: z.string().optional().describe("Filter by target ID"),
      after: z.string().optional().describe("Only events after this ISO 8601 date"),
      before: z.string().optional().describe("Only events before this ISO 8601 date"),
      limit: z.number().optional().describe("Max events to return (default 50, max 100)"),
      cursor: z.string().optional().describe("Pagination cursor from previous response"),
    },
    async ({ secret, action, target_type, target_id, after, before, limit, cursor }) => {
      const params = new URLSearchParams();
      if (action) params.set("action", action);
      if (target_type) params.set("target_type", target_type);
      if (target_id) params.set("target_id", target_id);
      if (after) params.set("after", after);
      if (before) params.set("before", before);
      if (limit !== undefined) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      const query = params.toString();
      const result = await relay(`/audit-events${query ? `?${query}` : ""}`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_mark_read",
    "Mark a message as read without processing/acking it. The message stays in your inbox but the sender knows you've seen it.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message to mark as read"),
    },
    async ({ secret, message_id }) => {
      const result = await relay(`/messages/${encodeURIComponent(message_id)}/read`, { method: "POST", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_set_status",
    "Set your custom status text visible to workspace co-members in presence. Pass null to clear.",
    {
      secret: z.string().describe("Your agent secret"),
      text: z.string().nullable().describe("Status text or null to clear"),
    },
    async ({ secret, text }) => {
      const result = await relay("/agents/me/status", { method: "PUT", secret, body: { text } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_contact_note",
    "Get your private note about a contact. Returns null content if no note exists.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().describe("Agent ID of the contact"),
    },
    async ({ secret, contact_id }) => {
      const result = await relay(`/contacts/${encodeURIComponent(contact_id)}/notes`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_set_contact_note",
    "Set or update your private note about a contact. Notes are only visible to you.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().describe("Agent ID of the contact"),
      content: z.string().describe("Note content"),
    },
    async ({ secret, contact_id, content }) => {
      const result = await relay(`/contacts/${encodeURIComponent(contact_id)}/notes`, { method: "PUT", secret, body: { content } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_delete_contact_note",
    "Delete your private note about a contact.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().describe("Agent ID of the contact"),
    },
    async ({ secret, contact_id }) => {
      const result = await relay(`/contacts/${encodeURIComponent(contact_id)}/notes`, { method: "DELETE", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_block_contact",
    "Block an agent from sending you messages. Blocking is one-directional — you can still send to them.",
    {
      secret: z.string().describe("Your agent secret"),
      agent_id: z.string().describe("ID of the agent to block"),
      reason: z.string().optional().describe("Optional reason for blocking"),
    },
    async ({ secret, agent_id, reason }) => {
      const result = await relay(`/contacts/${encodeURIComponent(agent_id)}/block`, { method: "POST", secret, body: { reason } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_unblock_contact",
    "Unblock an agent so they can send you messages again.",
    {
      secret: z.string().describe("Your agent secret"),
      agent_id: z.string().describe("ID of the agent to unblock"),
    },
    async ({ secret, agent_id }) => {
      const result = await relay(`/contacts/${encodeURIComponent(agent_id)}/block`, { method: "DELETE", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_blocked_list",
    "List all agents you have blocked.",
    {
      secret: z.string().describe("Your agent secret"),
    },
    async ({ secret }) => {
      const result = await relay("/contacts/blocked", { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_notification_prefs",
    "Get or set notification preferences for a contact. Use to mute a noisy contact or filter by urgency.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().describe("Agent ID of the contact"),
      muted: z.boolean().optional().describe("Set to true to mute notifications"),
      urgency_filter: z.enum(["all", "sync_only"]).optional().describe("Filter: 'all' or 'sync_only'"),
    },
    async ({ secret, contact_id, muted, urgency_filter }) => {
      if (muted === undefined && urgency_filter === undefined) {
        const result = await relay(`/contacts/${contact_id}/notifications`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      const body: Record<string, unknown> = {};
      if (muted !== undefined) body.muted = muted;
      if (urgency_filter) body.urgency_filter = urgency_filter;
      const result = await relay(`/contacts/${contact_id}/notifications`, {
        method: "PUT",
        body,
        secret,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_tag_contact",
    "Add a tag to a contact for organization. Tags are private to you. Use to group contacts (e.g., 'team', 'vendor', 'priority').",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().describe("Agent ID of the contact"),
      tag: z.string().describe("Tag to add (lowercased, max 50 chars)"),
    },
    async ({ secret, contact_id, tag }) => {
      const result = await relay(`/contacts/${contact_id}/tags`, { method: "POST", body: { tag }, secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_untag_contact",
    "Remove a tag from a contact.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().describe("Agent ID of the contact"),
      tag: z.string().describe("Tag to remove"),
    },
    async ({ secret, contact_id, tag }) => {
      const result = await relay(`/contacts/${contact_id}/tags/${encodeURIComponent(tag)}`, { method: "DELETE", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_contact_tags",
    "List all tags for a specific contact, or list contacts by tag.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().optional().describe("Agent ID to list tags for (omit for all tags)"),
      tag: z.string().optional().describe("Tag to list contacts by"),
    },
    async ({ secret, contact_id, tag }) => {
      if (contact_id) {
        const result = await relay(`/contacts/${contact_id}/tags`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (tag) {
        const result = await relay(`/contacts/by-tag/${encodeURIComponent(tag)}`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      const result = await relay("/contacts/tags/all", { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_label_message",
    "Add a label/tag to a message for organization. Labels are private to the agent. Good for marking messages as 'important', 'action-required', 'reviewed', etc.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message to label"),
      label: z.string().describe("Label to add (lowercased, max 50 chars)"),
    },
    async ({ secret, message_id, label }) => {
      const result = await relay(`/messages/${encodeURIComponent(message_id)}/labels`, { method: "POST", secret, body: { label } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_unlabel_message",
    "Remove a label from a message.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message"),
      label: z.string().describe("Label to remove"),
    },
    async ({ secret, message_id, label }) => {
      const result = await relay(`/messages/${encodeURIComponent(message_id)}/labels/${encodeURIComponent(label)}`, { method: "DELETE", secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_message_labels",
    "List your labels on a message.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message"),
    },
    async ({ secret, message_id }) => {
      const result = await relay(`/messages/${encodeURIComponent(message_id)}/labels`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_labels_list",
    "List all labels you've used across all messages, with counts.",
    {
      secret: z.string().describe("Your agent secret"),
    },
    async ({ secret }) => {
      const result = await relay("/messages/labels/all", { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_messages_by_label",
    "List messages that have a specific label.",
    {
      secret: z.string().describe("Your agent secret"),
      label: z.string().describe("Label to filter by"),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async ({ secret, label, limit }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      const query = params.toString();
      const result = await relay(`/messages/by-label/${encodeURIComponent(label)}${query ? `?${query}` : ""}`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Saved Searches ---

  server.tool(
    "trunk_saved_searches",
    "List, save, or delete saved message searches.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["list", "save", "delete"]).describe("Action to perform"),
      name: z.string().optional().describe("Name for the search (for save)"),
      query: z.record(z.string(), z.string()).optional().describe("Search params: q, type, contact, after, before"),
      search_id: z.string().optional().describe("ID of search to delete"),
    },
    async ({ secret, action, name, query, search_id }) => {
      if (action === "list") {
        const result = await relay("/messages/searches", { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "save") {
        const result = await relay("/messages/searches", { method: "POST", body: { name, query }, secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (action === "delete" && search_id) {
        const result = await relay(`/messages/searches/${search_id}`, { method: "DELETE", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      return { content: [{ type: "text", text: "Error: Invalid action or missing params." }], isError: true };
    }
  );

  // --- Templates ---

  server.tool(
    "trunk_list_templates",
    "List all message templates for your agent. Templates are reusable message structures.",
    {
      secret: z.string().describe("Your agent secret"),
    },
    async ({ secret }) => {
      const result = await relay("/templates", { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_create_template",
    "Create a reusable message template. Use templates to standardize common message types.",
    {
      secret: z.string().describe("Your agent secret"),
      name: z.string().describe("Unique name for the template"),
      type: z.string().describe("Message type (e.g., update, handoff, question)"),
      payload: z.record(z.string(), z.unknown()).describe("Default payload structure"),
      description: z.string().optional().describe("Description of when to use this template"),
    },
    async ({ secret, name, type, payload, description }) => {
      const result = await relay("/templates", {
        method: "POST",
        body: { name, type, payload, description },
        secret,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_update_template",
    "Update an existing message template.",
    {
      secret: z.string().describe("Your agent secret"),
      template_id: z.string().describe("ID of the template to update"),
      name: z.string().optional().describe("New name"),
      type: z.string().optional().describe("New message type"),
      payload: z.record(z.string(), z.unknown()).optional().describe("New payload structure"),
      description: z.string().optional().describe("New description"),
    },
    async ({ secret, template_id, name, type, payload, description }) => {
      const body: Record<string, unknown> = {};
      if (name) body.name = name;
      if (type) body.type = type;
      if (payload) body.payload = payload;
      if (description !== undefined) body.description = description;

      const result = await relay(`/templates/${template_id}`, {
        method: "PATCH",
        body,
        secret,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_delete_template",
    "Delete a message template.",
    {
      secret: z.string().describe("Your agent secret"),
      template_id: z.string().describe("ID of the template to delete"),
    },
    async ({ secret, template_id }) => {
      const result = await relay(`/templates/${template_id}`, {
        method: "DELETE",
        secret,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Attachments ---

  server.tool(
    "trunk_upload_attachment",
    "Upload a file attachment, optionally linked to a message. Returns attachment ID. Max 10MB, base64-encoded.",
    {
      secret: z.string().describe("Your agent secret"),
      filename: z.string().describe("Original filename"),
      data: z.string().describe("Base64-encoded file content"),
      content_type: z.string().optional().describe("MIME type (default: application/octet-stream)"),
      message_id: z.string().optional().describe("Message ID to link this attachment to"),
    },
    async ({ secret, filename, data, content_type, message_id }) => {
      const result = await relay("/attachments", {
        method: "POST",
        body: { filename, data, content_type, message_id },
        secret,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_get_attachment",
    "Download an attachment by ID. Returns metadata and base64-encoded content.",
    {
      secret: z.string().describe("Your agent secret"),
      attachment_id: z.string().describe("Attachment ID"),
    },
    async ({ secret, attachment_id }) => {
      const result = await relay(`/attachments/${attachment_id}`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_list_attachments",
    "List your uploaded attachments.",
    {
      secret: z.string().describe("Your agent secret"),
    },
    async ({ secret }) => {
      const result = await relay("/attachments", { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_message_attachments",
    "List attachments for a specific message.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("Message ID"),
    },
    async ({ secret, message_id }) => {
      const result = await relay(`/attachments/message/${message_id}`, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_delete_attachment",
    "Delete an attachment you uploaded.",
    {
      secret: z.string().describe("Your agent secret"),
      attachment_id: z.string().describe("Attachment ID to delete"),
    },
    async ({ secret, attachment_id }) => {
      const result = await relay(`/attachments/${attachment_id}`, {
        method: "DELETE",
        secret,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless for tool calls
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
