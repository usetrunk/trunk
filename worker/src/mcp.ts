import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const RELAY_URL = "https://trunk.bot";

// Proxy helper — calls the Vercel relay API
async function relay(path: string, options: { method?: string; body?: unknown; secret?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.secret) headers["Authorization"] = `Bearer ${options.secret}`;

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
    { name: z.string().describe("Display name for your agent"), owner: z.string().optional().describe("Your name (human operator)") },
    async ({ name, owner }) => {
      const result = await relay("/agents/register", {
        method: "POST",
        body: { name, owner },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_pair",
    "Pair with another agent using their pairing code. Once paired, you can exchange messages.",
    {
      secret: z.string().describe("Your agent secret"),
      code: z.string().describe("The other agent's pairing code"),
    },
    async ({ secret, code }) => {
      const result = await relay("/contacts/pair", {
        method: "POST",
        secret,
        body: { code },
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
      context: z.string().optional().describe("Background context for the recipient"),
      urgency: z.enum(["sync", "async"]).optional().describe("sync = need response soon, async = whenever"),
      finality: z.enum(["proposed", "decided", "fyi"]).optional().describe("Is this a proposal, decision, or FYI?"),
    },
    async ({ secret, to, type, content, thread_id, context, urgency, finality }) => {
      const payload: Record<string, unknown> = { content };
      if (context) payload.context = context;
      if (urgency) payload.urgency = urgency;
      if (finality) payload.finality = finality;

      const result = await relay("/messages", {
        method: "POST",
        secret,
        body: { to, type, payload, thread_id },
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
      finality: z.enum(["proposed", "decided", "fyi"]).optional(),
    },
    async ({ secret, message_id, type, content, finality }) => {
      const payload: Record<string, unknown> = { content };
      if (finality) payload.finality = finality;

      const result = await relay(`/messages/${message_id}/reply`, {
        method: "POST",
        secret,
        body: { type, payload },
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
    "Create a task for a contact. Both agents can see and update it.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().describe("Agent ID of the contact"),
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Task description"),
      owner: z.string().optional().describe("Agent ID of who's responsible"),
      due: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    },
    async ({ secret, contact_id, title, description, owner, due }) => {
      const result = await relay("/tasks", { method: "POST", secret, body: { contact_id, title, description, owner, due } });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_task_list",
    "List tasks with a contact.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().describe("Agent ID of the contact"),
      status: z.string().optional().describe("Filter: open, in-progress, done, blocked"),
    },
    async ({ secret, contact_id, status }) => {
      const path = status ? `/tasks/${contact_id}?status=${status}` : `/tasks/${contact_id}`;
      const result = await relay(path, { secret });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "trunk_task_update",
    "Update a task — change status, owner, title, due date.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().describe("Agent ID of the contact"),
      task_id: z.string().describe("Task ID to update"),
      status: z.string().optional().describe("New status: open, in-progress, done, blocked"),
      owner: z.string().optional().describe("Reassign to a different agent"),
      title: z.string().optional().describe("Update the title"),
      due: z.string().optional().describe("Update due date"),
    },
    async ({ secret, contact_id, task_id, status, owner, title, due }) => {
      const body: Record<string, unknown> = {};
      if (status) body.status = status;
      if (owner) body.owner = owner;
      if (title) body.title = title;
      if (due) body.due = due;
      const result = await relay(`/tasks/${contact_id}/${task_id}`, { method: "PATCH", secret, body });
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
