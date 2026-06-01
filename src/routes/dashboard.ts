import { Hono } from "hono";
import { html } from "hono/html";
import { db } from "../db/index.js";
import { agents, contacts, messages, roomMembers, rooms, tasks } from "../db/schema.js";
import { and, eq, or, desc } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

// Dashboard auth via query param (simple for now — will move to cookies/sessions later)
app.use("/*", async (c, next) => {
  // Try bearer token from Authorization header first
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authMiddleware(c, next);
  }
  // Fall back to ?secret= query param for browser access
  const secret = c.req.query("secret");
  if (!secret) {
    return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trunk Dashboard</title>
  <style>${dashboardStyles()}</style>
</head>
<body>
  <div class="card" style="max-width:400px;margin:auto;margin-top:20vh;">
    <div class="logo">trunk</div>
    <h2>Sign in</h2>
    <form method="GET">
      <input type="password" name="secret" placeholder="Agent secret" style="width:100%;margin:1rem 0;padding:0.75rem;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#fff;font-size:0.9rem;">
      <button type="submit" style="width:100%;padding:0.75rem;background:#7c6aef;border:none;border-radius:6px;color:#fff;font-weight:600;cursor:pointer;">Sign in</button>
    </form>
  </div>
</body>
</html>`);
  }
  // Manually inject the auth header for the middleware
  const newHeaders = new Headers(c.req.raw.headers);
  newHeaders.set("Authorization", `Bearer ${secret}`);
  const newReq = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: newHeaders,
  });
  Object.defineProperty(c.req, "raw", { value: newReq, writable: true });
  Object.defineProperty(c.req, "header", {
    value: (name: string) => newHeaders.get(name),
    writable: true,
  });
  return authMiddleware(c, next);
});

app.get("/", async (c) => {
  const agent = c.get("agent");
  const agentId = c.get("agentId");
  const secret = c.req.query("secret") || "";

  // Get contacts
  const contactRows = await db
    .select()
    .from(contacts)
    .where(or(eq(contacts.agentA, agentId), eq(contacts.agentB, agentId)));

  const contactIds = contactRows.map((r) => r.agentA === agentId ? r.agentB : r.agentA);

  const memberships = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.agentId, agentId));
  const roomIds = memberships.map((membership) => membership.roomId);
  const roomRows = roomIds.length > 0
    ? await db
        .select()
        .from(rooms)
        .where(or(...roomIds.map((id) => eq(rooms.id, id))))
    : [];
  const memberRows = roomIds.length > 0
    ? await db
        .select()
        .from(roomMembers)
        .where(or(...roomIds.map((id) => eq(roomMembers.roomId, id))))
    : [];
  const roomTaskRows = roomIds.length > 0
    ? await db
        .select()
        .from(tasks)
        .where(or(...roomIds.map((id) => eq(tasks.scope, `room:${id}`))))
        .orderBy(desc(tasks.createdAt))
    : [];

  // Get recent messages
  const recentMessages = await db
    .select()
    .from(messages)
    .where(or(eq(messages.toAgent, agentId), eq(messages.fromAgent, agentId)))
    .orderBy(desc(messages.createdAt))
    .limit(20);

  const visibleAgentIds = unique([
    agentId,
    ...contactIds,
    ...memberRows.map((member) => member.agentId),
    ...recentMessages.flatMap((message) => [message.fromAgent, message.toAgent]),
  ]);
  const visibleAgents = visibleAgentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name, owner: agents.owner })
        .from(agents)
        .where(or(...visibleAgentIds.map((id) => eq(agents.id, id))))
    : [];
  const agentNames = new Map(visibleAgents.map((visibleAgent) => [visibleAgent.id, visibleAgent.name]));
  const contactAgents = contactIds.map((contactId) => ({
    id: contactId,
    name: agentNames.get(contactId) ?? contactId,
    owner: visibleAgents.find((visibleAgent) => visibleAgent.id === contactId)?.owner,
  }));

  // Count pending
  const pendingCount = recentMessages.filter(m => m.toAgent === agentId && m.status === "pending").length;

  // Active threads
  const threads = new Map<string, { count: number; lastActivity: Date; participants: Set<string> }>();
  for (const m of recentMessages) {
    const tid = m.threadId || m.id;
    if (!threads.has(tid)) {
      threads.set(tid, { count: 0, lastActivity: m.createdAt, participants: new Set() });
    }
    const t = threads.get(tid)!;
    t.count++;
    t.participants.add(m.fromAgent);
    if (m.createdAt > t.lastActivity) t.lastActivity = m.createdAt;
  }
  const transcriptMessages = [...recentMessages].reverse();
  const openRoomTasks = roomTaskRows.filter((task) => task.status !== "done");

  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trunk Dashboard</title>
  <style>${dashboardStyles()}</style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand-block">
        <div class="logo">trunk</div>
        <div class="agent-name">${agent.name}</div>
      </div>
      <div class="sidebar-section">
        <div class="sidebar-label">Contacts</div>
        ${contactAgents.length === 0
          ? html`<div class="sidebar-empty">No contacts yet</div>`
          : contactAgents.map((ca) => {
            const contactMessages = recentMessages.filter((m) => m.fromAgent === ca.id || m.toAgent === ca.id).length;
            return html`
              <a class="sidebar-item" href="/dashboard?secret=${secret}">
                <span class="presence-dot"></span>
                <span class="sidebar-main">${ca.name}</span>
                <span class="sidebar-count">${contactMessages}</span>
              </a>
            `;
          })}
      </div>
      <div class="sidebar-section">
        <div class="sidebar-label">Rooms</div>
        ${roomRows.length === 0
          ? html`<div class="sidebar-empty">No rooms yet</div>`
          : roomRows.map((room) => {
            const members = memberRows.filter((member) => member.roomId === room.id);
            const roomTasks = roomTaskRows.filter((task) => task.scope === `room:${room.id}` && task.status !== "done");
            return html`
              <a class="sidebar-item room" href="/dashboard?secret=${secret}">
                <span class="room-hash">#</span>
                <span class="sidebar-main">${room.name}</span>
                <span class="sidebar-count">${roomTasks.length}</span>
                <span class="sidebar-sub">${members.length} agents</span>
              </a>
            `;
          })}
      </div>
      <div class="sidebar-footer">
        <div class="sidebar-label">Pairing code</div>
        <a class="pairing-code" href="https://trunk.bot/connect/${agent.pairingCode}">${agent.pairingCode}</a>
      </div>
    </aside>

    <main class="conversation-panel">
      <header class="conversation-header">
        <div>
          <div class="eyebrow">Observer <span class="badge">read-only</span></div>
          <h1>Agent coordination</h1>
        </div>
        <div class="health-strip">
          <div><span>Connected</span><strong class="good">live</strong></div>
          <div><span>Pending</span><strong>${pendingCount}</strong></div>
          <div><span>Threads</span><strong>${threads.size}</strong></div>
        </div>
      </header>

      <section class="conversation-body">
        <div class="chat-stream">
          <div class="stream-title">
            <span>Messages</span>
            <a href="/dashboard/inbox?secret=${secret}">Inbox</a>
          </div>
          ${transcriptMessages.length === 0
            ? html`<p class="empty">No visible direct messages.</p>`
            : transcriptMessages.map((m) => {
              const from = agentNames.get(m.fromAgent) ?? m.fromAgent.slice(0, 8);
              const to = agentNames.get(m.toAgent) ?? m.toAgent.slice(0, 8);
              const isMine = m.fromAgent === agentId;
              const payload = m.payload as Record<string, unknown>;
              const content = (payload.content as string) || JSON.stringify(m.payload);
              const context = payload.context as string | undefined;
              const finality = payload.finality as string | undefined;
              return html`
                <article class="chat-message ${isMine ? "mine" : "theirs"}">
                  <div class="avatar">${initials(from)}</div>
                  <div class="bubble">
                    <div class="message-heading">
                      <strong>${from}</strong>
                      <span>to ${to}</span>
                      <span>${m.type}</span>
                      ${finality ? html`<span>${finality}</span>` : ""}
                      <time>${timeAgo(m.createdAt)}</time>
                    </div>
                    <div class="message-copy">${content}</div>
                    ${context ? html`<div class="message-context">${context}</div>` : ""}
                  </div>
                </article>
              `;
            })}
        </div>

        <aside class="context-rail">
          <section class="rail-section">
            <div class="rail-title">Rooms</div>
            ${roomRows.length === 0
              ? html`<p class="empty">No rooms yet.</p>`
              : roomRows.map((room) => {
                const members = memberRows.filter((member) => member.roomId === room.id);
                const roomTasks = roomTaskRows.filter((task) => task.scope === `room:${room.id}`);
                return html`
                  <div class="room-card">
                    <div class="room-title">${room.name}</div>
                    <div class="room-subtitle">${members.length} members, ${roomTasks.filter((task) => task.status !== "done").length} open tasks</div>
                    <div class="pill-row">
                      ${members.map((member) => html`<span class="pill">${agentNames.get(member.agentId) ?? member.agentId.slice(0, 8)}</span>`)}
                    </div>
                  </div>
                `;
              })}
          </section>

          <section class="rail-section">
            <div class="rail-title">Open room work</div>
            ${openRoomTasks.length === 0
              ? html`<p class="empty">No open room tasks.</p>`
              : openRoomTasks.slice(0, 8).map((task) => html`
                <div class="task-line">
                  <span class="task-status ${task.status}">${task.status}</span>
                  <span>${task.title}</span>
                </div>
              `)}
          </section>

          <section class="rail-section">
            <div class="rail-title">Active threads</div>
            ${threads.size === 0
              ? html`<p class="empty">No threads yet.</p>`
              : Array.from(threads.entries()).slice(0, 6).map(([tid, t]) => html`
                <a class="thread-link" href="/dashboard/thread/${tid}?secret=${secret}">
                  <span class="mono">${tid.slice(0, 8)}</span>
                  <span>${t.count} msgs</span>
                  <time>${timeAgo(t.lastActivity)}</time>
                </a>
              `)}
          </section>
        </aside>
      </section>
    </main>
  </div>
</body>
</html>`);
});

// Thread detail view
app.get("/thread/:threadId", async (c) => {
  const agent = c.get("agent");
  const agentId = c.get("agentId");
  const secret = c.req.query("secret") || "";
  const threadId = c.req.param("threadId");

  const threadMessages = await db
    .select()
    .from(messages)
    .where(and(
      eq(messages.threadId, threadId),
      or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId))
    ))
    .orderBy(messages.createdAt);

  // Resolve agent names
  const agentIds = [...new Set(threadMessages.flatMap(m => [m.fromAgent, m.toAgent]))];
  const agentRows = agentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(or(...agentIds.map(id => eq(agents.id, id))))
    : [];
  const nameMap = Object.fromEntries(agentRows.map(a => [a.id, a.name]));

  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Thread — Trunk</title>
  <style>${dashboardStyles()}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <a href="/dashboard?secret=${secret}" class="logo" style="text-decoration:none;">← trunk</a>
      <div class="agent-name">Thread ${threadId.slice(0, 8)}...</div>
    </div>

    <div class="card wide">
      <div class="card-title">${threadMessages.length} messages</div>
      ${threadMessages.map((m) => {
        const isMine = m.fromAgent === agentId;
        const senderName = nameMap[m.fromAgent] || m.fromAgent.slice(0, 8);
        const payload = m.payload as Record<string, unknown>;
        const content = (payload.content as string) || "";
        const context = (payload.context as string) || "";
        const urgency = (payload.urgency as string) || "";
        const finality = (payload.finality as string) || "";

        return html`
          <div class="thread-msg ${isMine ? "mine" : "theirs"}">
            <div class="thread-msg-header">
              <span class="thread-sender">${senderName}</span>
              <span class="thread-type">${m.type}</span>
              ${finality ? html`<span class="thread-finality">${finality}</span>` : ""}
              ${urgency ? html`<span class="thread-urgency">${urgency}</span>` : ""}
              <span class="thread-time">${timeAgo(m.createdAt)}</span>
              <span class="thread-status">${m.status}</span>
            </div>
            <div class="thread-msg-body">${content}</div>
            ${context ? html`<div class="thread-msg-context">${context}</div>` : ""}
          </div>
        `;
      })}
    </div>
  </div>
</body>
</html>`);
});

// Inbox view — all pending messages with full content
app.get("/inbox", async (c) => {
  const agent = c.get("agent");
  const agentId = c.get("agentId");
  const secret = c.req.query("secret") || "";
  const statusFilter = c.req.query("status") || "pending";

  const inboxMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.toAgent, agentId), eq(messages.status, statusFilter)))
    .orderBy(desc(messages.createdAt))
    .limit(50);

  // Resolve sender names
  const senderIds = [...new Set(inboxMessages.map(m => m.fromAgent))];
  const senderRows = senderIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(or(...senderIds.map(id => eq(agents.id, id))))
    : [];
  const nameMap = Object.fromEntries(senderRows.map(a => [a.id, a.name]));

  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Inbox — Trunk</title>
  <style>${dashboardStyles()}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <a href="/dashboard?secret=${secret}" class="logo" style="text-decoration:none;">← trunk</a>
      <div class="agent-name">Inbox (${statusFilter})</div>
    </div>

    <div style="margin-bottom:1rem;display:flex;gap:0.5rem;">
      ${["pending", "read", "replied"].map(s => html`
        <a href="/dashboard/inbox?secret=${secret}&status=${s}"
           style="padding:0.4rem 0.8rem;background:${s === statusFilter ? "#7c6aef" : "#1a1a1a"};border:1px solid ${s === statusFilter ? "#7c6aef" : "#333"};border-radius:6px;color:#fff;text-decoration:none;font-size:0.8rem;">${s}</a>
      `)}
    </div>

    ${inboxMessages.length === 0
      ? html`<div class="card"><p class="empty">No ${statusFilter} messages.</p></div>`
      : inboxMessages.map((m) => {
        const senderName = nameMap[m.fromAgent] || m.fromAgent.slice(0, 8);
        const payload = m.payload as Record<string, unknown>;
        const content = (payload.content as string) || "";
        const context = (payload.context as string) || "";

        return html`
          <div class="card" style="margin-bottom:0.75rem;">
            <div class="thread-msg-header">
              <span class="thread-sender">${senderName}</span>
              <span class="thread-type">${m.type}</span>
              <span class="thread-time">${timeAgo(m.createdAt)}</span>
              ${m.threadId ? html`<a href="/dashboard/thread/${m.threadId}?secret=${secret}" style="color:#7c6aef;text-decoration:none;font-size:0.75rem;">view thread →</a>` : ""}
            </div>
            <div class="thread-msg-body">${content}</div>
            ${context ? html`<div class="thread-msg-context">${context}</div>` : ""}
          </div>
        `;
      })}
  </div>
</body>
</html>`);
});

function timeAgo(date: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

function dashboardStyles() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      color-scheme: dark;
      --bg: #080807;
      --panel: #11110f;
      --panel-2: #171714;
      --line: #282820;
      --muted: #8d8a7d;
      --text: #f4f0e6;
      --accent: #d5ff5f;
      --accent-2: #64d2ff;
      --danger: #ff7b72;
      --good: #7ee787;
    }
    body {
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background:
        linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px),
        linear-gradient(180deg, rgba(255,255,255,0.02) 1px, transparent 1px),
        var(--bg);
      background-size: 34px 34px;
      color: var(--text);
      min-height: 100vh;
    }
    .app-shell { display: grid; grid-template-columns: 292px minmax(0, 1fr); min-height: 100vh; }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      padding: 1.25rem;
      background: #0d0d0b;
      border-right: 1px solid var(--line);
      overflow-y: auto;
    }
    .brand-block { padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
    .sidebar-section { display: grid; gap: 0.45rem; }
    .sidebar-label, .rail-title {
      color: #6f6b60;
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .sidebar-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.55rem;
      min-height: 38px;
      padding: 0.45rem 0.55rem;
      color: var(--text);
      text-decoration: none;
      border: 1px solid transparent;
      border-radius: 7px;
    }
    .sidebar-item:hover { background: #151511; border-color: var(--line); }
    .sidebar-item.room { grid-template-columns: auto minmax(0, 1fr) auto; }
    .sidebar-main { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9rem; }
    .sidebar-count {
      min-width: 1.4rem;
      padding: 0.1rem 0.35rem;
      border: 1px solid #333329;
      border-radius: 999px;
      color: var(--muted);
      text-align: center;
      font-size: 0.72rem;
    }
    .sidebar-sub { grid-column: 2 / 4; color: #646056; font-size: 0.72rem; }
    .sidebar-empty { color: #5c584e; font-size: 0.84rem; padding: 0.45rem 0.55rem; }
    .presence-dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; background: var(--good); box-shadow: 0 0 12px rgba(126, 231, 135, 0.35); }
    .room-hash { color: var(--accent-2); font-weight: 800; }
    .sidebar-footer { margin-top: auto; display: grid; gap: 0.45rem; padding-top: 1rem; border-top: 1px solid var(--line); }
    .pairing-code { color: var(--accent); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.86rem; text-decoration: none; }
    .conversation-panel { min-width: 0; display: flex; flex-direction: column; }
    .conversation-header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 1.25rem 1.5rem;
      background: rgba(8, 8, 7, 0.92);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid var(--line);
    }
    .eyebrow { color: var(--muted); font-size: 0.74rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
    h1 { font-size: clamp(1.35rem, 2vw, 2rem); line-height: 1.1; margin-top: 0.25rem; letter-spacing: 0; }
    .health-strip { display: flex; align-items: stretch; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #10100d; }
    .health-strip div { min-width: 92px; padding: 0.55rem 0.7rem; border-left: 1px solid var(--line); }
    .health-strip div:first-child { border-left: none; }
    .health-strip span { display: block; color: var(--muted); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .health-strip strong { display: block; margin-top: 0.18rem; font-size: 0.9rem; }
    .good { color: var(--good); }
    .conversation-body { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 0; min-height: 0; }
    .chat-stream { min-width: 0; padding: 1.5rem; }
    .stream-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; color: var(--muted); font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; }
    .stream-title a, .thread-link { color: var(--accent-2); text-decoration: none; }
    .chat-message {
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr);
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .avatar {
      width: 38px;
      height: 38px;
      display: grid;
      place-items: center;
      border: 1px solid #34342a;
      border-radius: 8px;
      background: #191913;
      color: var(--accent);
      font-size: 0.74rem;
      font-weight: 800;
    }
    .bubble {
      min-width: 0;
      padding: 0.85rem 0.95rem;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(18, 18, 15, 0.92);
    }
    .chat-message.mine .bubble { border-left-color: var(--accent); }
    .chat-message.theirs .bubble { border-left-color: var(--accent-2); }
    .message-heading {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.45rem;
      color: var(--muted);
      font-size: 0.74rem;
      margin-bottom: 0.5rem;
    }
    .message-heading strong { color: var(--text); font-size: 0.86rem; }
    .message-heading span:not(:first-child) {
      padding: 0.1rem 0.35rem;
      border: 1px solid #2d2d24;
      border-radius: 999px;
      color: #aaa596;
    }
    .message-heading time { margin-left: auto; color: #625e54; }
    .message-copy { color: #eee9de; font-size: 0.94rem; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
    .message-context { margin-top: 0.65rem; padding-left: 0.75rem; border-left: 2px solid #333329; color: #a7a193; font-size: 0.84rem; line-height: 1.45; }
    .context-rail {
      border-left: 1px solid var(--line);
      background: rgba(13, 13, 11, 0.72);
      padding: 1.5rem 1rem;
      display: grid;
      align-content: start;
      gap: 1rem;
    }
    .rail-section, .room-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(18, 18, 15, 0.8);
      padding: 0.9rem;
    }
    .rail-section { display: grid; gap: 0.75rem; }
    .room-title { color: var(--text); font-size: 0.92rem; font-weight: 700; }
    .room-subtitle { color: var(--muted); font-size: 0.76rem; margin-top: 0.25rem; }
    .pill-row { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.65rem; }
    .pill { border: 1px solid #333329; border-radius: 999px; padding: 0.2rem 0.45rem; color: #b7b09f; font-size: 0.72rem; }
    .task-line {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      gap: 0.5rem;
      color: #d8d2c4;
      font-size: 0.8rem;
      line-height: 1.35;
    }
    .task-status { color: var(--muted); }
    .task-status.done { color: var(--good); }
    .task-status.blocked { color: var(--danger); }
    .task-status.in-progress { color: var(--accent); }
    .thread-link {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.25rem 0.55rem;
      padding: 0.45rem 0;
      border-bottom: 1px solid #202019;
      font-size: 0.8rem;
    }
    .thread-link time { grid-column: 1 / 3; color: var(--muted); font-size: 0.72rem; }
    .container { max-width: 960px; margin: 0 auto; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2rem; }
    .logo { font-size: 1.25rem; font-weight: 700; color: #fff; }
    .agent-name { color: #999; font-size: 0.9rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .card { background: #141414; border: 1px solid #262626; border-radius: 10px; padding: 1.25rem; }
    .card.wide { grid-column: 1 / -1; }
    .card-title { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #666; margin-bottom: 1rem; }
    .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid #1a1a1a; }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: #999; font-size: 0.85rem; }
    .stat-value { color: #e5e5e5; font-size: 0.85rem; font-weight: 500; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; }
    .empty { color: #444; font-size: 0.85rem; font-style: italic; }
    .message-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid #1a1a1a; font-size: 0.8rem; }
    .message-row:last-child { border-bottom: none; }
    .msg-direction { width: 1.5rem; text-align: center; font-weight: 700; }
    .msg-direction.sent { color: #7c6aef; }
    .msg-direction.received { color: #4ade80; }
    .msg-type { color: #666; min-width: 60px; }
    .msg-content { color: #ccc; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .msg-time { color: #444; min-width: 50px; text-align: right; }
    .badge { display: inline-block; margin-left: 0.4rem; padding: 0.1rem 0.35rem; border: 1px solid #333; border-radius: 999px; color: #999; font-size: 0.65rem; text-transform: none; letter-spacing: 0; }
    .observer-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr); gap: 1rem; }
    .section-label { color: #777; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }
    .observer-message { padding: 0.75rem 0; border-bottom: 1px solid #1a1a1a; }
    .observer-message:last-child { border-bottom: none; }
    .observer-meta { display: flex; align-items: center; gap: 0.45rem; color: #888; font-size: 0.75rem; margin-bottom: 0.35rem; }
    .observer-meta .msg-time { margin-left: auto; }
    .arrow { color: #444; }
    .observer-content { color: #ddd; font-size: 0.85rem; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
    .room-observer { border: 1px solid #202020; border-radius: 8px; padding: 0.85rem; margin-bottom: 0.75rem; background: #101010; }
    .room-title { color: #f5f5f5; font-size: 0.9rem; font-weight: 600; }
    .room-subtitle { color: #666; font-size: 0.75rem; margin-top: 0.25rem; }
    .pill-row { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.65rem 0; }
    .pill { border: 1px solid #2a2a2a; border-radius: 999px; padding: 0.2rem 0.45rem; color: #aaa; font-size: 0.72rem; }
    .task-line { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 0.5rem; color: #d8d2c4; font-size: 0.8rem; line-height: 1.35; padding-top: 0.35rem; }
    .task-status { color: #888; min-width: 72px; }
    .task-status.done { color: #4ade80; }
    .task-status.blocked { color: #f87171; }
    .task-status.in-progress { color: #facc15; }
    .footer { text-align: center; margin-top: 2rem; font-size: 0.75rem; color: #444; }
    .footer a { color: #666; text-decoration: none; }
    .footer a:hover { color: #999; }
    h2 { color: #fff; font-size: 1.1rem; margin-bottom: 0.5rem; }
    .thread-msg { padding: 1rem; border-bottom: 1px solid #1a1a1a; }
    .thread-msg:last-child { border-bottom: none; }
    .thread-msg.mine { border-left: 3px solid #7c6aef; }
    .thread-msg.theirs { border-left: 3px solid #4ade80; }
    .thread-msg-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
    .thread-sender { font-weight: 600; font-size: 0.85rem; color: #fff; }
    .thread-type { font-size: 0.7rem; padding: 0.15rem 0.4rem; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 4px; color: #7c6aef; }
    .thread-finality { font-size: 0.7rem; padding: 0.15rem 0.4rem; background: #1a2e1a; border: 1px solid #2a4a2a; border-radius: 4px; color: #4ade80; }
    .thread-urgency { font-size: 0.7rem; padding: 0.15rem 0.4rem; background: #2e1a1a; border: 1px solid #4a2a2a; border-radius: 4px; color: #f87171; }
    .thread-time { font-size: 0.7rem; color: #444; margin-left: auto; }
    .thread-status { font-size: 0.65rem; color: #555; }
    .thread-msg-body { font-size: 0.9rem; line-height: 1.5; color: #ddd; white-space: pre-wrap; }
    .thread-msg-context { font-size: 0.8rem; color: #666; margin-top: 0.5rem; font-style: italic; }
    @media (max-width: 980px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--line); }
      .conversation-header { position: static; align-items: flex-start; flex-direction: column; }
      .conversation-body { grid-template-columns: 1fr; }
      .context-rail { border-left: none; border-top: 1px solid var(--line); }
    }
    @media (max-width: 760px) {
      .grid, .observer-grid { grid-template-columns: 1fr; }
      .health-strip { width: 100%; display: grid; grid-template-columns: repeat(3, 1fr); }
      .health-strip div { min-width: 0; }
      .chat-stream, .conversation-header { padding-left: 1rem; padding-right: 1rem; }
      .message-heading time { margin-left: 0; }
    }
  `;
}

export default app;
