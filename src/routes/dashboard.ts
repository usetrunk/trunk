import { Hono } from "hono";
import { html } from "hono/html";
import { db } from "../db/index.js";
import { agents, contacts, messages } from "../db/schema.js";
import { eq, or, and, desc, sql } from "drizzle-orm";
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
  const contactAgents = contactIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name, owner: agents.owner })
        .from(agents)
        .where(or(...contactIds.map((id) => eq(agents.id, id))))
    : [];

  // Get recent messages
  const recentMessages = await db
    .select()
    .from(messages)
    .where(or(eq(messages.toAgent, agentId), eq(messages.fromAgent, agentId)))
    .orderBy(desc(messages.createdAt))
    .limit(20);

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

  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trunk Dashboard</title>
  <style>${dashboardStyles()}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">trunk</div>
      <div class="agent-name">${agent.name}</div>
    </div>

    <div class="grid">
      <!-- Health -->
      <div class="card">
        <div class="card-title">Health</div>
        <div class="stat-row">
          <span class="stat-label">Status</span>
          <span class="stat-value" style="color:#4ade80;">Connected</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Pending messages</span>
          <span class="stat-value">${pendingCount}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Pairing code</span>
          <span class="stat-value mono">${agent.pairingCode}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Agent ID</span>
          <span class="stat-value mono" style="font-size:0.7rem;">${agentId.slice(0, 12)}...</span>
        </div>
      </div>

      <!-- Contacts -->
      <div class="card">
        <div class="card-title">Contacts (${contactAgents.length})</div>
        ${contactAgents.length === 0
          ? html`<p class="empty">No contacts yet. Share your pairing code.</p>`
          : contactAgents.map((ca) => html`
            <div class="stat-row">
              <span class="stat-label">${ca.name}</span>
              <span class="stat-value">${ca.owner || ""}</span>
            </div>
          `)}
      </div>

      <!-- Active Threads -->
      <div class="card wide">
        <div class="card-title">Active Threads</div>
        ${threads.size === 0
          ? html`<p class="empty">No threads yet.</p>`
          : Array.from(threads.entries()).slice(0, 10).map(([tid, t]) => html`
            <div class="stat-row">
              <span class="stat-label mono">${tid.slice(0, 12)}...</span>
              <span class="stat-value">${t.count} msgs &middot; ${timeAgo(t.lastActivity)}</span>
            </div>
          `)}
      </div>

      <!-- Recent Messages -->
      <div class="card wide">
        <div class="card-title">Recent Messages</div>
        ${recentMessages.length === 0
          ? html`<p class="empty">No messages yet.</p>`
          : recentMessages.slice(0, 10).map((m) => {
            const direction = m.fromAgent === agentId ? "sent" : "received";
            const content = (m.payload as Record<string, unknown>)?.content as string || "";
            return html`
              <div class="message-row">
                <span class="msg-direction ${direction}">${direction === "sent" ? "→" : "←"}</span>
                <span class="msg-type">${m.type}</span>
                <span class="msg-content">${content.slice(0, 80)}${content.length > 80 ? "..." : ""}</span>
                <span class="msg-time">${timeAgo(m.createdAt)}</span>
              </div>
            `;
          })}
      </div>
    </div>

    <div class="footer">
      <a href="https://trunk.bot/connect/${agent.pairingCode}">Trunk link</a> &middot;
      <a href="https://github.com/usetrunk/trunk">GitHub</a>
    </div>
  </div>
</body>
</html>`);
});

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function dashboardStyles() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e5e5e5; min-height: 100vh; padding: 1.5rem; }
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
    .footer { text-align: center; margin-top: 2rem; font-size: 0.75rem; color: #444; }
    .footer a { color: #666; text-decoration: none; }
    .footer a:hover { color: #999; }
    h2 { color: #fff; font-size: 1.1rem; margin-bottom: 0.5rem; }
    @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  `;
}

export default app;
