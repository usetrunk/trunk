import { Hono } from "hono";
import { html } from "hono/html";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db } from "../db/index.js";
import { agents, contacts, messages, roomMembers, rooms, tasks, workspaceContacts, workspaces } from "../db/schema.js";
import { and, eq, or, desc, asc, inArray } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { requireValidUUIDs } from "../lib/errors.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

const COOKIE_NAME = "trunk_session";

function loginPage(error?: string) {
  return html`<!DOCTYPE html>
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
    ${error ? html`<div style="color:#ff7b72;font-size:0.85rem;margin-bottom:0.5rem;">${error}</div>` : ""}
    <form method="POST" action="/dashboard/login">
      <input type="password" name="secret" placeholder="Agent secret" required style="width:100%;margin:1rem 0;padding:0.75rem;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#fff;font-size:0.9rem;">
      <button type="submit" style="width:100%;padding:0.75rem;background:#7c6aef;border:none;border-radius:6px;color:#fff;font-weight:600;cursor:pointer;">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

// Login endpoint — validates secret, sets HTTP-only cookie, redirects to dashboard
app.post("/login", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = await checkRateLimit(`dashboard-login:${ip}`, 10, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.html(loginPage("Too many login attempts. Please try again later."), 429);
  }

  const body = await c.req.parseBody();
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (!secret) {
    return c.html(loginPage("Secret is required."), 400);
  }

  // Validate the secret by injecting it as a bearer token and running authMiddleware
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

  try {
    let authPassed = false;
    await authMiddleware(c, async () => { authPassed = true; });
    if (!authPassed) {
      return c.html(loginPage("Invalid secret."), 401);
    }
  } catch {
    return c.html(loginPage("Invalid secret."), 401);
  }

  setCookie(c, COOKIE_NAME, secret, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/dashboard",
    maxAge: 7 * 24 * 60 * 60, // 7 days
  });

  return c.redirect("/dashboard");
});

// Logout endpoint — clears cookie
app.post("/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/dashboard" });
  return c.redirect("/dashboard");
});

// Dashboard auth middleware — cookie or Authorization header
app.use("/*", async (c, next) => {
  // Try bearer token from Authorization header first (API/test access)
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authMiddleware(c, next);
  }

  // Try session cookie for browser access
  const sessionSecret = getCookie(c, COOKIE_NAME);
  if (!sessionSecret) {
    return c.html(loginPage(), 401);
  }

  // Inject the cookie secret as a bearer token for authMiddleware
  const newHeaders = new Headers(c.req.raw.headers);
  newHeaders.set("Authorization", `Bearer ${sessionSecret}`);
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

  const rateLimit = await checkRateLimit(`dashboard:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.text("Too many requests. Please try again later.", 429);
  }

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
  const transcriptMessages = recentMessages;
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
              <a class="sidebar-item" href="/dashboard">
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
              <a class="sidebar-item room" href="/dashboard/room/${room.id}">
                <span class="room-hash">#</span>
                <span class="sidebar-main">${room.name}</span>
                <span class="sidebar-count">${roomTasks.length}</span>
                <span class="sidebar-sub">${members.length} agents</span>
              </a>
            `;
          })}
      </div>
      <div class="sidebar-section">
        <div class="sidebar-label">Navigation</div>
        <a class="sidebar-item" href="/dashboard">
          <span style="font-size:0.8rem;">&#9776;</span>
          <span class="sidebar-main">Feed</span>
        </a>
        <a class="sidebar-item" href="/dashboard/inbox">
          <span style="font-size:0.8rem;">&#9993;</span>
          <span class="sidebar-main">Inbox</span>
        </a>
        <a class="sidebar-item" href="/dashboard/gantt">
          <span style="font-size:0.8rem;">&#9638;</span>
          <span class="sidebar-main">Mission Control</span>
        </a>
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
            <a href="/dashboard/inbox">Inbox</a>
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
                <a class="thread-link" href="/dashboard/thread/${tid}">
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
app.get("/thread/:threadId", requireValidUUIDs("threadId"), async (c) => {
  const agent = c.get("agent");
  const agentId = c.get("agentId");
  const threadId = c.req.param("threadId");

  const rateLimit = await checkRateLimit(`dashboard:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.text("Too many requests. Please try again later.", 429);
  }

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
      <a href="/dashboard" class="logo" style="text-decoration:none;">← trunk</a>
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
  const VALID_STATUSES = ["pending", "delivered", "processed", "replied"];
  const statusFilter = c.req.query("status") || "pending";
  if (!VALID_STATUSES.includes(statusFilter)) {
    return c.text("Invalid status filter", 400);
  }

  const rateLimit = await checkRateLimit(`dashboard:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.text("Too many requests. Please try again later.", 429);
  }

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
      <a href="/dashboard" class="logo" style="text-decoration:none;">← trunk</a>
      <div class="agent-name">Inbox (${statusFilter})</div>
    </div>

    <div style="margin-bottom:1rem;display:flex;gap:0.5rem;">
      ${["pending", "read", "replied"].map(s => html`
        <a href="/dashboard/inbox&status=${s}"
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
              ${m.threadId ? html`<a href="/dashboard/thread/${m.threadId}" style="color:#7c6aef;text-decoration:none;font-size:0.75rem;">view thread →</a>` : ""}
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

// Room detail view — messages, tasks, gantt for a single room
app.get("/room/:roomId", requireValidUUIDs("roomId"), async (c) => {
  const agent = c.get("agent");
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  const rateLimit = await checkRateLimit(`dashboard:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.text("Too many requests. Please try again later.", 429);
  }

  // Verify membership
  const membership = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);
  if (membership.length === 0) {
    return c.text("Not a member of this room", 403);
  }

  // Room info
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) return c.text("Room not found", 404);

  // Members
  const members = await db.select().from(roomMembers).where(eq(roomMembers.roomId, roomId));

  // Room messages (newest first)
  const roomMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.toRoom, roomId))
    .orderBy(desc(messages.createdAt))
    .limit(50);

  // Room tasks
  const roomTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.scope, `room:${roomId}`))
    .orderBy(tasks.sequence, tasks.createdAt);

  // Resolve all agent names
  const allAgentIds = unique([
    agentId,
    ...members.map(m => m.agentId),
    ...roomMessages.flatMap(m => [m.fromAgent, m.toAgent]),
    ...roomTasks.map(t => t.owner).filter(Boolean) as string[],
    ...roomTasks.map(t => t.createdBy).filter(Boolean) as string[],
  ]);
  const agentRows = allAgentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(or(...allAgentIds.map(id => eq(agents.id, id))))
    : [];
  const nameMap = new Map(agentRows.map(a => [a.id, a.name]));

  // Task stats
  const totalTasks = roomTasks.length;
  const doneTasks = roomTasks.filter(t => t.status === "done").length;
  const inProgressTasks = roomTasks.filter(t => t.status === "in-progress").length;
  const blockedTasks = roomTasks.filter(t => t.status === "blocked").length;
  const openTasks = roomTasks.filter(t => t.status === "open").length;
  const overallProgress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const doneIds = new Set(roomTasks.filter(t => t.status === "done").map(t => t.id));

  // Group tasks by module
  type TaskRow = typeof roomTasks[0];
  const groupMap = new Map<string, TaskRow[]>();
  const ungrouped: TaskRow[] = [];
  for (const t of roomTasks) {
    if (t.group) {
      if (!groupMap.has(t.group)) groupMap.set(t.group, []);
      groupMap.get(t.group)!.push(t);
    } else {
      ungrouped.push(t);
    }
  }

  function statusIcon(status: string) {
    switch (status) {
      case "done": return "✓";
      case "in-progress": return "▶";
      case "blocked": return "✕";
      default: return "○";
    }
  }

  function statusClass(status: string) {
    switch (status) {
      case "done": return "st-done";
      case "in-progress": return "st-active";
      case "blocked": return "st-blocked";
      default: return "st-open";
    }
  }

  // Get all rooms + their member/task counts for sidebar
  const allMemberships = await db.select().from(roomMembers).where(eq(roomMembers.agentId, agentId));
  const allRoomIds = allMemberships.map(m => m.roomId);
  const allRooms = allRoomIds.length > 0
    ? await db.select().from(rooms).where(or(...allRoomIds.map(id => eq(rooms.id, id))))
    : [];
  const allRoomMembers = allRoomIds.length > 0
    ? await db.select().from(roomMembers).where(or(...allRoomIds.map(id => eq(roomMembers.roomId, id))))
    : [];
  const allRoomTasks = allRoomIds.length > 0
    ? await db.select().from(tasks).where(or(...allRoomIds.map(id => eq(tasks.scope, `room:${id}`))))
    : [];

  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${room.name} — Trunk</title>
  <style>${dashboardStyles()}</style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand-block">
        <a href="/dashboard" class="logo" style="text-decoration:none;color:#fff;">trunk</a>
        <div class="agent-name">${agent.name}</div>
      </div>
      <div class="sidebar-section">
        <div class="sidebar-label">Rooms</div>
        ${allRooms.map((r) => {
          const mCount = allRoomMembers.filter(m => m.roomId === r.id).length;
          const tCount = allRoomTasks.filter(t => t.scope === `room:${r.id}` && t.status !== "done").length;
          const isActive = r.id === roomId;
          return html`
            <a class="sidebar-item room" href="/dashboard/room/${r.id}" style="${isActive ? "background:#151511;border-color:var(--line);" : ""}">
              <span class="room-hash">#</span>
              <span class="sidebar-main">${r.name}</span>
              <span class="sidebar-count">${tCount}</span>
              <span class="sidebar-sub">${mCount} agents</span>
            </a>
          `;
        })}
      </div>
      <div class="sidebar-section">
        <div class="sidebar-label">Navigation</div>
        <a class="sidebar-item" href="/dashboard">
          <span style="font-size:0.8rem;">&#9776;</span>
          <span class="sidebar-main">Feed</span>
        </a>
        <a class="sidebar-item" href="/dashboard/inbox">
          <span style="font-size:0.8rem;">&#9993;</span>
          <span class="sidebar-main">Inbox</span>
        </a>
        <a class="sidebar-item" href="/dashboard/gantt">
          <span style="font-size:0.8rem;">&#9638;</span>
          <span class="sidebar-main">Mission Control</span>
        </a>
      </div>
    </aside>

    <main class="conversation-panel">
      <header class="conversation-header">
        <div>
          <div class="eyebrow">Room</div>
          <h1># ${room.name}</h1>
        </div>
        <div class="health-strip">
          <div><span>Members</span><strong>${members.length}</strong></div>
          <div><span>Messages</span><strong>${roomMessages.length}</strong></div>
          <div><span>Tasks</span><strong>${totalTasks}</strong></div>
          <div><span>Progress</span><strong class="good">${overallProgress}%</strong></div>
        </div>
      </header>

      <section class="conversation-body">
        <div class="chat-stream">
          <!-- Members -->
          <div class="stream-title"><span>Members</span></div>
          <div class="pill-row" style="margin-bottom:1.5rem;">
            ${members.map(m => html`<span class="pill">${nameMap.get(m.agentId) ?? m.agentId.slice(0, 8)} <span style="color:#6f6b60;font-size:0.65rem;">${m.role}</span></span>`)}
          </div>

          <!-- Messages -->
          <div class="stream-title"><span>Messages</span></div>
          ${roomMessages.length === 0
            ? html`<p class="empty">No messages in this room yet.</p>`
            : roomMessages.map((m) => {
              const from = nameMap.get(m.fromAgent) ?? m.fromAgent.slice(0, 8);
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

          <!-- Tasks gantt -->
          <div class="stream-title" style="margin-top:2rem;"><span>Tasks</span><span style="color:var(--muted);font-size:0.72rem;">${doneTasks}/${totalTasks} done</span></div>
          ${totalTasks === 0
            ? html`<p class="empty">No tasks in this room yet.</p>`
            : html`
              <div style="margin-bottom:0.75rem;">
                <div style="display:flex;gap:0.75rem;font-size:0.75rem;margin-bottom:0.5rem;">
                  ${inProgressTasks > 0 ? html`<span style="color:var(--accent);">${inProgressTasks} active</span>` : ""}
                  ${blockedTasks > 0 ? html`<span style="color:var(--danger);">${blockedTasks} blocked</span>` : ""}
                  ${openTasks > 0 ? html`<span style="color:var(--muted);">${openTasks} queued</span>` : ""}
                  ${doneTasks > 0 ? html`<span style="color:var(--good);">${doneTasks} done</span>` : ""}
                </div>
                <div style="height:4px;background:#1a1a18;border-radius:2px;overflow:hidden;margin-bottom:1rem;">
                  <div style="height:100%;width:${overallProgress}%;background:var(--good);border-radius:2px;"></div>
                </div>
              </div>
              ${Array.from(groupMap.entries()).map(([name, moduleTasks]) => {
                const mDone = moduleTasks.filter(t => t.status === "done").length;
                const mTotal = moduleTasks.length;
                const mPct = mTotal > 0 ? Math.round((mDone / mTotal) * 100) : 0;
                const statusOrder: Record<string, number> = { "in-progress": 0, "blocked": 1, "open": 2, "done": 3 };
                const sorted = [...moduleTasks].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));
                return html`
                  <div style="border:1px solid var(--line);border-radius:8px;background:rgba(18,18,15,0.92);margin-bottom:0.75rem;overflow:hidden;">
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.85rem;border-bottom:1px solid var(--line);background:var(--panel);">
                      <span style="font-size:0.82rem;font-weight:700;color:var(--accent-2);text-transform:uppercase;letter-spacing:0.04em;">${name}</span>
                      <span style="font-size:0.72rem;color:var(--muted);">${mPct}%</span>
                    </div>
                    ${sorted.map(t => {
                      const deps = (t.dependsOn as string[]) || [];
                      const blockedBy = deps.filter(d => !doneIds.has(d));
                      const owner = t.owner ? (nameMap.get(t.owner) || t.owner.slice(0, 8)) : null;
                      const pri = t.priority === "critical" ? "!!!" : t.priority === "high" ? "!!" : "";
                      return html`
                        <div style="padding:0.45rem 0.85rem;border-bottom:1px solid #1a1a18;">
                          <div style="display:flex;align-items:center;gap:0.4rem;">
                            <span style="font-size:0.72rem;min-width:1rem;color:${t.status === "done" ? "var(--good)" : t.status === "in-progress" ? "var(--accent)" : t.status === "blocked" ? "var(--danger)" : "var(--muted)"};">${statusIcon(t.status)}</span>
                            <span style="font-size:0.82rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${t.status === "done" ? "color:var(--muted);text-decoration:line-through;" : ""}">${t.title}</span>
                            ${pri ? html`<span style="font-size:0.65rem;color:var(--danger);font-weight:700;">${pri}</span>` : ""}
                          </div>
                          <div style="display:flex;gap:0.5rem;font-size:0.7rem;color:#6f6b60;padding-left:1.4rem;margin-top:0.1rem;">
                            ${owner ? html`<span style="color:#a7a193;">${owner}</span>` : ""}
                            ${blockedBy.length > 0 ? html`<span style="color:var(--danger);">blocked by ${blockedBy.length}</span>` : ""}
                            <span style="margin-left:auto;">${timeAgo(t.updatedAt)}</span>
                          </div>
                        </div>
                      `;
                    })}
                  </div>
                `;
              })}
              ${ungrouped.length > 0 ? html`
                <div style="border:1px solid var(--line);border-radius:8px;background:rgba(18,18,15,0.92);margin-bottom:0.75rem;overflow:hidden;">
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.85rem;border-bottom:1px solid var(--line);background:var(--panel);">
                    <span style="font-size:0.82rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;">ungrouped</span>
                  </div>
                  ${ungrouped.map(t => {
                    const deps = (t.dependsOn as string[]) || [];
                    const blockedBy = deps.filter(d => !doneIds.has(d));
                    const owner = t.owner ? (nameMap.get(t.owner) || t.owner.slice(0, 8)) : null;
                    return html`
                      <div style="padding:0.45rem 0.85rem;border-bottom:1px solid #1a1a18;">
                        <div style="display:flex;align-items:center;gap:0.4rem;">
                          <span style="font-size:0.72rem;min-width:1rem;color:${t.status === "done" ? "var(--good)" : t.status === "in-progress" ? "var(--accent)" : t.status === "blocked" ? "var(--danger)" : "var(--muted)"};">${statusIcon(t.status)}</span>
                          <span style="font-size:0.82rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${t.status === "done" ? "color:var(--muted);text-decoration:line-through;" : ""}">${t.title}</span>
                        </div>
                        <div style="display:flex;gap:0.5rem;font-size:0.7rem;color:#6f6b60;padding-left:1.4rem;margin-top:0.1rem;">
                          ${owner ? html`<span style="color:#a7a193;">${owner}</span>` : ""}
                          ${blockedBy.length > 0 ? html`<span style="color:var(--danger);">blocked by ${blockedBy.length}</span>` : ""}
                          <span style="margin-left:auto;">${timeAgo(t.updatedAt)}</span>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              ` : ""}
            `}
        </div>

        <aside class="context-rail">
          <section class="rail-section">
            <div class="rail-title">Room info</div>
            <div style="font-size:0.82rem;color:var(--muted);">Created ${timeAgo(room.createdAt)}</div>
            <div style="font-size:0.82rem;color:var(--muted);">Pairing code: <span class="mono" style="color:var(--accent);">${room.pairingCode}</span></div>
          </section>

          <section class="rail-section">
            <div class="rail-title">Blocked tasks</div>
            ${roomTasks.filter(t => t.status === "blocked").length === 0
              ? html`<div style="color:var(--good);font-size:0.8rem;">Nothing blocked</div>`
              : roomTasks.filter(t => t.status === "blocked").map(t => {
                const deps = (t.dependsOn as string[]) || [];
                const waitingOn = deps.filter(d => !doneIds.has(d));
                const waitingNames = waitingOn.map(d => {
                  const dep = roomTasks.find(x => x.id === d);
                  return dep ? dep.title : d.slice(0, 8);
                });
                return html`
                  <div style="font-size:0.78rem;padding:0.35rem 0;border-bottom:1px solid #1a1a18;">
                    <div style="color:var(--danger);">✕ ${t.title}</div>
                    <div style="color:#6f6b60;font-size:0.7rem;margin-top:0.15rem;">waiting on: ${waitingNames.join(", ")}</div>
                  </div>
                `;
              })}
          </section>

          <section class="rail-section">
            <div class="rail-title">Recent completions</div>
            ${roomTasks.filter(t => t.status === "done").length === 0
              ? html`<div style="color:var(--muted);font-size:0.8rem;">Nothing completed yet</div>`
              : roomTasks.filter(t => t.status === "done")
                  .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
                  .slice(0, 8)
                  .map(t => {
                    const owner = t.owner ? (nameMap.get(t.owner) || t.owner.slice(0, 8)) : "unknown";
                    return html`
                      <div style="font-size:0.78rem;padding:0.35rem 0;border-bottom:1px solid #1a1a18;display:flex;gap:0.4rem;">
                        <span style="color:var(--good);">✓</span>
                        <span style="flex:1;">${t.title}</span>
                        <span style="color:#4a4840;font-size:0.7rem;">${timeAgo(t.updatedAt)}</span>
                      </div>
                    `;
                  })}
          </section>
        </aside>
      </section>
    </main>
  </div>
</body>
</html>`);
});

// Mission control — real-time agent work dashboard
app.get("/gantt", async (c) => {
  const agent = c.get("agent");
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`dashboard:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.text("Too many requests. Please try again later.", 429);
  }

  // Find workspaces this agent belongs to
  const wsMemberships = await db
    .select()
    .from(workspaceContacts)
    .where(eq(workspaceContacts.agentId, agentId));

  const wsIds = wsMemberships.map(m => m.workspaceId);

  // Get all workspace-scoped tasks
  const allTasks = wsIds.length > 0
    ? await db
        .select()
        .from(tasks)
        .where(or(...wsIds.map(id => eq(tasks.scope, `workspace:${id}`))))
        .orderBy(tasks.sequence, tasks.createdAt)
    : [];

  // Also get room-scoped tasks
  const membershipRows = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.agentId, agentId));
  const roomIds = membershipRows.map(m => m.roomId);
  const roomTasks = roomIds.length > 0
    ? await db
        .select()
        .from(tasks)
        .where(or(...roomIds.map(id => eq(tasks.scope, `room:${id}`))))
        .orderBy(tasks.sequence, tasks.createdAt)
    : [];

  const roomRows = roomIds.length > 0
    ? await db.select().from(rooms).where(or(...roomIds.map(id => eq(rooms.id, id))))
    : [];
  const roomNameMap = new Map(roomRows.map(r => [r.id, r.name]));

  // Merge all tasks
  const taskMap = new Map<string, typeof allTasks[0]>();
  for (const t of [...allTasks, ...roomTasks]) taskMap.set(t.id, t);
  const mergedTasks = [...taskMap.values()];

  // Resolve owner names
  const ownerIds = [...new Set(mergedTasks.map(t => t.owner).filter(Boolean))] as string[];
  const ownerRows = ownerIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(or(...ownerIds.map(id => eq(agents.id, id))))
    : [];
  const ownerNames = new Map(ownerRows.map(a => [a.id, a.name]));

  // Resolve creator names too
  const creatorIds = [...new Set(mergedTasks.map(t => t.createdBy).filter(Boolean))] as string[];
  const allAgentIds = [...new Set([...ownerIds, ...creatorIds])];
  const allAgentRows = allAgentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(or(...allAgentIds.map(id => eq(agents.id, id))))
    : [];
  const agentNameMap = new Map(allAgentRows.map(a => [a.id, a.name]));

  const doneIds = new Set(mergedTasks.filter(t => t.status === "done").map(t => t.id));

  // Group tasks by module
  type TaskRow = typeof mergedTasks[0];
  const groupMap = new Map<string, TaskRow[]>();
  const ungrouped: TaskRow[] = [];
  for (const t of mergedTasks) {
    if (t.group) {
      if (!groupMap.has(t.group)) groupMap.set(t.group, []);
      groupMap.get(t.group)!.push(t);
    } else {
      ungrouped.push(t);
    }
  }

  // Summary stats
  const totalTasks = mergedTasks.length;
  const doneTasks = mergedTasks.filter(t => t.status === "done").length;
  const inProgressTasks = mergedTasks.filter(t => t.status === "in-progress").length;
  const blockedTasks = mergedTasks.filter(t => t.status === "blocked").length;
  const openTasks = mergedTasks.filter(t => t.status === "open").length;
  const overallProgress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  // Recently completed (last 24h)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentlyDone = mergedTasks
    .filter(t => t.status === "done" && t.updatedAt > oneDayAgo)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  // Agent workload
  const agentWork = new Map<string, { active: number; done: number; blocked: number }>();
  for (const t of mergedTasks) {
    const ownerId = t.owner || "unassigned";
    if (!agentWork.has(ownerId)) agentWork.set(ownerId, { active: 0, done: 0, blocked: 0 });
    const w = agentWork.get(ownerId)!;
    if (t.status === "in-progress") w.active++;
    else if (t.status === "done") w.done++;
    else if (t.status === "blocked") w.blocked++;
  }

  function statusIcon(status: string) {
    switch (status) {
      case "done": return "✓";
      case "in-progress": return "▶";
      case "blocked": return "✕";
      default: return "○";
    }
  }

  function statusClass(status: string) {
    switch (status) {
      case "done": return "st-done";
      case "in-progress": return "st-active";
      case "blocked": return "st-blocked";
      default: return "st-open";
    }
  }

  function renderTask(t: TaskRow) {
    const deps = (t.dependsOn as string[]) || [];
    const blockedBy = deps.filter(d => !doneIds.has(d));
    const owner = t.owner ? (agentNameMap.get(t.owner) || t.owner.slice(0, 8)) : null;
    const pri = t.priority === "critical" ? "!!!" : t.priority === "high" ? "!!" : "";

    return html`
      <div class="mc-task ${statusClass(t.status)}">
        <div class="mc-task-head">
          <span class="mc-icon">${statusIcon(t.status)}</span>
          <span class="mc-task-title" title="${t.title}">${t.title}</span>
          ${pri ? html`<span class="mc-pri">${pri}</span>` : ""}
        </div>
        <div class="mc-task-meta">
          ${owner ? html`<span class="mc-owner">${owner}</span>` : html`<span class="mc-unassigned">unassigned</span>`}
          ${blockedBy.length > 0 ? html`<span class="mc-dep-blocked">blocked by ${blockedBy.length}</span>` : ""}
          ${deps.length > 0 && blockedBy.length === 0 ? html`<span class="mc-dep-met">deps met</span>` : ""}
          <span class="mc-age">${timeAgo(t.updatedAt)}</span>
        </div>
      </div>
    `;
  }

  function renderModule(name: string, moduleTasks: TaskRow[]) {
    const done = moduleTasks.filter(t => t.status === "done").length;
    const active = moduleTasks.filter(t => t.status === "in-progress").length;
    const blocked = moduleTasks.filter(t => t.status === "blocked").length;
    const open = moduleTasks.filter(t => t.status === "open").length;
    const total = moduleTasks.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    // Sort: in-progress first, then blocked, then open, then done
    const statusOrder: Record<string, number> = { "in-progress": 0, "blocked": 1, "open": 2, "done": 3 };
    const sorted = [...moduleTasks].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

    return html`
      <div class="mc-module">
        <div class="mc-module-head">
          <div class="mc-module-info">
            <span class="mc-module-name">${name}</span>
            <div class="mc-module-counts">
              ${active > 0 ? html`<span class="mc-count st-active">${active} active</span>` : ""}
              ${blocked > 0 ? html`<span class="mc-count st-blocked">${blocked} blocked</span>` : ""}
              ${open > 0 ? html`<span class="mc-count st-open">${open} open</span>` : ""}
              ${done > 0 ? html`<span class="mc-count st-done">${done} done</span>` : ""}
            </div>
          </div>
          <div class="mc-module-progress">
            <div class="mc-bar"><div class="mc-bar-fill" style="width:${pct}%"></div></div>
            <span class="mc-pct">${pct}%</span>
          </div>
        </div>
        <div class="mc-task-list">
          ${sorted.map(t => renderTask(t))}
        </div>
      </div>
    `;
  }

  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mission Control — Trunk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      color-scheme: dark;
      --bg: #080807;
      --panel: #0d0d0b;
      --card: #121210;
      --line: #282820;
      --muted: #8d8a7d;
      --text: #f4f0e6;
      --accent: #d5ff5f;
      --accent-2: #64d2ff;
      --danger: #ff7b72;
      --good: #7ee787;
      --warn: #f0c040;
    }
    body {
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }

    .mc-shell { max-width: 1400px; margin: 0 auto; padding: 1.5rem; }

    /* Header */
    .mc-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--line);
    }
    .mc-header-left { display: flex; align-items: center; gap: 1rem; }
    .mc-header-left a { color: var(--accent-2); text-decoration: none; font-size: 0.85rem; }
    .mc-header-left h1 { font-size: 1.4rem; letter-spacing: -0.02em; }
    .mc-live { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.72rem; color: var(--good); }
    .mc-live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--good); box-shadow: 0 0 8px rgba(126,231,135,0.5); }

    /* Stats strip */
    .mc-stats {
      display: flex; gap: 0.75rem; align-items: stretch;
      border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--panel);
    }
    .mc-stat {
      padding: 0.6rem 1rem; border-left: 1px solid var(--line); text-align: center; min-width: 80px;
    }
    .mc-stat:first-child { border-left: none; }
    .mc-stat-val { font-size: 1.3rem; font-weight: 700; }
    .mc-stat-lbl { font-size: 0.65rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 0.1rem; }

    /* Overall progress */
    .mc-overall { padding: 0.6rem 1rem; display: flex; flex-direction: column; justify-content: center; gap: 0.3rem; min-width: 140px; }
    .mc-overall-bar { height: 6px; background: #1a1a18; border-radius: 3px; overflow: hidden; }
    .mc-overall-fill { height: 100%; background: var(--good); border-radius: 3px; transition: width 0.5s; }

    /* Layout: modules + sidebar */
    .mc-body { display: grid; grid-template-columns: 1fr 320px; gap: 1.25rem; margin-top: 1.25rem; }

    /* Module cards */
    .mc-modules { display: grid; gap: 1rem; align-content: start; }
    .mc-module { border: 1px solid var(--line); border-radius: 10px; background: var(--card); overflow: hidden; }
    .mc-module-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); background: var(--panel);
    }
    .mc-module-info { display: flex; flex-direction: column; gap: 0.25rem; }
    .mc-module-name { font-size: 0.9rem; font-weight: 700; color: var(--accent-2); text-transform: uppercase; letter-spacing: 0.04em; }
    .mc-module-counts { display: flex; gap: 0.4rem; }
    .mc-count { font-size: 0.68rem; padding: 0.1rem 0.35rem; border-radius: 4px; }
    .mc-count.st-active { color: var(--accent); border: 1px solid rgba(213,255,95,0.2); }
    .mc-count.st-blocked { color: var(--danger); border: 1px solid rgba(255,123,114,0.2); }
    .mc-count.st-open { color: var(--muted); border: 1px solid rgba(141,138,125,0.2); }
    .mc-count.st-done { color: var(--good); border: 1px solid rgba(126,231,135,0.2); }
    .mc-module-progress { display: flex; align-items: center; gap: 0.5rem; }
    .mc-bar { width: 80px; height: 4px; background: #1a1a18; border-radius: 2px; overflow: hidden; }
    .mc-bar-fill { height: 100%; background: var(--good); border-radius: 2px; transition: width 0.5s; }
    .mc-pct { font-size: 0.75rem; color: var(--muted); min-width: 2.5rem; text-align: right; }

    /* Task list */
    .mc-task-list { padding: 0.25rem 0; }
    .mc-task {
      padding: 0.5rem 1rem; border-bottom: 1px solid #1a1a18;
      transition: background 0.15s;
    }
    .mc-task:last-child { border-bottom: none; }
    .mc-task:hover { background: rgba(255,255,255,0.02); }
    .mc-task-head { display: flex; align-items: center; gap: 0.4rem; }
    .mc-icon { font-size: 0.72rem; min-width: 1rem; }
    .st-done .mc-icon { color: var(--good); }
    .st-active .mc-icon { color: var(--accent); }
    .st-blocked .mc-icon { color: var(--danger); }
    .st-open .mc-icon { color: var(--muted); }
    .mc-task-title {
      font-size: 0.82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;
    }
    .st-done .mc-task-title { color: var(--muted); text-decoration: line-through; text-decoration-color: #444; }
    .mc-pri { font-size: 0.65rem; color: var(--danger); font-weight: 700; }
    .mc-task-meta { display: flex; gap: 0.5rem; font-size: 0.7rem; color: #6f6b60; margin-top: 0.15rem; padding-left: 1.4rem; }
    .mc-owner { color: #a7a193; }
    .mc-unassigned { color: var(--warn); font-style: italic; }
    .mc-dep-blocked { color: var(--danger); }
    .mc-dep-met { color: var(--good); }
    .mc-age { margin-left: auto; }

    /* Sidebar */
    .mc-sidebar { display: grid; gap: 1rem; align-content: start; }
    .mc-panel {
      border: 1px solid var(--line); border-radius: 10px; background: var(--card);
      padding: 0.85rem 1rem; display: grid; gap: 0.6rem;
    }
    .mc-panel-title {
      font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #6f6b60;
    }

    /* Agent workload */
    .mc-agent-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; }
    .mc-agent-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mc-agent-stat { font-size: 0.72rem; min-width: 1.2rem; text-align: center; }

    /* Activity feed */
    .mc-feed-item {
      display: flex; align-items: flex-start; gap: 0.5rem;
      padding: 0.35rem 0; border-bottom: 1px solid #1a1a18; font-size: 0.8rem;
    }
    .mc-feed-item:last-child { border-bottom: none; }
    .mc-feed-icon { color: var(--good); font-size: 0.72rem; margin-top: 0.15rem; }
    .mc-feed-text { flex: 1; color: #d8d2c4; line-height: 1.3; }
    .mc-feed-text .agent { color: var(--accent-2); }
    .mc-feed-text .group { color: var(--accent); }
    .mc-feed-time { font-size: 0.7rem; color: #4a4840; white-space: nowrap; }

    .mc-empty { color: var(--muted); font-size: 0.85rem; font-style: italic; text-align: center; padding: 2rem; }

    @media (max-width: 900px) {
      .mc-body { grid-template-columns: 1fr; }
      .mc-header { flex-direction: column; align-items: flex-start; gap: 1rem; }
    }
  </style>
  <script>setTimeout(() => location.reload(), 10000);</script>
</head>
<body>
  <div class="mc-shell">
    <div class="mc-header">
      <div class="mc-header-left">
        <a href="/dashboard">← dashboard</a>
        <h1>Mission control</h1>
        <span class="mc-live">live</span>
      </div>
      <div class="mc-stats">
        <div class="mc-stat">
          <div class="mc-stat-val" style="color:var(--accent)">${inProgressTasks}</div>
          <div class="mc-stat-lbl">active</div>
        </div>
        <div class="mc-stat">
          <div class="mc-stat-val" style="color:var(--danger)">${blockedTasks}</div>
          <div class="mc-stat-lbl">blocked</div>
        </div>
        <div class="mc-stat">
          <div class="mc-stat-val">${openTasks}</div>
          <div class="mc-stat-lbl">queued</div>
        </div>
        <div class="mc-stat">
          <div class="mc-stat-val" style="color:var(--good)">${doneTasks}</div>
          <div class="mc-stat-lbl">done</div>
        </div>
        <div class="mc-overall">
          <div class="mc-overall-bar"><div class="mc-overall-fill" style="width:${overallProgress}%"></div></div>
          <div class="mc-stat-lbl">${overallProgress}% of ${totalTasks} tasks</div>
        </div>
      </div>
    </div>

    ${totalTasks === 0
      ? html`<div class="mc-empty">No tasks yet. Create workspace or room tasks to see them here.</div>`
      : html`
        <div class="mc-body">
          <div class="mc-modules">
            ${Array.from(groupMap.entries()).map(([name, moduleTasks]) => renderModule(name, moduleTasks))}
            ${ungrouped.length > 0 ? renderModule("ungrouped", ungrouped) : ""}
          </div>

          <div class="mc-sidebar">
            <div class="mc-panel">
              <div class="mc-panel-title">Agent workload</div>
              ${agentWork.size === 0
                ? html`<div style="color:var(--muted);font-size:0.8rem;">No assigned tasks</div>`
                : Array.from(agentWork.entries()).map(([id, w]) => {
                  const name = id === "unassigned" ? "unassigned" : (agentNameMap.get(id) || id.slice(0, 8));
                  return html`
                    <div class="mc-agent-row">
                      <span class="mc-agent-name">${name}</span>
                      ${w.active > 0 ? html`<span class="mc-agent-stat" style="color:var(--accent)">${w.active}</span>` : ""}
                      ${w.blocked > 0 ? html`<span class="mc-agent-stat" style="color:var(--danger)">${w.blocked}</span>` : ""}
                      <span class="mc-agent-stat" style="color:var(--good)">${w.done}</span>
                    </div>
                  `;
                })}
            </div>

            <div class="mc-panel">
              <div class="mc-panel-title">Recently completed</div>
              ${recentlyDone.length === 0
                ? html`<div style="color:var(--muted);font-size:0.8rem;">Nothing in the last 24h</div>`
                : recentlyDone.slice(0, 10).map(t => {
                  const owner = t.owner ? (agentNameMap.get(t.owner) || t.owner.slice(0, 8)) : "unknown";
                  return html`
                    <div class="mc-feed-item">
                      <span class="mc-feed-icon">✓</span>
                      <div class="mc-feed-text">
                        <span class="agent">${owner}</span> finished
                        ${t.title}
                        ${t.group ? html` <span class="group">${t.group}</span>` : ""}
                      </div>
                      <span class="mc-feed-time">${timeAgo(t.updatedAt)}</span>
                    </div>
                  `;
                })}
            </div>

            <div class="mc-panel">
              <div class="mc-panel-title">Blocked tasks</div>
              ${blockedTasks === 0
                ? html`<div style="color:var(--good);font-size:0.8rem;">Nothing blocked</div>`
                : mergedTasks.filter(t => t.status === "blocked").slice(0, 8).map(t => {
                  const deps = (t.dependsOn as string[]) || [];
                  const waitingOn = deps.filter(d => !doneIds.has(d));
                  const waitingNames = waitingOn.map(d => {
                    const dep = mergedTasks.find(x => x.id === d);
                    return dep ? dep.title : d.slice(0, 8);
                  });
                  return html`
                    <div class="mc-feed-item">
                      <span class="mc-feed-icon" style="color:var(--danger)">✕</span>
                      <div class="mc-feed-text" style="font-size:0.78rem;">
                        ${t.title}
                        <div style="color:#6f6b60;font-size:0.7rem;margin-top:0.15rem;">waiting on: ${waitingNames.join(", ")}</div>
                      </div>
                    </div>
                  `;
                })}
            </div>
          </div>
        </div>
      `}
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
