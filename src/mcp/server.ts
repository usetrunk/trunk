import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../db/index.js";
import { agents, contacts, messages } from "../db/schema.js";
import { eq, or, and, desc } from "drizzle-orm";
import { generateSecret, generatePairingCode, hashSecretAsync } from "../lib/auth.js";
import { deliverWebhook } from "../lib/webhook.js";

export function createTrunkMcpServer() {
  const server = new McpServer({
    name: "trunk",
    version: "0.1.0",
  });

  // --- Tools ---

  server.tool(
    "trunk_register",
    "Register a new agent with Trunk. Returns your secret (save it!) and pairing code (share it with contacts).",
    { name: z.string().describe("Display name for your agent"), owner: z.string().optional().describe("Your name (human operator)") },
    async ({ name, owner }) => {
      const secret = generateSecret();
      const secretHash = await hashSecretAsync(secret);
      const pairingCode = generatePairingCode();
      const webhookSecret = generateSecret();

      const [agent] = await db
        .insert(agents)
        .values({ name, owner, secretHash, pairingCode, webhookSecret })
        .returning();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            agent_id: agent.id,
            secret,
            pairing_code: agent.pairingCode,
            webhook_secret: webhookSecret,
            instructions: "Save your secret — it won't be shown again. Share your pairing_code with contacts so they can pair with you.",
          }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const [target] = await db
        .select()
        .from(agents)
        .where(eq(agents.pairingCode, code.toUpperCase()))
        .limit(1);

      if (!target) return errorResult("Invalid pairing code");
      if (target.id === agent.id) return errorResult("Cannot pair with yourself");

      const existing = await db
        .select()
        .from(contacts)
        .where(or(
          and(eq(contacts.agentA, agent.id), eq(contacts.agentB, target.id)),
          and(eq(contacts.agentA, target.id), eq(contacts.agentB, agent.id))
        ))
        .limit(1);

      if (existing.length > 0) return errorResult("Already paired with this agent");

      await db.insert(contacts).values({ agentA: agent.id, agentB: target.id, aliasA: alias });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            paired_with: { agent_id: target.id, name: target.name, owner: target.owner },
            message: `Paired successfully. You can now send messages to ${target.name}.`,
          }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      // Verify contact
      const contact = await db
        .select()
        .from(contacts)
        .where(or(
          and(eq(contacts.agentA, agent.id), eq(contacts.agentB, to)),
          and(eq(contacts.agentA, to), eq(contacts.agentB, agent.id))
        ))
        .limit(1);

      if (contact.length === 0) return errorResult("Not a contact. Pair first.");

      const payload: Record<string, unknown> = { content };
      if (context) payload.context = context;
      if (urgency) payload.urgency = urgency;
      if (finality) payload.finality = finality;

      const [message] = await db
        .insert(messages)
        .values({
          fromAgent: agent.id,
          toAgent: to,
          threadId: thread_id,
          replyTo: reply_to,
          idempotencyKey: idempotency_key ?? crypto.randomUUID(),
          type,
          payload,
        })
        .returning();

      if (!message.threadId) {
        await db.update(messages).set({ threadId: message.id }).where(eq(messages.id, message.id));
        message.threadId = message.id;
      }

      // Deliver webhook
      const [recipient] = await db.select().from(agents).where(eq(agents.id, to)).limit(1);
      if (recipient) deliverWebhook(message, recipient).catch(() => {});

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sent: true,
            message_id: message.id,
            thread_id: message.threadId,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "trunk_inbox",
    "Check for new messages. Returns all pending (unread) messages.",
    { secret: z.string().describe("Your agent secret") },
    async ({ secret }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const rows = await db
        .select()
        .from(messages)
        .where(and(eq(messages.toAgent, agent.id), eq(messages.status, "pending")))
        .orderBy(desc(messages.createdAt))
        .limit(50);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No new messages." }] };
      }

      // Resolve sender names
      const senderIds = [...new Set(rows.map((r) => r.fromAgent))];
      const senders = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(or(...senderIds.map((id) => eq(agents.id, id))));
      const senderMap = Object.fromEntries(senders.map((s) => [s.id, s.name]));

      const formatted = rows.map((m) => ({
        id: m.id,
        from: senderMap[m.fromAgent] || m.fromAgent,
        thread_id: m.threadId,
        type: m.type,
        payload: m.payload,
        sent_at: m.createdAt,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ messages: formatted, count: rows.length }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const [original] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, message_id), eq(messages.toAgent, agent.id)))
        .limit(1);

      if (!original) return errorResult("Message not found");

      await db.update(messages)
        .set({ status: "replied", repliedAt: new Date() })
        .where(eq(messages.id, message_id));

      const payload: Record<string, unknown> = { content };
      if (finality) payload.finality = finality;

      const [reply] = await db
        .insert(messages)
        .values({
          fromAgent: agent.id,
          toAgent: original.fromAgent,
          threadId: original.threadId,
          replyTo: reply_to ?? original.id,
          idempotencyKey: idempotency_key ?? crypto.randomUUID(),
          type,
          payload,
        })
        .returning();

      const [recipient] = await db.select().from(agents).where(eq(agents.id, original.fromAgent)).limit(1);
      if (recipient) deliverWebhook(reply, recipient).catch(() => {});

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ replied: true, message_id: reply.id, thread_id: reply.threadId }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "trunk_contacts",
    "List your paired contacts.",
    { secret: z.string().describe("Your agent secret") },
    async ({ secret }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const rows = await db
        .select()
        .from(contacts)
        .where(or(eq(contacts.agentA, agent.id), eq(contacts.agentB, agent.id)));

      const contactIds = rows.map((r) => r.agentA === agent.id ? r.agentB : r.agentA);

      if (contactIds.length === 0) {
        return { content: [{ type: "text", text: "No contacts yet. Use trunk_pair to connect with someone." }] };
      }

      const contactAgents = await db
        .select({ id: agents.id, name: agents.name, owner: agents.owner })
        .from(agents)
        .where(or(...contactIds.map((id) => eq(agents.id, id))));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ contacts: contactAgents }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const rows = await db
        .select()
        .from(messages)
        .where(and(
          eq(messages.threadId, thread_id),
          or(eq(messages.fromAgent, agent.id), eq(messages.toAgent, agent.id))
        ))
        .orderBy(messages.createdAt);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ thread_id, messages: rows }, null, 2),
        }],
      };
    }
  );

  return server;
}

// --- Helpers ---

async function resolveAgent(secret: string) {
  const hash = await hashSecretAsync(secret);
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.secretHash, hash))
    .limit(1);
  return agent || null;
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}
