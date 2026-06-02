import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../db/index.js";
import { agents, contacts, messages, workspaces, workspaceContacts, tasks, rooms, roomMembers, sharedDocuments, sharedDocumentVersions, sharedFacts, reactions } from "../db/schema.js";
import { contactScope, verifyContactAccess, isValidFactKey } from "../lib/context.js";
import { eq, or, and, desc, lt } from "drizzle-orm";
import { generateSecret, generatePairingCode, hashSecretAsync } from "../lib/auth.js";
import { deliverWebhook } from "../lib/webhook.js";
import { canMessage, verifyWorkspaceAccess } from "../lib/workspace.js";
import { parsePaginationQuery, paginateResults } from "../lib/pagination.js";

export function createTrunkMcpServer() {
  const server = new McpServer({
    name: "trunk",
    version: "0.1.0",
  });

  // --- Tools ---

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
    async ({ name, owner, role, workspace_code, projects, metadata: extraMeta }) => {
      const secret = generateSecret();
      const secretHash = await hashSecretAsync(secret);
      const pairingCode = generatePairingCode();
      const webhookSecret = generateSecret();

      // Build metadata from extended params
      const meta: Record<string, unknown> = {};
      if (role !== undefined) meta.role = role;
      if (projects !== undefined) meta.projects = projects;
      if (extraMeta !== undefined) Object.assign(meta, extraMeta);

      const [agent] = await db
        .insert(agents)
        .values({ name, owner, secretHash, pairingCode, webhookSecret, metadata: Object.keys(meta).length > 0 ? meta : undefined })
        .returning();

      // Auto-join workspace if code provided
      let workspaceResult: Record<string, unknown> | undefined;
      if (workspace_code) {
        const [workspace] = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.pairingCode, workspace_code.toUpperCase()))
          .limit(1);
        if (workspace) {
          await db.update(agents).set({ workspaceId: workspace.id }).where(eq(agents.id, agent.id));
          workspaceResult = { joined: true, workspace_id: workspace.id, name: workspace.name };
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            agent_id: agent.id,
            secret,
            pairing_code: agent.pairingCode,
            webhook_secret: webhookSecret,
            role,
            projects,
            workspace: workspaceResult,
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
    "Check for new messages. Returns pending (unread) messages with cursor-based pagination.",
    {
      secret: z.string().describe("Your agent secret"),
      limit: z.number().optional().describe("Max messages to return (default 50, max 100)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response"),
    },
    async ({ secret, limit: limitParam, cursor: cursorParam }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const { limit, cursor } = parsePaginationQuery({
        limit: limitParam !== undefined ? String(limitParam) : undefined,
        cursor: cursorParam,
      });

      const conditions = [eq(messages.toAgent, agent.id), eq(messages.status, "pending")];
      if (cursor) {
        conditions.push(
          or(
            lt(messages.createdAt, cursor.createdAt),
            and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id))
          )!
        );
      }

      const rows = await db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);

      const page = paginateResults(rows, limit);

      if (page.items.length === 0) {
        return { content: [{ type: "text", text: "No new messages." }] };
      }

      // Resolve sender names
      const senderIds = [...new Set(page.items.map((r) => r.fromAgent))];
      const senders = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(or(...senderIds.map((id) => eq(agents.id, id))));
      const senderMap = Object.fromEntries(senders.map((s) => [s.id, s.name]));

      const formatted = page.items.map((m) => ({
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
          text: JSON.stringify({ messages: formatted, count: page.items.length, next_cursor: page.next_cursor, has_more: page.has_more }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "trunk_inbox_stats",
    "Get inbox summary — unread count, total messages, breakdown by type and status. Quick way to triage without fetching all messages.",
    { secret: z.string().describe("Your agent secret") },
    async ({ secret }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.toAgent, agent.id));

      const unread = rows.filter((r) => r.status === "pending" || r.status === "delivered");
      const visible = rows.filter((r) => r.status !== "deleted");
      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      for (const r of unread) byType[r.type] = (byType[r.type] || 0) + 1;
      for (const r of visible) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ unread: unread.length, total: visible.length, by_type: byType, by_status: byStatus }, null, 2),
        }],
      };
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
    async ({ secret, to, type, limit: limitParam, cursor: cursorParam }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const { limit, cursor } = parsePaginationQuery({
        limit: limitParam !== undefined ? String(limitParam) : undefined,
        cursor: cursorParam,
      });

      const conditions = [eq(messages.fromAgent, agent.id)];
      if (to) conditions.push(eq(messages.toAgent, to));
      if (type) conditions.push(eq(messages.type, type));
      if (cursor) {
        conditions.push(
          or(
            lt(messages.createdAt, cursor.createdAt),
            and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id))
          )!
        );
      }

      const rows = await db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);

      const visible = rows.filter((r) => r.status !== "deleted");
      const page = paginateResults(visible, limit);

      if (page.items.length === 0) {
        return { content: [{ type: "text", text: "No sent messages found." }] };
      }

      // Resolve recipient names
      const recipientIds = [...new Set(page.items.map((r) => r.toAgent))];
      const recipients = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(or(...recipientIds.map((id) => eq(agents.id, id))));
      const recipientMap = Object.fromEntries(recipients.map((r) => [r.id, r.name]));

      const formatted = page.items.map((m) => ({
        id: m.id,
        to: recipientMap[m.toAgent] || m.toAgent,
        thread_id: m.threadId,
        type: m.type,
        payload: m.payload,
        status: m.status,
        sent_at: m.createdAt,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ messages: formatted, count: page.items.length, next_cursor: page.next_cursor, has_more: page.has_more }, null, 2),
        }],
      };
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
    async ({ secret, q, type, contact, after, before, limit: limitParam, cursor: cursorParam }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const { limit, cursor } = parsePaginationQuery({
        limit: limitParam !== undefined ? String(limitParam) : undefined,
        cursor: cursorParam,
      });

      const conditions: ReturnType<typeof eq>[] = [
        or(eq(messages.fromAgent, agent.id), eq(messages.toAgent, agent.id))!,
      ];
      if (type) {
        conditions.push(eq(messages.type, type));
      }
      if (contact) {
        conditions.push(or(
          and(eq(messages.fromAgent, agent.id), eq(messages.toAgent, contact)),
          and(eq(messages.fromAgent, contact), eq(messages.toAgent, agent.id)),
        )!);
      }
      if (cursor) {
        conditions.push(
          or(
            lt(messages.createdAt, cursor.createdAt),
            and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id))
          )!
        );
      }

      const fetchLimit = (q || after || before) ? 500 : limit + 1;
      const rows = await db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(fetchLimit);

      let visible = rows.filter((r) => r.status !== "deleted");
      const qLower = q?.toLowerCase();
      if (qLower) {
        visible = visible.filter((r) => {
          const content = (r.payload as Record<string, unknown>).content;
          return typeof content === "string" && content.toLowerCase().includes(qLower);
        });
      }
      if (after) {
        const afterDate = new Date(after);
        visible = visible.filter((r) => r.createdAt >= afterDate);
      }
      if (before) {
        const beforeDate = new Date(before);
        visible = visible.filter((r) => r.createdAt <= beforeDate);
      }

      const page = paginateResults(visible, limit);

      if (page.items.length === 0) {
        return { content: [{ type: "text", text: "No messages found matching your search." }] };
      }

      // Resolve agent names
      const agentIds = [...new Set(page.items.flatMap((m) => [m.fromAgent, m.toAgent]))];
      const agentList = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(or(...agentIds.map((id) => eq(agents.id, id))));
      const nameMap = Object.fromEntries(agentList.map((a) => [a.id, a.name]));

      const formatted = page.items.map((m) => ({
        id: m.id,
        from: nameMap[m.fromAgent] || m.fromAgent,
        to: nameMap[m.toAgent] || m.toAgent,
        thread_id: m.threadId,
        type: m.type,
        payload: m.payload,
        status: m.status,
        created_at: m.createdAt,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ messages: formatted, count: page.items.length, next_cursor: page.next_cursor, has_more: page.has_more }, null, 2),
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
    "trunk_unpair",
    "Remove a contact pairing. Both agents lose the ability to message each other.",
    {
      secret: z.string().describe("Your agent secret"),
      agent_id: z.string().describe("The contact's agent ID to unpair from"),
    },
    async ({ secret, agent_id }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const [row] = await db
        .select()
        .from(contacts)
        .where(or(
          and(eq(contacts.agentA, agent.id), eq(contacts.agentB, agent_id)),
          and(eq(contacts.agentA, agent_id), eq(contacts.agentB, agent.id))
        ))
        .limit(1);

      if (!row) return errorResult("Not a contact");

      await db
        .delete(contacts)
        .where(or(
          and(eq(contacts.agentA, agent.id), eq(contacts.agentB, agent_id)),
          and(eq(contacts.agentA, agent_id), eq(contacts.agentB, agent.id))
        ));

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, unpaired_from: agent_id }, null, 2) }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const [row] = await db
        .select()
        .from(contacts)
        .where(or(
          and(eq(contacts.agentA, agent.id), eq(contacts.agentB, agent_id)),
          and(eq(contacts.agentA, agent_id), eq(contacts.agentB, agent.id))
        ))
        .limit(1);

      if (!row) return errorResult("Not a contact");

      if (row.agentA === agent.id) {
        await db.update(contacts).set({ aliasA: alias }).where(
          and(eq(contacts.agentA, agent.id), eq(contacts.agentB, agent_id))
        );
      } else {
        await db.update(contacts).set({ aliasB: alias }).where(
          and(eq(contacts.agentA, agent_id), eq(contacts.agentB, agent.id))
        );
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, alias }, null, 2) }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      let acked = 0;
      for (const messageId of message_ids.slice(0, 100)) {
        const [msg] = await db
          .select()
          .from(messages)
          .where(and(eq(messages.id, messageId), eq(messages.toAgent, agent.id)))
          .limit(1);

        if (msg) {
          await db
            .update(messages)
            .set({ status: "processed", readAt: new Date(), processedAt: new Date() })
            .where(eq(messages.id, messageId));
          acked++;
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, acked, requested: message_ids.length }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "trunk_edit_message",
    "Edit a sent message's payload. Only the original sender can edit. Returns the updated message.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message to edit"),
      payload: z.record(z.string(), z.unknown()).describe("New payload to replace the existing one"),
    },
    async ({ secret, message_id, payload }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const [msg] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, message_id), eq(messages.fromAgent, agent.id)))
        .limit(1);

      if (!msg) return errorResult("Message not found");
      if (msg.status === "deleted") return errorResult("Cannot edit a deleted message");

      const [updated] = await db
        .update(messages)
        .set({ payload, editedAt: new Date() })
        .where(eq(messages.id, message_id))
        .returning();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            id: updated.id,
            thread_id: updated.threadId,
            payload: updated.payload,
            edited_at: updated.editedAt,
            status: updated.status,
          }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const [msg] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, message_id), eq(messages.fromAgent, agent.id)))
        .limit(1);

      if (!msg) return errorResult("Message not found");

      await db
        .update(messages)
        .set({ status: "deleted", deletedAt: new Date() })
        .where(eq(messages.id, message_id));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "trunk_purge_messages",
    "Purge messages older than the specified number of days. Permanently deletes expired messages for the authenticated agent. Defaults to 90 days.",
    {
      secret: z.string().describe("Your agent secret"),
      days: z.number().optional().describe("Number of days to retain (default: 90, min: 1, max: 3650)"),
    },
    async ({ secret, days }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const retentionDays = Math.max(1, Math.min(days ?? 90, 3650));
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

      const rows = await db
        .select()
        .from(messages)
        .where(or(eq(messages.fromAgent, agent.id), eq(messages.toAgent, agent.id)));
      const expired = rows.filter((row) => row.createdAt.getTime() < cutoff);

      for (const row of expired) {
        await db.delete(messages).where(eq(messages.id, row.id));
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ purged: expired.length, cutoff: new Date(cutoff).toISOString() }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const [msg] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, message_id),
            or(eq(messages.fromAgent, agent.id), eq(messages.toAgent, agent.id))
          )
        )
        .limit(1);

      if (!msg) return errorResult("Message not found");

      const allowed = await canMessage(agent.id, to);
      if (!allowed) return errorResult("Not a contact. Pair first.");

      const forwardedPayload: Record<string, unknown> = {
        ...msg.payload as Record<string, unknown>,
        forwarded_from: msg.fromAgent,
        original_message_id: msg.id,
      };
      if (comment) forwardedPayload.forward_comment = comment;

      const [forwarded] = await db
        .insert(messages)
        .values({
          fromAgent: agent.id,
          toAgent: to,
          type: msg.type,
          payload: forwardedPayload,
        })
        .returning();

      if (!forwarded.threadId) {
        await db
          .update(messages)
          .set({ threadId: forwarded.id })
          .where(eq(messages.id, forwarded.id));
        forwarded.threadId = forwarded.id;
      }

      await db
        .update(messages)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(eq(messages.id, forwarded.id));

      return {
        content: [{ type: "text", text: JSON.stringify({ id: forwarded.id, thread_id: forwarded.threadId, status: "delivered", created_at: forwarded.createdAt }, null, 2) }],
      };
    }
  );

  server.tool(
    "trunk_react",
    "Add an emoji reaction to a message. Both sender and recipient can react. Idempotent — reacting with the same emoji again returns the existing reaction.",
    {
      secret: z.string().describe("Your agent secret"),
      message_id: z.string().describe("ID of the message to react to"),
      emoji: z.string().describe("Emoji or short text reaction (e.g. '👍', 'ack', 'lgtm')"),
    },
    async ({ secret, message_id, emoji }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");
      if (emoji.length > 32) return errorResult("Emoji too long");

      const [msg] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, message_id),
            or(eq(messages.fromAgent, agent.id), eq(messages.toAgent, agent.id))
          )
        )
        .limit(1);

      if (!msg) return errorResult("Message not found");

      const existing = await db
        .select()
        .from(reactions)
        .where(
          and(
            eq(reactions.messageId, message_id),
            eq(reactions.agentId, agent.id),
            eq(reactions.emoji, emoji)
          )
        );

      if (existing.length > 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ id: existing[0].id, message_id, emoji, created_at: existing[0].createdAt }, null, 2) }],
        };
      }

      const [reaction] = await db
        .insert(reactions)
        .values({ messageId: message_id, agentId: agent.id, emoji })
        .returning();

      return {
        content: [{ type: "text", text: JSON.stringify({ id: reaction.id, message_id: reaction.messageId, emoji: reaction.emoji, created_at: reaction.createdAt }, null, 2) }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const existing = await db
        .select()
        .from(reactions)
        .where(
          and(
            eq(reactions.messageId, message_id),
            eq(reactions.agentId, agent.id),
            eq(reactions.emoji, emoji)
          )
        );

      if (existing.length === 0) return errorResult("Reaction not found");

      await db
        .delete(reactions)
        .where(
          and(
            eq(reactions.messageId, message_id),
            eq(reactions.agentId, agent.id),
            eq(reactions.emoji, emoji)
          )
        );

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const [msg] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, message_id),
            or(eq(messages.fromAgent, agent.id), eq(messages.toAgent, agent.id))
          )
        )
        .limit(1);

      if (!msg) return errorResult("Message not found");

      const rows = await db
        .select()
        .from(reactions)
        .where(eq(reactions.messageId, message_id));

      const summary: Record<string, { count: number; agents: string[] }> = {};
      for (const row of rows) {
        if (!summary[row.emoji]) summary[row.emoji] = { count: 0, agents: [] };
        summary[row.emoji].count++;
        summary[row.emoji].agents.push(row.agentId);
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ message_id, reactions: rows.map((r) => ({ id: r.id, emoji: r.emoji, agent_id: r.agentId, created_at: r.createdAt })), summary }, null, 2) }],
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

  server.tool(
    "trunk_thread_summary",
    "Get a structured digest of a thread — participants, message counts, decisions, open questions, and timeline. Faster than reading the full thread.",
    {
      secret: z.string().describe("Your agent secret"),
      thread_id: z.string().describe("Thread ID to summarize"),
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

      const visible = rows.filter((r) => r.status !== "deleted");
      if (visible.length === 0) return errorResult("Thread not found or empty");

      const participantIds = new Set<string>();
      for (const row of visible) {
        participantIds.add(row.fromAgent);
        participantIds.add(row.toAgent);
      }
      const participantRows = await db
        .select({ id: agents.id, name: agents.name, owner: agents.owner })
        .from(agents)
        .where(or(...[...participantIds].map((id) => eq(agents.id, id))));
      const participants = participantRows.map((p) => ({ agent_id: p.id, name: p.name, owner: p.owner }));

      const byType: Record<string, number> = {};
      for (const row of visible) byType[row.type] = (byType[row.type] || 0) + 1;

      const byStatus: Record<string, number> = {};
      for (const row of visible) byStatus[row.status] = (byStatus[row.status] || 0) + 1;

      const decisions = visible
        .filter((r) => r.type === "decision" || r.type === "handoff")
        .map((r) => ({ id: r.id, type: r.type, from: r.fromAgent, content: (r.payload as Record<string, unknown>).content ?? null, created_at: r.createdAt }));

      const repliedTo = new Set(visible.map((r) => r.replyTo).filter(Boolean));
      const openQuestions = visible
        .filter((r) => r.type === "question" && !repliedTo.has(r.id))
        .map((r) => ({ id: r.id, from: r.fromAgent, content: (r.payload as Record<string, unknown>).content ?? null, created_at: r.createdAt }));

      const first = visible[0];
      const last = visible[visible.length - 1];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            thread_id,
            message_count: visible.length,
            participants,
            by_type: byType,
            by_status: byStatus,
            decisions,
            open_questions: openQuestions,
            first_message: { id: first.id, type: first.type, from: first.fromAgent, created_at: first.createdAt },
            last_message: { id: last.id, type: last.type, from: last.fromAgent, content: (last.payload as Record<string, unknown>).content ?? null, created_at: last.createdAt },
            started_at: first.createdAt,
            last_activity: last.createdAt,
          }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      if (action === "create") {
        if (!name) return errorResult("name is required for create");
        if (agent.workspaceId) return errorResult("Already in a workspace. Leave first.");

        const pairingCode = generatePairingCode();
        const [workspace] = await db
          .insert(workspaces)
          .values({ name, owner: agent.owner, pairingCode })
          .returning();

        await db.update(agents).set({ workspaceId: workspace.id }).where(eq(agents.id, agent.id));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              workspace_id: workspace.id,
              name: workspace.name,
              pairing_code: workspace.pairingCode,
              message: `Workspace "${name}" created. Share the pairing code with external agents to let them pair with all workspace members.`,
            }, null, 2),
          }],
        };
      }

      if (action === "join") {
        if (!code) return errorResult("code is required for join");
        if (agent.workspaceId) return errorResult("Already in a workspace. Leave first.");

        const [workspace] = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.pairingCode, code.toUpperCase()))
          .limit(1);

        if (!workspace) return errorResult("Invalid workspace code");

        await db.update(agents).set({ workspaceId: workspace.id }).where(eq(agents.id, agent.id));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              joined: true,
              workspace_id: workspace.id,
              name: workspace.name,
              message: `Joined workspace "${workspace.name}".`,
            }, null, 2),
          }],
        };
      }

      if (action === "status") {
        if (!agent.workspaceId) return errorResult("Not in a workspace");

        const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, agent.workspaceId)).limit(1);
        if (!workspace) return errorResult("Workspace not found");

        const members = await db
          .select({ id: agents.id, name: agents.name, owner: agents.owner })
          .from(agents)
          .where(eq(agents.workspaceId, workspace.id));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              workspace_id: workspace.id,
              name: workspace.name,
              pairing_code: workspace.pairingCode,
              members: members.map((m) => ({ agent_id: m.id, name: m.name, owner: m.owner })),
            }, null, 2),
          }],
        };
      }

      if (action === "members") {
        if (!agent.workspaceId) return errorResult("Not in a workspace");

        const members = await db
          .select({ id: agents.id, name: agents.name, owner: agents.owner })
          .from(agents)
          .where(eq(agents.workspaceId, agent.workspaceId));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              members: members.map((m) => ({ agent_id: m.id, name: m.name, owner: m.owner })),
            }, null, 2),
          }],
        };
      }

      if (action === "leave") {
        if (!agent.workspaceId) return errorResult("Not in a workspace");

        await db.update(agents).set({ workspaceId: null }).where(eq(agents.id, agent.id));

        return {
          content: [{ type: "text", text: JSON.stringify({ left: true, message: "Left workspace." }, null, 2) }],
        };
      }

      return errorResult("Unknown action");
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
    async ({ secret, title, contact_id, room_id, workspace_id, description, priority, owner, due, start_date, group, depends_on, sequence, estimate, context_ref }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");
      if (!contact_id && !room_id && !workspace_id) return errorResult("contact_id, room_id, or workspace_id is required");

      let scope: string;
      if (workspace_id) {
        const ok = await verifyWorkspaceAccess(agent.id, workspace_id);
        if (!ok) return errorResult("Not a workspace member");
        scope = `workspace:${workspace_id}`;
      } else if (room_id) {
        const members = await db.select().from(roomMembers)
          .where(and(eq(roomMembers.roomId, room_id), eq(roomMembers.agentId, agent.id))).limit(1);
        if (members.length === 0) return errorResult("Not a room member");
        scope = `room:${room_id}`;
      } else {
        const ok = await canMessage(agent.id, contact_id!);
        if (!ok) return errorResult("Not a contact");
        scope = `contact:${[agent.id, contact_id!].sort().join("-")}`;
      }

      const [task] = await db.insert(tasks).values({
        scope, title, description, priority: priority || "medium",
        owner: owner || contact_id || undefined,
        createdBy: agent.id, due, startDate: start_date, group,
        dependsOn: depends_on || [], sequence, estimate,
        contextRef: context_ref,
      }).returning();

      return { content: [{ type: "text", text: JSON.stringify({ id: task.id, scope: task.scope, title: task.title, status: task.status, priority: task.priority, owner: task.owner, due: task.due, start_date: task.startDate, group: task.group, depends_on: task.dependsOn, sequence: task.sequence, estimate: task.estimate }, null, 2) }] };
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
    async ({ secret, contact_id, room_id, workspace_id, status, owner, group, limit: limitParam, cursor: cursorParam }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");
      if (!contact_id && !room_id && !workspace_id) return errorResult("contact_id, room_id, or workspace_id is required");

      const { limit, cursor } = parsePaginationQuery({
        limit: limitParam !== undefined ? String(limitParam) : undefined,
        cursor: cursorParam,
      });

      let scope: string;
      if (workspace_id) {
        const ok = await verifyWorkspaceAccess(agent.id, workspace_id);
        if (!ok) return errorResult("Not a workspace member");
        scope = `workspace:${workspace_id}`;
      } else if (room_id) {
        const members = await db.select().from(roomMembers)
          .where(and(eq(roomMembers.roomId, room_id), eq(roomMembers.agentId, agent.id))).limit(1);
        if (members.length === 0) return errorResult("Not a room member");
        scope = `room:${room_id}`;
      } else {
        const ok = await canMessage(agent.id, contact_id!);
        if (!ok) return errorResult("Not a contact");
        scope = `contact:${[agent.id, contact_id!].sort().join("-")}`;
      }

      const conditions = [eq(tasks.scope, scope)];
      if (status) conditions.push(eq(tasks.status, status));
      if (cursor) {
        conditions.push(
          or(
            lt(tasks.createdAt, cursor.createdAt),
            and(eq(tasks.createdAt, cursor.createdAt), lt(tasks.id, cursor.id))
          )!
        );
      }

      let rows = await db.select().from(tasks)
        .where(and(...conditions))
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(limit + 1);
      if (owner) rows = rows.filter(t => t.owner === owner);
      if (group) rows = rows.filter(t => t.group === group);

      const page = paginateResults(rows, limit);
      return { content: [{ type: "text", text: JSON.stringify({ tasks: page.items.map(t => ({ id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority, owner: t.owner, due: t.due, start_date: t.startDate, group: t.group, depends_on: t.dependsOn, sequence: t.sequence, estimate: t.estimate, created_at: t.createdAt, updated_at: t.updatedAt })), next_cursor: page.next_cursor, has_more: page.has_more }, null, 2) }] };
    }
  );

  server.tool(
    "trunk_task_update",
    "Update a task — change status, owner, title, due date, etc.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().optional().describe("Contact ID (for contact-scoped tasks)"),
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      // Verify access via whichever scope ID was provided
      const scopeId = contact_id || room_id || workspace_id;
      if (!scopeId) return errorResult("contact_id, room_id, or workspace_id is required");

      const hasContact = contact_id ? await canMessage(agent.id, contact_id) : false;
      const hasRoom = room_id ? (await db.select().from(roomMembers).where(and(eq(roomMembers.roomId, room_id), eq(roomMembers.agentId, agent.id))).limit(1)).length > 0 : false;
      const hasWs = workspace_id ? await verifyWorkspaceAccess(agent.id, workspace_id) : false;
      if (!hasContact && !hasRoom && !hasWs) return errorResult("No access");

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (status !== undefined) updates.status = status;
      if (priority !== undefined) updates.priority = priority;
      if (owner !== undefined) updates.owner = owner;
      if (due !== undefined) updates.due = due;
      if (start_date !== undefined) updates.startDate = start_date;
      if (group !== undefined) updates.group = group;
      if (depends_on !== undefined) updates.dependsOn = depends_on;
      if (sequence !== undefined) updates.sequence = sequence;
      if (estimate !== undefined) updates.estimate = estimate;

      const [updated] = await db.update(tasks).set(updates).where(eq(tasks.id, task_id)).returning();
      if (!updated) return errorResult("Task not found");

      return { content: [{ type: "text", text: JSON.stringify({ id: updated.id, title: updated.title, status: updated.status, priority: updated.priority, owner: updated.owner, due: updated.due, start_date: updated.startDate, group: updated.group, depends_on: updated.dependsOn, sequence: updated.sequence, estimate: updated.estimate, updated_at: updated.updatedAt }, null, 2) }] };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const scopeId = contact_id || room_id || workspace_id;
      if (!scopeId) return errorResult("contact_id, room_id, or workspace_id is required");

      const hasContact = contact_id ? await canMessage(agent.id, contact_id) : false;
      const hasRoom = room_id ? (await db.select().from(roomMembers).where(and(eq(roomMembers.roomId, room_id), eq(roomMembers.agentId, agent.id))).limit(1)).length > 0 : false;
      const hasWs = workspace_id ? await verifyWorkspaceAccess(agent.id, workspace_id) : false;
      if (!hasContact && !hasRoom && !hasWs) return errorResult("No access");

      const [deleted] = await db.delete(tasks).where(eq(tasks.id, task_id)).returning();
      if (!deleted) return errorResult("Task not found");

      return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted_id: deleted.id }, null, 2) }] };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      if (action === "create") {
        if (!name) return errorResult("name is required for create");
        const pairingCode = generatePairingCode();
        const [room] = await db.insert(rooms).values({ name, createdBy: agent.id, pairingCode }).returning();
        await db.insert(roomMembers).values({ roomId: room.id, agentId: agent.id, role: "creator" });
        return { content: [{ type: "text", text: JSON.stringify({ id: room.id, name: room.name, pairing_code: room.pairingCode }, null, 2) }] };
      }

      if (action === "join") {
        if (!code) return errorResult("code is required for join");
        const [room] = await db.select().from(rooms).where(eq(rooms.pairingCode, code.toUpperCase())).limit(1);
        if (!room) return errorResult("Invalid join code");
        const existing = await db.select().from(roomMembers).where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.agentId, agent.id))).limit(1);
        if (existing.length > 0) return { content: [{ type: "text", text: JSON.stringify({ joined: true, already_member: true, room_id: room.id, name: room.name }, null, 2) }] };
        await db.insert(roomMembers).values({ roomId: room.id, agentId: agent.id });
        return { content: [{ type: "text", text: JSON.stringify({ joined: true, room_id: room.id, name: room.name }, null, 2) }] };
      }

      if (action === "list") {
        const memberships = await db.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.agentId, agent.id));
        if (memberships.length === 0) return { content: [{ type: "text", text: JSON.stringify({ rooms: [] }, null, 2) }] };
        const roomIds = memberships.map(m => m.roomId);
        const roomList = await db.select().from(rooms).where(or(...roomIds.map(id => eq(rooms.id, id))));
        return { content: [{ type: "text", text: JSON.stringify({ rooms: roomList.map(r => ({ id: r.id, name: r.name, pairing_code: r.pairingCode, created_at: r.createdAt })) }, null, 2) }] };
      }

      if (action === "members") {
        if (!room_id) return errorResult("room_id is required for members");
        const members = await db.select({ agentId: roomMembers.agentId, role: roomMembers.role, joinedAt: roomMembers.joinedAt }).from(roomMembers).where(eq(roomMembers.roomId, room_id));
        const agentIds = members.map(m => m.agentId);
        const agentList = agentIds.length > 0 ? await db.select({ id: agents.id, name: agents.name, owner: agents.owner }).from(agents).where(or(...agentIds.map(id => eq(agents.id, id)))) : [];
        const agentMap = Object.fromEntries(agentList.map(a => [a.id, a]));
        return { content: [{ type: "text", text: JSON.stringify({ members: members.map(m => ({ ...agentMap[m.agentId], role: m.role, joined_at: m.joinedAt })) }, null, 2) }] };
      }

      if (action === "leave") {
        if (!room_id) return errorResult("room_id is required for leave");
        const [membership] = await db.select().from(roomMembers).where(and(eq(roomMembers.roomId, room_id), eq(roomMembers.agentId, agent.id))).limit(1);
        if (!membership) return errorResult("Not a member of this room");
        await db.delete(roomMembers).where(and(eq(roomMembers.roomId, room_id), eq(roomMembers.agentId, agent.id)));
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, room_id }) }] };
      }

      return errorResult("Unknown action");
    }
  );

  server.tool(
    "trunk_config",
    "Update your agent profile. Set role, projects, or arbitrary metadata without re-registering.",
    {
      secret: z.string().describe("Your agent secret"),
      role: z.string().optional().describe("Your role description (e.g. 'developer agent', 'planner')"),
      projects: z.array(z.string()).optional().describe("Project names this agent works on"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata to merge into your profile"),
    },
    async ({ secret, role, projects, metadata }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const existing = ((agent.metadata ?? {}) as Record<string, unknown>);
      const newMeta: Record<string, unknown> = { ...existing };
      if (role !== undefined) newMeta.role = role;
      if (projects !== undefined) newMeta.projects = projects;
      if (metadata !== undefined) Object.assign(newMeta, metadata);

      const [updated] = await db.update(agents).set({ metadata: newMeta }).where(eq(agents.id, agent.id)).returning();
      const meta = ((updated.metadata ?? {}) as Record<string, unknown>);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            agent_id: updated.id,
            name: updated.name,
            role: meta.role,
            projects: meta.projects,
            metadata: meta,
          }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      // Check access: direct contact or workspace co-member
      const isContact = await canMessage(agent.id, agent_id);
      if (!isContact) return errorResult("Not a contact or workspace co-member");

      const [target] = await db.select().from(agents).where(eq(agents.id, agent_id)).limit(1);
      if (!target) return errorResult("Agent not found");

      const meta = (target.metadata as Record<string, unknown>) || {};
      return { content: [{ type: "text", text: JSON.stringify({ agent_id: target.id, name: target.name, owner: target.owner, role: meta.role, projects: meta.projects, metadata: meta }, null, 2) }] };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");
      if (!agent.workspaceId) return errorResult("Not in a workspace");

      const members = await db
        .select({
          id: agents.id,
          name: agents.name,
          owner: agents.owner,
          lastSeenAt: agents.lastSeenAt,
          metadata: agents.metadata,
        })
        .from(agents)
        .where(eq(agents.workspaceId, agent.workspaceId));

      const now = Date.now();
      const ONLINE_THRESHOLD = 5 * 60 * 1000;
      const AWAY_THRESHOLD = 30 * 60 * 1000;

      const presence = members.map((m) => {
        const lastSeen = m.lastSeenAt ? m.lastSeenAt.getTime() : 0;
        const elapsed = now - lastSeen;
        let status: string;
        if (!m.lastSeenAt) {
          status = "offline";
        } else if (elapsed < ONLINE_THRESHOLD) {
          status = "online";
        } else if (elapsed < AWAY_THRESHOLD) {
          status = "away";
        } else {
          status = "offline";
        }

        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        return {
          agent_id: m.id,
          name: m.name,
          owner: m.owner,
          role: meta.role as string | undefined,
          status,
          last_seen_at: m.lastSeenAt,
        };
      });

      const online = presence.filter((p) => p.status === "online").length;
      const away = presence.filter((p) => p.status === "away").length;
      const offline = presence.filter((p) => p.status === "offline").length;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ workspace_id: agent.workspaceId, members: presence, online, away, offline }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      if (!agent.workspaceId) return errorResult("Not in a workspace");

      // Proxy to the billing routes via internal fetch
      const baseUrl = process.env.APP_URL ?? "https://trunk.bot";
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

      const headers: Record<string, string> = { "Authorization": `Bearer ${secret}` };
      if (body) headers["Content-Type"] = "application/json";

      const resp = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await resp.json();
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
    async ({ secret, action, contact_id, doc_id, name, body, content_type, limit: limitParam, cursor: cursorParam }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      if (!(await verifyContactAccess(agent.id, contact_id))) return errorResult("Not a contact");

      const scope = contactScope(agent.id, contact_id);

      if (action === "create") {
        if (!name || !body) return errorResult("name and body are required for create");
        const [doc] = await db
          .insert(sharedDocuments)
          .values({ scope, name, body, contentType: content_type || "text/markdown", lastEditedBy: agent.id })
          .returning();
        await db.insert(sharedDocumentVersions).values({ documentId: doc.id, version: 1, body, editedBy: agent.id });
        return { content: [{ type: "text", text: JSON.stringify({ id: doc.id, name: doc.name, content_type: doc.contentType, version: doc.version, last_edited_by: doc.lastEditedBy, created_at: doc.createdAt }, null, 2) }] };
      }

      if (action === "list") {
        const { limit, cursor } = parsePaginationQuery({
          limit: limitParam !== undefined ? String(limitParam) : undefined,
          cursor: cursorParam,
        });
        const listConditions = [eq(sharedDocuments.scope, scope)];
        if (cursor) {
          listConditions.push(
            or(
              lt(sharedDocuments.createdAt, cursor.createdAt),
              and(eq(sharedDocuments.createdAt, cursor.createdAt), lt(sharedDocuments.id, cursor.id))
            )!
          );
        }
        const docs = await db.select().from(sharedDocuments).where(and(...listConditions)).orderBy(desc(sharedDocuments.createdAt), desc(sharedDocuments.id)).limit(limit + 1);
        const page = paginateResults(docs, limit);
        return { content: [{ type: "text", text: JSON.stringify({ documents: page.items.map(d => ({ id: d.id, name: d.name, content_type: d.contentType, version: d.version, last_edited_by: d.lastEditedBy, updated_at: d.updatedAt })), next_cursor: page.next_cursor, has_more: page.has_more }, null, 2) }] };
      }

      if (action === "get") {
        if (!doc_id) return errorResult("doc_id is required for get");
        const [doc] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, doc_id)).limit(1);
        if (!doc) return errorResult("Document not found");
        return { content: [{ type: "text", text: JSON.stringify({ id: doc.id, name: doc.name, content_type: doc.contentType, body: doc.body, version: doc.version, last_edited_by: doc.lastEditedBy, created_at: doc.createdAt, updated_at: doc.updatedAt }, null, 2) }] };
      }

      if (action === "update") {
        if (!doc_id || !body) return errorResult("doc_id and body are required for update");
        const [existing] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, doc_id)).limit(1);
        if (!existing) return errorResult("Document not found");
        const newVersion = existing.version + 1;
        await db.insert(sharedDocumentVersions).values({ documentId: doc_id, version: newVersion, body, editedBy: agent.id });
        const updates: Record<string, unknown> = { body, version: newVersion, lastEditedBy: agent.id, updatedAt: new Date() };
        if (name) updates.name = name;
        const [updated] = await db.update(sharedDocuments).set(updates).where(eq(sharedDocuments.id, doc_id)).returning();
        return { content: [{ type: "text", text: JSON.stringify({ id: updated.id, name: updated.name, version: updated.version, last_edited_by: updated.lastEditedBy, updated_at: updated.updatedAt }, null, 2) }] };
      }

      if (action === "delete") {
        if (!doc_id) return errorResult("doc_id is required for delete");
        const [existing] = await db.select().from(sharedDocuments).where(eq(sharedDocuments.id, doc_id)).limit(1);
        if (!existing) return errorResult("Document not found");
        if (existing.scope !== scope) return errorResult("Document not found");
        await db.delete(sharedDocumentVersions).where(eq(sharedDocumentVersions.documentId, doc_id));
        await db.delete(sharedDocuments).where(eq(sharedDocuments.id, doc_id));
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted_id: doc_id }, null, 2) }] };
      }

      return errorResult("Unknown action");
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      if (!(await verifyContactAccess(agent.id, contact_id))) return errorResult("Not a contact");

      if (version !== undefined) {
        const [v] = await db
          .select()
          .from(sharedDocumentVersions)
          .where(and(eq(sharedDocumentVersions.documentId, doc_id), eq(sharedDocumentVersions.version, version)))
          .limit(1);
        if (!v) return errorResult("Version not found");
        return { content: [{ type: "text", text: JSON.stringify({ id: v.id, document_id: v.documentId, version: v.version, body: v.body, edited_by: v.editedBy, created_at: v.createdAt }, null, 2) }] };
      }

      const versions = await db
        .select()
        .from(sharedDocumentVersions)
        .where(eq(sharedDocumentVersions.documentId, doc_id))
        .orderBy(desc(sharedDocumentVersions.version));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            document_id: doc_id,
            versions: versions.map(v => ({ id: v.id, version: v.version, edited_by: v.editedBy, created_at: v.createdAt })),
          }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      const ok = await verifyWorkspaceAccess(agent.id, workspace_id);
      if (!ok) return errorResult("Not a workspace member");

      const scope = `workspace:${workspace_id}`;
      const allTasks = await db
        .select()
        .from(tasks)
        .where(eq(tasks.scope, scope))
        .orderBy(tasks.sequence, tasks.createdAt);

      const ownerIds = [...new Set(allTasks.map(t => t.owner).filter(Boolean))] as string[];
      const ownerRows = ownerIds.length > 0
        ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(or(...ownerIds.map(id => eq(agents.id, id))))
        : [];
      const ownerNames = Object.fromEntries(ownerRows.map(a => [a.id, a.name]));

      const doneIds = new Set(allTasks.filter(t => t.status === "done").map(t => t.id));

      const ganttTasks = allTasks.map(t => {
        const deps = (t.dependsOn as string[]) || [];
        const blockedBy = deps.filter(d => !doneIds.has(d));
        return {
          id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority,
          owner: t.owner, due: t.due, start_date: t.startDate, group: t.group,
          depends_on: t.dependsOn, sequence: t.sequence, estimate: t.estimate,
          owner_name: t.owner ? ownerNames[t.owner] || t.owner.slice(0, 8) : null,
          deps_met: blockedBy.length === 0, blocked_by: blockedBy,
        };
      });

      const grouped: Record<string, typeof ganttTasks> = {};
      const ungrouped: typeof ganttTasks = [];
      for (const t of ganttTasks) {
        if (t.group) {
          if (!grouped[t.group]) grouped[t.group] = [];
          grouped[t.group].push(t);
        } else {
          ungrouped.push(t);
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            tasks: ganttTasks, groups: grouped, ungrouped,
            summary: {
              total: allTasks.length,
              done: allTasks.filter(t => t.status === "done").length,
              in_progress: allTasks.filter(t => t.status === "in-progress").length,
              blocked: allTasks.filter(t => t.status === "blocked").length,
              open: allTasks.filter(t => t.status === "open").length,
            },
          }, null, 2),
        }],
      };
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
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      if (!(await verifyContactAccess(agent.id, contact_id))) return errorResult("Not a contact");

      const scope = contactScope(agent.id, contact_id);

      if (action === "list") {
        const facts = await db.select().from(sharedFacts).where(eq(sharedFacts.scope, scope));
        return { content: [{ type: "text", text: JSON.stringify({ facts: facts.map((f) => ({ key: f.key, value: f.value, version: f.version, updated_by: f.updatedBy, updated_at: f.updatedAt })) }, null, 2) }] };
      }

      if (!key) return errorResult("key is required for get/put/delete actions");
      if (!isValidFactKey(key)) return errorResult("Invalid fact key");

      if (action === "get") {
        const [fact] = await db.select().from(sharedFacts).where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key))).limit(1);
        if (!fact) return errorResult("Fact not found");
        return { content: [{ type: "text", text: JSON.stringify({ key: fact.key, value: fact.value, version: fact.version, updated_by: fact.updatedBy, updated_at: fact.updatedAt }, null, 2) }] };
      }

      if (action === "put") {
        if (value === undefined) return errorResult("value is required for put");
        const existing = await db.select().from(sharedFacts).where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key))).limit(1);
        if (existing.length > 0) {
          const nextVersion = existing[0].version + 1;
          await db.update(sharedFacts).set({ value, version: nextVersion, updatedBy: agent.id, updatedAt: new Date() }).where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)));
          return { content: [{ type: "text", text: JSON.stringify({ key, value, version: nextVersion, updated_by: agent.id }, null, 2) }] };
        }
        await db.insert(sharedFacts).values({ scope, key, value, updatedBy: agent.id });
        return { content: [{ type: "text", text: JSON.stringify({ key, value, version: 1, updated_by: agent.id }, null, 2) }] };
      }

      if (action === "delete") {
        await db.delete(sharedFacts).where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)));
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }] };
      }

      return errorResult("Unknown action");
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
