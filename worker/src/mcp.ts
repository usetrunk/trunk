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
    "Send a structured message to a paired contact.",
    {
      secret: z.string().describe("Your agent secret"),
      to: z.string().describe("Recipient agent ID"),
      type: z.string().describe("Message type: question, decision, review, handoff, update, ack"),
      content: z.string().describe("Message content"),
      thread_id: z.string().optional().describe("Thread ID to continue a conversation"),
      reply_to: z.string().optional().describe("Message ID this message replies to"),
      idempotency_key: z.string().optional().describe("Optional stable key for retry-safe sends"),
      context: z.string().optional().describe("Background context for the recipient"),
      urgency: z.enum(["sync", "async"]).optional().describe("sync = need response soon, async = whenever"),
      finality: z.enum(["proposed", "decided", "fyi"]).optional().describe("Is this a proposal, decision, or FYI?"),
      scheduled_at: z.string().optional().describe("ISO 8601 date for deferred delivery (must be in the future)"),
    },
    async ({ secret, to, type, content, thread_id, reply_to, idempotency_key, context, urgency, finality, scheduled_at }) => {
      const payload: Record<string, unknown> = { content };
      if (context) payload.context = context;
      if (urgency) payload.urgency = urgency;
      if (finality) payload.finality = finality;

      const result = await relay("/messages", {
        method: "POST",
        secret,
        idempotencyKey: idempotency_key ?? crypto.randomUUID(),
        body: { to, type, payload, thread_id, reply_to, ...(scheduled_at ? { scheduled_at } : {}) },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_inbox",
    "Check for new messages. Returns pending (unread) messages with cursor pagination.",
    {
      secret: z.string().describe("Your agent secret"),
      limit: z.number().optional().describe("Max messages to return (default 50, max 100)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response"),
    },
    async ({ secret, limit, cursor }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
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
    "Get inbox summary — unread count, total messages, breakdown by type and status.",
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
    "trunk_edit_message",
    "Edit a sent message's payload. Only the original sender can edit.",
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
    "trunk_delete_message",
    "Soft-delete a sent message. Only the original sender can delete.",
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
    "Purge messages older than the specified number of days. Defaults to 90 days.",
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
    "trunk_forward",
    "Forward a message to another contact. Preserves the original type and payload with provenance metadata.",
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
    "Pin a message in a thread. Surfaces key decisions and information.",
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
    "List all pinned messages in a thread. Quickly find key decisions and information.",
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
    "View the full message history of a thread.",
    {
      secret: z.string().describe("Your agent secret"),
      thread_id: z.string().describe("Thread ID to view"),
    },
    async ({ secret, thread_id }) => {
      const result = await relay(`/messages/thread/${thread_id}`, { secret });
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
    "Manage rooms (projects). Actions: create, join, list, members, leave.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["create", "join", "list", "members", "leave"]).describe("What to do"),
      name: z.string().optional().describe("Room name (for create)"),
      code: z.string().optional().describe("Join code (for join)"),
      room_id: z.string().optional().describe("Room ID (for members/leave)"),
    },
    async ({ secret, action, name, code, room_id }) => {
      if (action === "create") {
        const result = await relay("/rooms", { method: "POST", secret, body: { name } });
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
      if (action === "leave") {
        const result = await relay(`/rooms/${room_id}/leave`, { method: "POST", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      return { content: [{ type: "text", text: "Unknown action" }] };
    }
  );

  server.tool(
    "trunk_workspace",
    "Manage workspaces — groups of agents that share contacts. Actions: create, join, status, members, leave.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["create", "join", "status", "members", "leave"]).describe("Action to perform"),
      name: z.string().optional().describe("Workspace name (for create)"),
      code: z.string().optional().describe("Workspace pairing code (for join)"),
    },
    async ({ secret, action, name, code }) => {
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
      return { content: [{ type: "text", text: "Unknown action" }] };
    }
  );

  server.tool(
    "trunk_config",
    "Update your agent profile on the server. Set role, projects, or arbitrary metadata without re-registering.",
    {
      secret: z.string().describe("Your agent secret"),
      role: z.string().optional().describe("Your role description (e.g. 'developer agent', 'planner')"),
      projects: z.array(z.string()).optional().describe("Project names this agent works on"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata to merge into your profile"),
    },
    async ({ secret, role, projects, metadata }) => {
      const body: Record<string, unknown> = {};
      if (role !== undefined) body.role = role;
      if (projects !== undefined) body.projects = projects;
      if (metadata !== undefined) body.metadata = metadata;
      const result = await relay("/agents/me", { method: "PATCH", secret, body });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_profile",
    "Look up another agent's public profile (role, projects, metadata). They must be a contact or workspace co-member.",
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
    "Manage webhook configuration. Actions: status (view config), set (configure URL), remove (clear URL), rotate_secret (new signing secret), deliveries (recent delivery log), test (send test ping).",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["status", "set", "remove", "rotate_secret", "deliveries", "test"]).describe("Action to perform"),
      url: z.string().optional().describe("Webhook URL (required for 'set' action)"),
      limit: z.number().optional().describe("Max deliveries to return (for 'deliveries' action, default 20)"),
    },
    async ({ secret, action, url, limit: deliveryLimit }) => {
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
    "Manage shared documents with a contact. Actions: create, list, get, update, delete. List action supports cursor pagination.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["create", "list", "get", "update", "delete"]).describe("Action to perform"),
      contact_id: z.string().describe("Agent ID of the contact (documents are scoped to a contact pair)"),
      doc_id: z.string().optional().describe("Document ID (for get, update, delete)"),
      name: z.string().optional().describe("Document name (for create)"),
      body: z.string().optional().describe("Document body (for create, update)"),
      content_type: z.string().optional().describe("Content type (for create, default: text/markdown)"),
      limit: z.number().optional().describe("Max documents to return for list action (default 50, max 100)"),
      cursor: z.string().optional().describe("Pagination cursor for list action"),
    },
    async ({ secret, action, contact_id, doc_id, name, body, content_type, limit, cursor }) => {
      if (action === "create") {
        if (!name || !body) return { content: [{ type: "text", text: "Error: name and body are required for create" }], isError: true };
        const result = await relay(`/documents/${contact_id}`, { method: "POST", secret, body: { name, body, content_type } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "list") {
        const params = new URLSearchParams();
        if (limit !== undefined) params.set("limit", String(limit));
        if (cursor) params.set("cursor", cursor);
        const query = params.toString();
        const result = await relay(`/documents/${contact_id}${query ? `?${query}` : ""}`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "get") {
        if (!doc_id) return { content: [{ type: "text", text: "Error: doc_id is required for get" }], isError: true };
        const result = await relay(`/documents/${contact_id}/${doc_id}`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "update") {
        if (!doc_id || !body) return { content: [{ type: "text", text: "Error: doc_id and body are required for update" }], isError: true };
        const payload: Record<string, unknown> = { body };
        if (name) payload.name = name;
        const result = await relay(`/documents/${contact_id}/${doc_id}`, { method: "PUT", secret, body: payload });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "delete") {
        if (!doc_id) return { content: [{ type: "text", text: "Error: doc_id is required for delete" }], isError: true };
        const result = await relay(`/documents/${contact_id}/${doc_id}`, { method: "DELETE", secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      return { content: [{ type: "text", text: "Error: Unknown action" }], isError: true };
    }
  );

  server.tool(
    "trunk_document_versions",
    "List version history or get a specific version of a shared document.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().describe("Agent ID of the contact"),
      doc_id: z.string().describe("Document ID"),
      version: z.number().optional().describe("Specific version to retrieve (omit for full history)"),
    },
    async ({ secret, contact_id, doc_id, version }) => {
      if (version !== undefined) {
        const result = await relay(`/documents/${encodeURIComponent(contact_id)}/${encodeURIComponent(doc_id)}/versions/${version}`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      const result = await relay(`/documents/${encodeURIComponent(contact_id)}/${encodeURIComponent(doc_id)}/versions`, { secret });
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
    "Manage shared facts (key-value context) with a contact. Actions: list, get, put, delete.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["list", "get", "put", "delete"]).describe("Action to perform"),
      contact_id: z.string().describe("Agent ID of the contact"),
      key: z.string().optional().describe("Fact key (required for get/put/delete, not needed for list)"),
      value: z.unknown().optional().describe("Fact value (for put)"),
    },
    async ({ secret, action, contact_id, key, value }) => {
      if (action === "list") {
        const result = await relay(`/context/${contact_id}/facts`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (!key) return { content: [{ type: "text", text: "Error: key is required for get/put/delete actions" }], isError: true };

      if (action === "get") {
        const result = await relay(`/context/${contact_id}/facts/${encodeURIComponent(key)}`, { secret });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "put") {
        if (value === undefined) return { content: [{ type: "text", text: "Error: value is required for put" }], isError: true };
        const result = await relay(`/context/${contact_id}/facts/${encodeURIComponent(key)}`, { method: "PUT", secret, body: { value } });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (action === "delete") {
        const result = await relay(`/context/${contact_id}/facts/${encodeURIComponent(key)}`, { method: "DELETE", secret });
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
