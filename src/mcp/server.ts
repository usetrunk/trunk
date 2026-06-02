import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../db/index.js";
import { agents, contacts, messages, workspaces, workspaceContacts, tasks, rooms, roomMembers, sharedDocuments, sharedDocumentVersions, sharedFacts } from "../db/schema.js";
import { contactScope, verifyContactAccess, isValidFactKey } from "../lib/context.js";
import { eq, or, and, desc } from "drizzle-orm";
import { generateSecret, generatePairingCode, hashSecretAsync } from "../lib/auth.js";
import { deliverWebhook } from "../lib/webhook.js";
import { canMessage, verifyWorkspaceAccess } from "../lib/workspace.js";

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
    "List tasks for a contact, room, or workspace.",
    {
      secret: z.string().describe("Your agent secret"),
      contact_id: z.string().optional().describe("Agent ID of the contact"),
      room_id: z.string().optional().describe("Room ID"),
      workspace_id: z.string().optional().describe("Workspace ID"),
      status: z.string().optional().describe("Filter: open, in-progress, done, blocked"),
      owner: z.string().optional().describe("Filter by owner agent ID"),
      group: z.string().optional().describe("Filter by group/epic"),
    },
    async ({ secret, contact_id, room_id, workspace_id, status, owner, group }) => {
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

      let rows = await db.select().from(tasks)
        .where(status ? and(eq(tasks.scope, scope), eq(tasks.status, status)) : eq(tasks.scope, scope))
        .orderBy(desc(tasks.createdAt));
      if (owner) rows = rows.filter(t => t.owner === owner);
      if (group) rows = rows.filter(t => t.group === group);

      return { content: [{ type: "text", text: JSON.stringify({ tasks: rows.map(t => ({ id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority, owner: t.owner, due: t.due, start_date: t.startDate, group: t.group, depends_on: t.dependsOn, sequence: t.sequence, estimate: t.estimate, created_at: t.createdAt, updated_at: t.updatedAt })) }, null, 2) }] };
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
    "Manage shared documents with a contact. Actions: create, list, get, update.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["create", "list", "get", "update"]).describe("Action to perform"),
      contact_id: z.string().describe("Agent ID of the contact (documents are scoped to a contact pair)"),
      doc_id: z.string().optional().describe("Document ID (for get, update)"),
      name: z.string().optional().describe("Document name (for create)"),
      body: z.string().optional().describe("Document body (for create, update)"),
      content_type: z.string().optional().describe("Content type (for create, default: text/markdown)"),
    },
    async ({ secret, action, contact_id, doc_id, name, body, content_type }) => {
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
        const docs = await db.select().from(sharedDocuments).where(eq(sharedDocuments.scope, scope)).orderBy(desc(sharedDocuments.updatedAt));
        return { content: [{ type: "text", text: JSON.stringify({ documents: docs.map(d => ({ id: d.id, name: d.name, content_type: d.contentType, version: d.version, last_edited_by: d.lastEditedBy, updated_at: d.updatedAt })) }, null, 2) }] };
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

      return errorResult("Unknown action");
    }
  );

  // --- Facts (shared context) ---

  server.tool(
    "trunk_fact",
    "Manage shared facts (key-value context) with a contact. Actions: get, put, delete.",
    {
      secret: z.string().describe("Your agent secret"),
      action: z.enum(["get", "put", "delete"]).describe("Action to perform"),
      contact_id: z.string().describe("Agent ID of the contact"),
      key: z.string().describe("Fact key (alphanumeric, dots, hyphens, underscores)"),
      value: z.unknown().optional().describe("Fact value (for put)"),
    },
    async ({ secret, action, contact_id, key, value }) => {
      const agent = await resolveAgent(secret);
      if (!agent) return errorResult("Invalid secret");

      if (!isValidFactKey(key)) return errorResult("Invalid fact key");
      if (!(await verifyContactAccess(agent.id, contact_id))) return errorResult("Not a contact");

      const scope = contactScope(agent.id, contact_id);

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
