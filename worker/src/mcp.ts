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
    },
    async ({ secret, to, type, content, thread_id, reply_to, idempotency_key, context, urgency, finality }) => {
      const payload: Record<string, unknown> = { content };
      if (context) payload.context = context;
      if (urgency) payload.urgency = urgency;
      if (finality) payload.finality = finality;

      const result = await relay("/messages", {
        method: "POST",
        secret,
        idempotencyKey: idempotency_key ?? crypto.randomUUID(),
        body: { to, type, payload, thread_id, reply_to },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_inbox",
    "Check for new messages. Returns all pending (unread) messages.",
    { secret: z.string().describe("Your agent secret") },
    async ({ secret }) => {
      const result = await relay("/messages/inbox", { secret });
      const msgs = result.messages || [];
      if (msgs.length === 0) {
        return { content: [{ type: "text", text: "No new messages." }] };
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
      context_ref: z.string().optional().describe("Reference to a thread or message"),
    },
    async ({ secret, title, contact_id, room_id, workspace_id, description, priority, owner, due, context_ref }) => {
      const result = await relay("/tasks", { method: "POST", secret, body: { contact_id, room_id, workspace_id, title, description, priority, owner, due, context_ref } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_task_list",
    "List tasks for a contact, room, or workspace.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().optional().describe("Agent ID of the contact"),
      room_id: z.string().optional().describe("Room ID"),
      workspace_id: z.string().optional().describe("Workspace ID"),
      status: z.string().optional().describe("Filter: open, in-progress, done, blocked"),
      owner: z.string().optional().describe("Filter by owner agent ID"),
    },
    async ({ secret, contact_id, room_id, workspace_id, status, owner }) => {
      let path: string;
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (owner) params.set("owner", owner);
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
    },
    async ({ secret, contact_id, room_id, workspace_id, task_id, status, priority, owner, title, description, due }) => {
      const scopeId = contact_id || room_id || workspace_id;
      const body: Record<string, unknown> = {};
      if (status !== undefined) body.status = status;
      if (priority !== undefined) body.priority = priority;
      if (owner !== undefined) body.owner = owner;
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (due !== undefined) body.due = due;
      const result = await relay(`/tasks/${scopeId}/${task_id}`, { method: "PATCH", secret, body });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_room",
    "Manage rooms (projects). Actions: create, join, list, members.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["create", "join", "list", "members"]).describe("What to do"),
      name: z.string().optional().describe("Room name (for create)"),
      code: z.string().optional().describe("Join code (for join)"),
      room_id: z.string().optional().describe("Room ID (for members)"),
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
