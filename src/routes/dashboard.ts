import { Hono } from "hono";
import { html, raw } from "hono/html";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db } from "../db/index.js";
import { agents, contacts, messages, roomMembers, rooms, tasks, workspaceContacts } from "../db/schema.js";
import { and, eq, or, desc, inArray } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import { requireValidUUIDs } from "../lib/errors.js";
import type { AgentVariables } from "../lib/types.js";
import {
  loadSidebarData,
  renderSidebar,
  renderTopbar,
  emptyState,
  sectionLabel,
  messageBubble,
  typePill,
  finalityPill,
  urgencyPill,
  taskRow,
  moduleCard,
  documentShell,
  dashboardStyles,
  timeAgo,
  unique,
  initials,
  statusIcon,
  statusTone,
  type SidebarData,
} from "../lib/dashboard-ui.js";

const app = new Hono<AgentVariables>();

const COOKIE_NAME = "trunk_session";
const VALID_STATUSES = ["pending", "delivered", "processed", "replied"];

function loginPage(error?: string) {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trunk Dashboard</title>
  <style>${raw(dashboardStyles())}</style>
</head>
<body>
  <div class="login-shell">
    <form method="POST" action="/dashboard/login" class="login-card">
      <div class="login-brand">trunk</div>
      <h2>Sign in</h2>
      <p class="login-sub">Enter your agent secret to view the coordination dashboard.</p>
      ${error ? html`<div class="login-error">${error}</div>` : ""}
      <label class="login-field">
        <span class="login-label">Agent secret</span>
        <input type="password" name="secret" placeholder="Bearer token" autocomplete="current-password" required>
      </label>
      <button type="submit" class="login-submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

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
    maxAge: 7 * 24 * 60 * 60,
  });

  return c.redirect("/dashboard");
});

app.post("/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/dashboard" });
  return c.redirect("/dashboard");
});

app.use("/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authMiddleware(c, next);
  }

  const sessionSecret = getCookie(c, COOKIE_NAME);
  if (!sessionSecret) {
    return c.html(loginPage(), 401);
  }

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

  const contactRows = await db
    .select()
    .from(contacts)
    .where(or(eq(contacts.agentA, agentId), eq(contacts.agentB, agentId)))
    .limit(500);

  const contactIds = contactRows.map((r) => (r.agentA === agentId ? r.agentB : r.agentA));

  const memberships = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.agentId, agentId))
    .limit(200);
  const roomIds = memberships.map((m) => m.roomId);
  const roomRows = roomIds.length > 0
    ? await db.select().from(rooms).where(inArray(rooms.id, roomIds)).limit(200)
    : [];
  const memberRows = roomIds.length > 0
    ? await db.select().from(roomMembers).where(inArray(roomMembers.roomId, roomIds)).limit(2000)
    : [];
  const roomTaskRows = roomIds.length > 0
    ? await db
        .select()
        .from(tasks)
        .where(inArray(tasks.scope, roomIds.map((id) => `room:${id}`)))
        .orderBy(desc(tasks.createdAt))
        .limit(500)
    : [];

  const recentMessages = await db
    .select()
    .from(messages)
    .where(or(eq(messages.toAgent, agentId), eq(messages.fromAgent, agentId)))
    .orderBy(desc(messages.createdAt))
    .limit(20);

  const visibleAgentIds = unique([
    agentId,
    ...contactIds,
    ...memberRows.map((m) => m.agentId),
    ...recentMessages.flatMap((m) => [m.fromAgent, m.toAgent]),
  ]);
  const visibleAgents = visibleAgentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name, owner: agents.owner })
        .from(agents)
        .where(inArray(agents.id, visibleAgentIds))
    : [];
  const agentNames = new Map(visibleAgents.map((a) => [a.id, a.name]));
  const contactAgents = contactIds.map((id) => ({
    id,
    name: agentNames.get(id) ?? id,
    owner: visibleAgents.find((a) => a.id === id)?.owner ?? null,
  }));

  const pendingCount = recentMessages.filter((m) => m.toAgent === agentId && m.status === "pending").length;

  const threads = new Map<string, { count: number; lastActivity: Date; participants: Set<string> }>();
  for (const m of recentMessages) {
    const tid = m.threadId || m.id;
    if (!threads.has(tid)) threads.set(tid, { count: 0, lastActivity: m.createdAt, participants: new Set() });
    const t = threads.get(tid)!;
    t.count++;
    t.participants.add(m.fromAgent);
    if (m.createdAt > t.lastActivity) t.lastActivity = m.createdAt;
  }

  const openRoomTasks = roomTaskRows.filter((t) => t.status !== "done");

  const sidebarData: SidebarData = {
    agentName: agent.name,
    pairingCode: agent.pairingCode,
    contacts: contactAgents.map((ca) => ({
      id: ca.id,
      name: ca.name,
      owner: ca.owner,
      messageCount: recentMessages.filter((m) => m.fromAgent === ca.id || m.toAgent === ca.id).length,
    })),
    rooms: roomRows.map((r) => ({
      id: r.id,
      name: r.name,
      memberCount: memberRows.filter((m) => m.roomId === r.id).length,
      openTaskCount: roomTaskRows.filter((t) => t.scope === `room:${r.id}` && t.status !== "done").length,
    })),
    pendingCount,
    activeNav: "feed",
  };

  const topbar = renderTopbar({
    eyebrow: "Observer",
    badge: "read-only",
    title: "Agent coordination",
    stats: [
      { label: "Connected", value: "live", tone: "good" },
      { label: "Pending", value: String(pendingCount) },
      { label: "Threads", value: String(threads.size) },
    ],
  });

  const body = html`
    <div class="body-grid">
      <div class="chat-stream">
        ${sectionLabel("Messages", html`<a href="/dashboard/inbox">Open inbox →</a>`)}
        ${recentMessages.length === 0
          ? emptyState({ icon: "inbox", title: "No messages yet", hint: "Direct messages between your agent and its contacts will appear here." })
          : recentMessages.map((m) => {
            const from = agentNames.get(m.fromAgent) ?? m.fromAgent.slice(0, 8);
            const to = agentNames.get(m.toAgent) ?? m.toAgent.slice(0, 8);
            const payload = m.payload as Record<string, unknown>;
            const content = (payload.content as string) || JSON.stringify(m.payload);
            const context = payload.context as string | undefined;
            const finality = payload.finality as string | undefined;
            return messageBubble({
              from, to, type: m.type, content, context, finality,
              time: timeAgo(m.createdAt), isMine: m.fromAgent === agentId,
            });
          })}

        ${openRoomTasks.length > 0 ? html`
          <div class="spacer-top">
            ${sectionLabel("Open room work")}
            <div class="stack">
              ${openRoomTasks.slice(0, 10).map((t) => {
                const room = roomRows.find((r) => t.scope === `room:${r.id}`);
                const tone = statusTone(t.status);
                return html`
                  <div class="rail-list-item">
                    <span class="mark ${tone}">${statusIcon(t.status)}</span>
                    <span class="text">${t.title}${room ? html` <span class="mono" style="color:var(--text-faint)">#${room.name}</span>` : ""}</span>
                    <span class="age">${timeAgo(t.updatedAt)}</span>
                  </div>
                `;
              })}
            </div>
          </div>
        ` : ""}
      </div>

      <aside class="context-rail">
        <div class="rail-card">
          <div class="rail-title">Active threads</div>
          ${threads.size === 0
            ? html`<div class="empty-inline">No threads yet.</div>`
            : html`<div class="stack">
              ${Array.from(threads.entries()).slice(0, 6).map(([tid, t]) => html`
                <a class="rail-list-item" href="/dashboard/thread/${tid}">
                  <span class="text mono">${tid.slice(0, 8)}</span>
                  <span class="age">${t.count} msgs · ${timeAgo(t.lastActivity)}</span>
                </a>
              `)}
            </div>`}
        </div>

        <div class="rail-card">
          <div class="rail-title">Rooms</div>
          ${roomRows.length === 0
            ? html`<div class="empty-inline">No rooms yet.</div>`
            : html`<div class="stack">
              ${roomRows.map((room) => {
                const members = memberRows.filter((m) => m.roomId === room.id);
                const rTasks = roomTaskRows.filter((t) => t.scope === `room:${room.id}`);
                const open = rTasks.filter((t) => t.status !== "done").length;
                return html`
                  <a class="rail-list-item" href="/dashboard/room/${room.id}">
                    <span class="text"><span class="room-hash">#</span> ${room.name}</span>
                    <span class="age">${members.length} agents · ${open} open</span>
                  </a>
                `;
              })}
            </div>`}
        </div>
      </aside>
    </div>
  `;

  return c.html(documentShell({
    title: "Trunk Dashboard",
    sidebar: renderSidebar(sidebarData),
    topbar,
    body,
  }));
});

app.get("/thread/:threadId", requireValidUUIDs("threadId"), async (c) => {
  const agentId = c.get("agentId");
  const threadId = c.req.param("threadId");

  const rateLimit = await checkRateLimit(`dashboard:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.text("Too many requests. Please try again later.", 429);
  }

  const sidebarData = await loadSidebarData(agentId);

  const threadMessages = await db
    .select()
    .from(messages)
    .where(and(
      eq(messages.threadId, threadId),
      or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId)),
    ))
    .orderBy(messages.createdAt);

  const agentIds = [...new Set(threadMessages.flatMap((m) => [m.fromAgent, m.toAgent]))];
  const agentRows = agentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
    : [];
  const nameMap = Object.fromEntries(agentRows.map((a) => [a.id, a.name]));

  const topbar = renderTopbar({
    eyebrow: "Thread",
    title: `Thread ${threadId.slice(0, 8)}`,
    stats: [{ label: "Messages", value: `${threadMessages.length} messages` }],
  });

  const body = html`
    <div class="chat-stream">
      ${sectionLabel(`${threadMessages.length} messages`)}
      ${threadMessages.length === 0
        ? emptyState({ icon: "inbox", title: "No messages in this thread", hint: "Replies on this thread will appear here in chronological order." })
        : html`<div class="thread-wrap">
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
                <div class="thread-msg-head">
                  <strong>${senderName}</strong>
                  ${typePill(m.type)}
                  ${finality ? finalityPill(finality) : ""}
                  ${urgency ? urgencyPill(urgency) : ""}
                  <span class="pill status">${m.status}</span>
                  <time>${timeAgo(m.createdAt)}</time>
                </div>
                <div class="thread-msg-body">${content}</div>
                ${context ? html`<div class="thread-msg-context">${context}</div>` : ""}
              </div>
            `;
          })}
        </div>`}
    </div>
  `;

  return c.html(documentShell({
    title: `Thread — Trunk`,
    sidebar: renderSidebar({ ...sidebarData, activeNav: "feed" }),
    topbar,
    body,
  }));
});

app.get("/inbox", async (c) => {
  const agentId = c.get("agentId");
  const statusFilter = c.req.query("status") || "pending";
  if (!VALID_STATUSES.includes(statusFilter)) {
    return c.text("Invalid status filter", 400);
  }

  const rateLimit = await checkRateLimit(`dashboard:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.text("Too many requests. Please try again later.", 429);
  }

  const sidebarData = await loadSidebarData(agentId);

  const inboxMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.toAgent, agentId), eq(messages.status, statusFilter)))
    .orderBy(desc(messages.createdAt))
    .limit(50);

  const senderIds = [...new Set(inboxMessages.map((m) => m.fromAgent))];
  const senderRows = senderIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, senderIds))
    : [];
  const nameMap = Object.fromEntries(senderRows.map((a) => [a.id, a.name]));

  const topbar = renderTopbar({
    eyebrow: "Inbox",
    title: `Inbox (${statusFilter})`,
    stats: [{ label: "Showing", value: String(inboxMessages.length), tone: "muted" }],
  });

  const body = html`
    <div class="chat-stream">
      <div class="inbox-tabs">
        ${VALID_STATUSES.map((s) => html`
          <a class="inbox-tab ${s === statusFilter ? "active" : ""}" href="/dashboard/inbox?status=${s}">${s}</a>
        `)}
      </div>

      ${inboxMessages.length === 0
        ? emptyState({ icon: "inbox", title: `No ${statusFilter} messages`, hint: "Messages addressed to your agent will land here. Use the filters above to switch between delivery states." })
        : html`<div class="stack">
          ${inboxMessages.map((m) => {
            const senderName = nameMap[m.fromAgent] || m.fromAgent.slice(0, 8);
            const payload = m.payload as Record<string, unknown>;
            const content = (payload.content as string) || "";
            const context = (payload.context as string) || "";
            return html`
              <div class="inbox-card">
                <div class="thread-msg-head">
                  <strong>${senderName}</strong>
                  ${typePill(m.type)}
                  <span class="pill status">${m.status}</span>
                  <time>${timeAgo(m.createdAt)}</time>
                  ${m.threadId ? html`<a class="thread-link-inline" href="/dashboard/thread/${m.threadId}">view thread →</a>` : ""}
                </div>
                <div class="thread-msg-body">${content}</div>
                ${context ? html`<div class="thread-msg-context">${context}</div>` : ""}
              </div>
            `;
          })}
        </div>`}
    </div>
  `;

  return c.html(documentShell({
    title: "Inbox — Trunk",
    sidebar: renderSidebar({ ...sidebarData, activeNav: "inbox" }),
    topbar,
    body,
  }));
});

app.get("/room/:roomId", requireValidUUIDs("roomId"), async (c) => {
  const agentId = c.get("agentId");
  const roomId = c.req.param("roomId");

  const rateLimit = await checkRateLimit(`dashboard:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.text("Too many requests. Please try again later.", 429);
  }

  const membership = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);
  if (membership.length === 0) {
    return c.text("Not a member of this room", 403);
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) return c.text("Room not found", 404);

  const members = await db.select().from(roomMembers).where(eq(roomMembers.roomId, roomId));

  const roomMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.toRoom, roomId))
    .orderBy(desc(messages.createdAt))
    .limit(50);

  const roomTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.scope, `room:${roomId}`))
    .orderBy(desc(tasks.updatedAt));

  const allAgentIds = unique([
    agentId,
    ...members.map((m) => m.agentId),
    ...roomMessages.flatMap((m) => [m.fromAgent, m.toAgent]),
    ...roomTasks.map((t) => t.owner).filter(Boolean) as string[],
    ...roomTasks.map((t) => t.createdBy).filter(Boolean) as string[],
  ]);
  const agentRows = allAgentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, allAgentIds))
    : [];
  const nameMap = new Map(agentRows.map((a) => [a.id, a.name]));

  const totalTasks = roomTasks.length;
  const doneTasks = roomTasks.filter((t) => t.status === "done").length;
  const inProgressTasks = roomTasks.filter((t) => t.status === "in-progress").length;
  const blockedTasks = roomTasks.filter((t) => t.status === "blocked").length;
  const openTasks = roomTasks.filter((t) => t.status === "open").length;
  const overallProgress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const doneIds = new Set(roomTasks.filter((t) => t.status === "done").map((t) => t.id));

  type TaskRow = (typeof roomTasks)[0];
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

  function renderTaskRow(t: TaskRow) {
    const deps = (t.dependsOn as string[]) || [];
    const blockedBy = deps.filter((d) => !doneIds.has(d));
    const owner = t.owner ? (nameMap.get(t.owner) || t.owner.slice(0, 8)) : null;
    return taskRow({
      title: t.title,
      status: t.status,
      owner,
      priority: t.priority,
      blockedByCount: blockedBy.length,
      hasDeps: deps.length > 0,
      age: timeAgo(t.updatedAt),
    });
  }

  function renderGroup(name: string, moduleTasks: TaskRow[]) {
    const done = moduleTasks.filter((t) => t.status === "done").length;
    const active = moduleTasks.filter((t) => t.status === "in-progress").length;
    const blocked = moduleTasks.filter((t) => t.status === "blocked").length;
    const queued = moduleTasks.filter((t) => t.status === "open").length;
    const total = moduleTasks.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const statusOrder: Record<string, number> = { "in-progress": 0, "blocked": 1, "open": 2, "done": 3 };
    const sorted = [...moduleTasks].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));
    return moduleCard({
      name,
      counts: { active, blocked, queued, done },
      progressPct: pct,
      rows: sorted.map(renderTaskRow),
    });
  }

  const taskById = new Map(roomTasks.map((t) => [t.id, t]));
  let mermaidDef = "";
  const activeTasks = roomTasks.filter((t) => t.status !== "done");
  const neededDoneIds = new Set<string>();
  for (const t of activeTasks) {
    for (const dep of (t.dependsOn as string[]) || []) {
      const depTask = taskById.get(dep);
      if (depTask && depTask.status === "done") neededDoneIds.add(dep);
    }
  }
  const dagTasks = [...activeTasks, ...roomTasks.filter((t) => neededDoneIds.has(t.id))];
  const dagTaskIds = new Set(dagTasks.map((t) => t.id));

  if (dagTasks.length > 0) {
    const sanitize = (s: string) => s.replace(/["\[\](){}|<>#&]/g, " ").replace(/\s+/g, " ").trim();
    const shortId = (id: string) => `t_${id.replace(/-/g, "_")}`;
    const statusColor: Record<string, string> = {
      "done": ":::done",
      "in-progress": ":::active",
      "blocked": ":::blocked",
      "open": ":::open",
    };
    const lines: string[] = ["flowchart TD"];
    lines.push("  classDef done fill:#1a2e1a,stroke:#7ee787,color:#7ee787,font-size:14px");
    lines.push("  classDef active fill:#2a2a10,stroke:#d5ff5f,color:#d5ff5f,font-size:14px");
    lines.push("  classDef blocked fill:#2e1a1a,stroke:#ff7b72,color:#ff7b72,font-size:14px");
    lines.push("  classDef open fill:#1a1a18,stroke:#8d8a7d,color:#8d8a7d,font-size:14px");
    const dagGroupMap = new Map<string, typeof dagTasks>();
    const dagUngrouped: typeof dagTasks = [];
    for (const t of dagTasks) {
      if (t.group) {
        if (!dagGroupMap.has(t.group)) dagGroupMap.set(t.group, []);
        dagGroupMap.get(t.group)!.push(t);
      } else {
        dagUngrouped.push(t);
      }
    }
    for (const [group, gTasks] of dagGroupMap.entries()) {
      lines.push(`  subgraph ${sanitize(group)}`);
      for (const t of gTasks) {
        const label = sanitize(t.title).slice(0, 50);
        lines.push(`    ${shortId(t.id)}["${label}"]${statusColor[t.status] || ":::open"}`);
      }
      lines.push("  end");
    }
    for (const t of dagUngrouped) {
      const label = sanitize(t.title).slice(0, 50);
      lines.push(`  ${shortId(t.id)}["${label}"]${statusColor[t.status] || ":::open"}`);
    }
    for (const t of dagTasks) {
      const deps = (t.dependsOn as string[]) || [];
      for (const dep of deps) {
        if (dagTaskIds.has(dep)) lines.push(`  ${shortId(dep)} --> ${shortId(t.id)}`);
      }
    }
    mermaidDef = lines.join("\n");
  }

  const sidebarData = await loadSidebarData(agentId);

  const topbar = renderTopbar({
    eyebrow: "Room",
    title: `# ${room.name}`,
    stats: [
      { label: "Members", value: String(members.length) },
      { label: "Messages", value: String(roomMessages.length) },
      { label: "Tasks", value: String(totalTasks) },
      { label: "Progress", value: `${overallProgress}%`, tone: "good" },
    ],
  });

  const blockedRoomTasks = roomTasks.filter((t) => t.status === "blocked");
  const completedRoomTasks = roomTasks
    .filter((t) => t.status === "done")
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 8);

  const body = html`
    <div class="body-grid">
      <div class="chat-stream">
        ${sectionLabel("Members")}
        <div class="pill-row">
          ${members.map((m) => html`
            <span class="member-pill">
              <span class="avatar">${initials(nameMap.get(m.agentId) ?? m.agentId.slice(0, 8))}</span>
              ${nameMap.get(m.agentId) ?? m.agentId.slice(0, 8)}
              <span class="role">${m.role}</span>
            </span>
          `)}
        </div>

        ${sectionLabel("Messages")}
        ${roomMessages.length === 0
          ? emptyState({ icon: "inbox", title: "No messages in this room", hint: "Room messages sent by members will appear here." })
          : html`<div class="stack">
            ${roomMessages.map((m) => {
              const from = nameMap.get(m.fromAgent) ?? m.fromAgent.slice(0, 8);
              const payload = m.payload as Record<string, unknown>;
              const content = (payload.content as string) || JSON.stringify(m.payload);
              const context = payload.context as string | undefined;
              const finality = payload.finality as string | undefined;
              return messageBubble({
                from, type: m.type, content, context, finality,
                time: timeAgo(m.createdAt), isMine: m.fromAgent === agentId,
              });
            })}
          </div>`}

        <div class="spacer-top">
          ${sectionLabel("Tasks", html`<span style="color:var(--text-faint);text-transform:none;letter-spacing:0">${doneTasks}/${totalTasks} done</span>`)}
          ${totalTasks === 0
            ? emptyState({ icon: "mission", title: "No tasks in this room", hint: "Room-scoped tasks and their dependencies will be tracked here." })
            : html`
              <div class="stack">
                <div class="row-gap">
                  ${inProgressTasks > 0 ? html`<span class="task-summary active">${inProgressTasks} active</span>` : ""}
                  ${blockedTasks > 0 ? html`<span class="task-summary blocked">${blockedTasks} blocked</span>` : ""}
                  ${openTasks > 0 ? html`<span class="task-summary queued">${openTasks} queued</span>` : ""}
                  ${doneTasks > 0 ? html`<span class="task-summary done">${doneTasks} done</span>` : ""}
                </div>
                <div class="progress-track"><div class="progress-fill" style="width:${overallProgress}%"></div></div>

                ${mermaidDef ? html`
                  <div class="dag-card">
                    <div class="dag-head">
                      <span class="dag-head-label">Active work <span class="dim">${dagTasks.length} tasks</span></span>
                      <div class="dag-controls">
                        <span id="dag-zoom" class="dag-zoom-label">100%</span>
                        <button id="dag-zoom-out" class="dag-btn" type="button" aria-label="Zoom out">−</button>
                        <button id="dag-zoom-in" class="dag-btn" type="button" aria-label="Zoom in">+</button>
                        <button id="dag-zoom-fit" class="dag-btn fit" type="button">fit</button>
                      </div>
                    </div>
                    <div id="dag-viewport" class="dag-viewport">
                      <div class="dag-inner"><pre class="mermaid">${raw(mermaidDef)}</pre></div>
                    </div>
                  </div>
                ` : ""}

                ${Array.from(groupMap.entries()).map(([name, moduleTasks]) => renderGroup(name, moduleTasks))}
                ${ungrouped.length > 0 ? renderGroup("ungrouped", ungrouped) : ""}
              </div>
            `}
        </div>
      </div>

      <aside class="context-rail">
        <div class="rail-card">
          <div class="rail-title">Room info</div>
          <div class="room-meta-row">Created ${timeAgo(room.createdAt)}</div>
          <div class="room-meta-row">Pairing code: <span class="mono">${room.pairingCode}</span></div>
        </div>

        <div class="rail-card">
          <div class="rail-title">Blocked tasks</div>
          ${blockedRoomTasks.length === 0
            ? html`<div class="rail-ok">Nothing blocked</div>`
            : blockedRoomTasks.map((t) => {
              const deps = (t.dependsOn as string[]) || [];
              const waitingOn = deps.filter((d) => !doneIds.has(d));
              const waitingNames = waitingOn.map((d) => {
                const dep = roomTasks.find((x) => x.id === d);
                return dep ? dep.title : d.slice(0, 8);
              });
              return html`
                <div class="rail-list-item">
                  <span class="mark danger">${statusIcon("blocked")}</span>
                  <div class="text">
                    ${t.title}
                    <div class="rail-waiting">waiting on: ${waitingNames.join(", ")}</div>
                  </div>
                </div>
              `;
            })}
        </div>

        <div class="rail-card">
          <div class="rail-title">Recent completions</div>
          ${completedRoomTasks.length === 0
            ? html`<div class="empty-inline">Nothing completed yet</div>`
            : completedRoomTasks.map((t) => html`
              <div class="rail-list-item">
                <span class="mark good">${statusIcon("done")}</span>
                <span class="text">${t.title}</span>
                <span class="age">${timeAgo(t.updatedAt)}</span>
              </div>
            `)}
        </div>
      </aside>
    </div>
  `;

  const mermaidScript = html`
    <script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
      mermaid.initialize({
        startOnLoad: true,
        theme: 'dark',
        themeVariables: {
          darkMode: true,
          background: '#16170f',
          primaryColor: '#1a2a1a',
          primaryTextColor: '#f1ede0',
          primaryBorderColor: '#26271c',
          lineColor: '#4a4840',
          secondaryColor: '#1a1a2e',
          tertiaryColor: '#2e1a1a',
          fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif',
          fontSize: '16px',
          nodeBorder: '#26271c',
          clusterBkg: '#101109',
          clusterBorder: '#26271c',
          edgeLabelBackground: '#16170f',
        },
        flowchart: { curve: 'basis', padding: 12 },
      });

      document.addEventListener('DOMContentLoaded', () => {
        const viewport = document.getElementById('dag-viewport');
        if (!viewport) return;
        const inner = viewport.querySelector('.dag-inner');
        if (!inner) return;

        let scale = 1.0, panX = 0, panY = 0;
        let dragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;

        function apply() {
          inner.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
          const zoomLabel = document.getElementById('dag-zoom');
          if (zoomLabel) zoomLabel.textContent = Math.round(scale * 100) + '%';
        }
        apply();

        viewport.addEventListener('wheel', (e) => {
          e.preventDefault();
          const rect = viewport.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const oldScale = scale;
          const delta = e.deltaY > 0 ? 0.9 : 1.1;
          scale = Math.min(3, Math.max(0.1, scale * delta));
          panX = mx - (mx - panX) * (scale / oldScale);
          panY = my - (my - panY) * (scale / oldScale);
          apply();
        }, { passive: false });

        viewport.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          dragging = true;
          startX = e.clientX; startY = e.clientY;
          startPanX = panX; startPanY = panY;
        });
        window.addEventListener('mousemove', (e) => {
          if (!dragging) return;
          panX = startPanX + (e.clientX - startX);
          panY = startPanY + (e.clientY - startY);
          apply();
        });
        window.addEventListener('mouseup', () => { dragging = false; });

        let lastTouchDist = 0;
        viewport.addEventListener('touchstart', (e) => {
          if (e.touches.length === 1) {
            dragging = true;
            startX = e.touches[0].clientX; startY = e.touches[0].clientY;
            startPanX = panX; startPanY = panY;
          } else if (e.touches.length === 2) {
            lastTouchDist = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
          }
        }, { passive: true });
        viewport.addEventListener('touchmove', (e) => {
          if (e.touches.length === 1 && dragging) {
            panX = startPanX + (e.touches[0].clientX - startX);
            panY = startPanY + (e.touches[0].clientY - startY);
            apply();
          } else if (e.touches.length === 2) {
            const dist = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
            if (lastTouchDist > 0) {
              scale = Math.min(3, Math.max(0.1, scale * (dist / lastTouchDist)));
              apply();
            }
            lastTouchDist = dist;
          }
        }, { passive: true });
        viewport.addEventListener('touchend', () => { dragging = false; lastTouchDist = 0; });

        viewport.addEventListener('dblclick', () => { scale = 1.0; panX = 0; panY = 0; apply(); });

        document.getElementById('dag-zoom-in')?.addEventListener('click', () => { scale = Math.min(3, scale * 1.3); apply(); });
        document.getElementById('dag-zoom-out')?.addEventListener('click', () => { scale = Math.max(0.1, scale * 0.7); apply(); });
        document.getElementById('dag-zoom-fit')?.addEventListener('click', () => { scale = 1.0; panX = 0; panY = 0; apply(); });
      });
    </script>
  `;

  return c.html(documentShell({
    title: `${room.name} — Trunk`,
    sidebar: renderSidebar({ ...sidebarData, activeRoomId: roomId }),
    topbar,
    body,
    headExtra: mermaidScript,
  }));
});

app.get("/gantt", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`dashboard:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.text("Too many requests. Please try again later.", 429);
  }

  const sidebarData = await loadSidebarData(agentId);

  const wsMemberships = await db
    .select()
    .from(workspaceContacts)
    .where(eq(workspaceContacts.agentId, agentId));

  const wsIds = wsMemberships.map((m) => m.workspaceId);

  const allTasks = wsIds.length > 0
    ? await db
        .select()
        .from(tasks)
        .where(inArray(tasks.scope, wsIds.map((id) => `workspace:${id}`)))
        .orderBy(tasks.sequence, tasks.createdAt)
    : [];

  const membershipRows = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.agentId, agentId));
  const roomIds = membershipRows.map((m) => m.roomId);
  const roomTasks = roomIds.length > 0
    ? await db
        .select()
        .from(tasks)
        .where(inArray(tasks.scope, roomIds.map((id) => `room:${id}`)))
        .orderBy(tasks.sequence, tasks.createdAt)
    : [];

  const taskMap = new Map<string, (typeof allTasks)[0]>();
  for (const t of [...allTasks, ...roomTasks]) taskMap.set(t.id, t);
  const mergedTasks = [...taskMap.values()];

  const ownerIds = [...new Set(mergedTasks.map((t) => t.owner).filter(Boolean))] as string[];
  const creatorIds = [...new Set(mergedTasks.map((t) => t.createdBy).filter(Boolean))] as string[];
  const allAgentIds = [...new Set([...ownerIds, ...creatorIds])];
  const allAgentRows = allAgentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, allAgentIds))
    : [];
  const agentNameMap = new Map(allAgentRows.map((a) => [a.id, a.name]));

  const doneIds = new Set(mergedTasks.filter((t) => t.status === "done").map((t) => t.id));

  type TaskRow = (typeof mergedTasks)[0];
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

  const totalTasks = mergedTasks.length;
  const doneTasks = mergedTasks.filter((t) => t.status === "done").length;
  const inProgressTasks = mergedTasks.filter((t) => t.status === "in-progress").length;
  const blockedTasks = mergedTasks.filter((t) => t.status === "blocked").length;
  const openTasks = mergedTasks.filter((t) => t.status === "open").length;
  const overallProgress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentlyDone = mergedTasks
    .filter((t) => t.status === "done" && t.updatedAt > oneDayAgo)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const agentWork = new Map<string, { active: number; done: number; blocked: number }>();
  for (const t of mergedTasks) {
    const ownerId = t.owner || "unassigned";
    if (!agentWork.has(ownerId)) agentWork.set(ownerId, { active: 0, done: 0, blocked: 0 });
    const w = agentWork.get(ownerId)!;
    if (t.status === "in-progress") w.active++;
    else if (t.status === "done") w.done++;
    else if (t.status === "blocked") w.blocked++;
  }

  function renderGanttTaskRow(t: TaskRow) {
    const deps = (t.dependsOn as string[]) || [];
    const blockedBy = deps.filter((d) => !doneIds.has(d));
    const owner = t.owner ? (agentNameMap.get(t.owner) || t.owner.slice(0, 8)) : null;
    return taskRow({
      title: t.title,
      status: t.status,
      owner,
      priority: t.priority,
      blockedByCount: blockedBy.length,
      hasDeps: deps.length > 0,
      age: timeAgo(t.updatedAt),
    });
  }

  function renderGanttGroup(name: string, moduleTasks: TaskRow[]) {
    const done = moduleTasks.filter((t) => t.status === "done").length;
    const active = moduleTasks.filter((t) => t.status === "in-progress").length;
    const blocked = moduleTasks.filter((t) => t.status === "blocked").length;
    const queued = moduleTasks.filter((t) => t.status === "open").length;
    const total = moduleTasks.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const statusOrder: Record<string, number> = { "in-progress": 0, "blocked": 1, "open": 2, "done": 3 };
    const sorted = [...moduleTasks].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));
    return moduleCard({
      name,
      counts: { active, blocked, queued, done },
      progressPct: pct,
      rows: sorted.map(renderGanttTaskRow),
    });
  }

  const topbar = renderTopbar({
    eyebrow: "Overview",
    title: "Mission control",
    live: true,
    stats: [
      { label: "Active", value: String(inProgressTasks), tone: "accent" },
      { label: "Blocked", value: String(blockedTasks), tone: "danger" },
      { label: "Queued", value: String(openTasks) },
      { label: "Done", value: String(doneTasks), tone: "good" },
      { label: "Progress", value: `${overallProgress}%`, tone: "good" },
    ],
  });

  const body = html`
    <div class="mc-shell">
      ${totalTasks === 0
        ? emptyState({ icon: "mission", title: "No tasks yet", hint: "Create workspace or room tasks to see them here." })
        : html`
          <div class="mc-body">
            <div class="mc-modules">
              ${Array.from(groupMap.entries()).map(([name, moduleTasks]) => renderGanttGroup(name, moduleTasks))}
              ${ungrouped.length > 0 ? renderGanttGroup("ungrouped", ungrouped) : ""}
            </div>

            <div class="mc-sidebar-panels">
              <div class="mc-panel">
                <div class="mc-panel-title">Agent workload</div>
                ${agentWork.size === 0
                  ? html`<div class="empty-inline">No assigned tasks</div>`
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
                  ? html`<div class="empty-inline">Nothing in the last 24h</div>`
                  : recentlyDone.slice(0, 10).map((t) => {
                    const owner = t.owner ? (agentNameMap.get(t.owner) || t.owner.slice(0, 8)) : "unknown";
                    return html`
                      <div class="mc-feed-item">
                        <span class="mc-feed-icon" style="color:var(--good)">${statusIcon("done")}</span>
                        <div class="mc-feed-text">
                          <span class="agent">${owner}</span> finished ${t.title}
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
                  ? html`<div class="rail-ok">Nothing blocked</div>`
                  : mergedTasks.filter((t) => t.status === "blocked").slice(0, 8).map((t) => {
                    const deps = (t.dependsOn as string[]) || [];
                    const waitingOn = deps.filter((d) => !doneIds.has(d));
                    const waitingNames = waitingOn.map((d) => {
                      const dep = mergedTasks.find((x) => x.id === d);
                      return dep ? dep.title : d.slice(0, 8);
                    });
                    return html`
                      <div class="mc-feed-item">
                        <span class="mc-feed-icon" style="color:var(--danger)">${statusIcon("blocked")}</span>
                        <div class="mc-feed-text" style="font-size:12px">
                          ${t.title}
                          <div class="rail-waiting">waiting on: ${waitingNames.join(", ")}</div>
                        </div>
                      </div>
                    `;
                  })}
              </div>
            </div>
          </div>
        `}
    </div>
  `;

  return c.html(documentShell({
    title: "Mission Control — Trunk",
    sidebar: renderSidebar({ ...sidebarData, activeNav: "mission" }),
    topbar,
    body,
    headExtra: html`<script>setTimeout(() => location.reload(), 10000);</script>`,
  }));
});

export default app;
