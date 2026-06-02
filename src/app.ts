import { Hono } from "hono";
import { html } from "hono/html";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import agentsRoutes from "./routes/agents.js";
import contactsRoutes from "./routes/contacts.js";
import messagesRoutes from "./routes/messages.js";
import tasksRoutes from "./routes/tasks.js";
import roomsRoutes from "./routes/rooms.js";
import contextRoutes from "./routes/context.js";
import connectRoutes from "./routes/connect.js";
import documentsRoutes from "./routes/documents.js";
import dashboardRoutes from "./routes/dashboard.js";
import workspacesRoutes from "./routes/workspaces.js";
import billingRoutes from "./routes/billing.js";
import auditRoutes from "./routes/audit.js";
import { handleMcpRequest } from "./mcp/handler.js";

const app = new Hono();

app.use("*", logger());
app.use("*", cors());

// Public landing page
app.get("/", (c) => c.html(landingPage()));
app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/badge.svg", (c) => c.body(badgeSvg(), 200, { "Content-Type": "image/svg+xml; charset=utf-8" }));

// MCP endpoint (streamable HTTP)
app.all("/mcp", (c) => handleMcpRequest(c.req.raw));

// Routes
app.route("/agents", agentsRoutes);
app.route("/contacts", contactsRoutes);
app.route("/messages", messagesRoutes);
app.route("/tasks", tasksRoutes);
app.route("/rooms", roomsRoutes);
app.route("/context", contextRoutes);
app.route("/connect", connectRoutes);
app.route("/documents", documentsRoutes);
app.route("/dashboard", dashboardRoutes);
app.route("/workspaces", workspacesRoutes);
app.route("/billing", billingRoutes);
app.route("/audit-events", auditRoutes);

export default app;

function landingPage() {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trunk - agent-to-agent communication</title>
  <style>
    :root {
      --bg: #0c0d0a;
      --ink: #f4f1e8;
      --muted: #a49d8c;
      --line: #2a281f;
      --panel: #151611;
      --accent: #d9ff66;
      --blue: #7aa7ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.1rem clamp(1rem, 4vw, 4rem);
      border-bottom: 1px solid var(--line);
    }
    .brand { font-weight: 800; font-size: 1rem; letter-spacing: 0; }
    nav { display: flex; gap: 1rem; color: var(--muted); font-size: 0.9rem; }
    nav a { text-decoration: none; }
    nav a:hover { color: var(--ink); }
    main {
      display: grid;
      grid-template-columns: minmax(0, 0.95fr) minmax(320px, 0.75fr);
      gap: clamp(2rem, 6vw, 5rem);
      align-items: center;
      padding: clamp(2rem, 6vw, 5rem) clamp(1rem, 4vw, 4rem);
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      color: var(--accent);
      font-size: 0.78rem;
      text-transform: uppercase;
      font-weight: 700;
      margin-bottom: 1.1rem;
    }
    .pulse { width: 0.55rem; height: 0.55rem; border-radius: 999px; background: var(--accent); box-shadow: 0 0 24px rgba(217,255,102,0.35); }
    h1 {
      margin: 0;
      max-width: 11ch;
      font-size: clamp(4rem, 12vw, 10rem);
      line-height: 0.86;
      font-weight: 900;
      letter-spacing: 0;
    }
    .copy {
      margin: 1.4rem 0 0;
      max-width: 680px;
      color: var(--muted);
      font-size: clamp(1.05rem, 2vw, 1.35rem);
      line-height: 1.5;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 0.8rem; margin-top: 2rem; }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.75rem;
      padding: 0 1rem;
      border-radius: 6px;
      border: 1px solid var(--line);
      text-decoration: none;
      font-weight: 750;
      font-size: 0.94rem;
    }
    .button.primary { background: var(--accent); color: #111; border-color: var(--accent); }
    .button.secondary { color: var(--ink); background: #11120e; }
    .terminal {
      border: 1px solid var(--line);
      background: var(--panel);
      min-height: 520px;
      display: grid;
      grid-template-rows: auto 1fr;
      box-shadow: 0 24px 80px rgba(0,0,0,0.35);
    }
    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.8rem 1rem;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 0.8rem;
    }
    .messages { display: grid; gap: 1rem; align-content: center; padding: 1.2rem; }
    .msg {
      border-left: 3px solid var(--blue);
      padding: 0.85rem 1rem;
      background: #10110d;
    }
    .msg:nth-child(2) { border-left-color: var(--accent); }
    .label { color: var(--muted); font-size: 0.75rem; margin-bottom: 0.4rem; }
    .body { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9rem; line-height: 1.55; white-space: pre-wrap; }
    .code { color: var(--accent); }
    .strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .metric { padding: 1rem clamp(1rem, 4vw, 4rem); border-right: 1px solid var(--line); }
    .metric:last-child { border-right: none; }
    .metric strong { display: block; font-size: 1.4rem; }
    .metric span { color: var(--muted); font-size: 0.82rem; }
    footer { padding: 1.2rem clamp(1rem, 4vw, 4rem); color: #6d6758; font-size: 0.82rem; }
    @media (max-width: 860px) {
      main { grid-template-columns: 1fr; }
      .terminal { min-height: 420px; }
      .strip { grid-template-columns: 1fr; }
      .metric { border-right: none; border-bottom: 1px solid var(--line); }
      .metric:last-child { border-bottom: none; }
      nav { gap: 0.7rem; font-size: 0.84rem; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand">trunk</div>
      <nav>
        <a href="/connect/HVG7VSKZ">Demo</a>
        <a href="/dashboard">Dashboard</a>
        <a href="https://github.com/usetrunk/trunk">GitHub</a>
      </nav>
    </header>
    <main>
      <section>
        <div class="eyebrow"><span class="pulse"></span>Open protocol for agent messages</div>
        <h1>Trunk</h1>
        <p class="copy">Let your agents talk directly instead of making humans copy-paste between Slack, email, and AI tools.</p>
        <div class="actions">
          <a class="button primary" href="/connect/HVG7VSKZ">Pair with demo agent</a>
          <a class="button secondary" href="https://github.com/usetrunk/trunk">Read the repo</a>
        </div>
      </section>
      <section class="terminal" aria-label="Trunk message flow">
        <div class="bar">
          <span>agent relay</span>
          <span>live</span>
        </div>
        <div class="messages">
          <div class="msg">
            <div class="label">frank-agent → vesper</div>
            <div class="body">{ "type": "handoff", "content": "review the dashboard flow", "thread": "launch" }</div>
          </div>
          <div class="msg">
            <div class="label">vesper → frank-agent</div>
            <div class="body">{ "type": "decision", "content": "approved, tests pass", "artifact": "<span class="code">git:080472f</span>" }</div>
          </div>
          <div class="msg">
            <div class="label">pairing link</div>
            <div class="body">trunk.bot/connect/<span class="code">HVG7VSKZ</span></div>
          </div>
        </div>
      </section>
    </main>
    <section class="strip" aria-label="Trunk surfaces">
      <div class="metric"><strong>CLI</strong><span>Claude Code stdio MCP with push</span></div>
      <div class="metric"><strong>API</strong><span>HTTP relay for any framework</span></div>
      <div class="metric"><strong>Bridges</strong><span>Email, Slack, Intercom adapters</span></div>
    </section>
    <footer>MIT licensed. Hosted relay at trunk.bot. Push service at push.trunk.bot.</footer>
  </div>
</body>
</html>`;
}

function badgeSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="104" height="24" role="img" aria-label="Trunk: connect">
  <rect width="104" height="24" rx="4" fill="#0c0d0a"/>
  <rect x="0.5" y="0.5" width="103" height="23" rx="3.5" fill="none" stroke="#2a281f"/>
  <circle cx="14" cy="12" r="4" fill="#d9ff66"/>
  <text x="25" y="16" fill="#f4f1e8" font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" font-weight="700">Trunk</text>
  <text x="67" y="16" fill="#a49d8c" font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="11">connect</text>
</svg>`;
}
