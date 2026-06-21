import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { authMiddleware } from "../lib/auth.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import {
  getDeliveryHealth,
  getThreadTimeline,
  getTaskChanges,
  getFactTouches,
  getRecentAudits,
  getRecentThreads,
} from "../lib/inspector.js";
import { isValidUUID } from "../lib/errors.js";
import { html, raw } from "hono/html";
import { agents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

app.use("/*", authMiddleware);

function inspectorStyles() {
  return `
    :root { --bg: #0c0d0a; --ink: #f4f1e8; --muted: #a49d8c; --line: #2a281f; --panel: #151611; --accent: #d9ff66; --good: #7ee787; --warn: #f0c674; --bad: #ff7b72; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .shell { max-width: 1180px; margin: 0 auto; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); }
    .nav { display: flex; gap: 1rem; align-items: center; border-bottom: 1px solid var(--line); padding-bottom: 0.75rem; margin-bottom: 1.5rem; }
    .nav .brand { font-weight: 800; }
    .nav .spacer { flex: 1; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    h2 { font-size: 1rem; margin: 1.4rem 0 0.5rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 0.9rem 1rem; }
    .card h3 { margin: 0 0 0.3rem; font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .card .v { font-size: 1.6rem; font-weight: 700; }
    .card .sub { font-size: 0.78rem; color: var(--muted); margin-top: 0.2rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
    th, td { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 1px solid #1a1a18; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    .pill { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.72rem; background: #1a1a18; color: var(--muted); margin-right: 0.2rem; }
    .ok { color: var(--good); }
    .bad { color: var(--bad); }
    .warn { color: var(--warn); }
    pre { background: #0a0a09; padding: 0.75rem; border-radius: 6px; border: 1px solid var(--line); overflow: auto; font-size: 0.78rem; }
    .small { color: var(--muted); font-size: 0.78rem; }
    .empty { color: var(--muted); font-style: italic; }
    .timeline li { padding: 0.4rem 0; border-bottom: 1px solid #1a1a18; list-style: none; }
    .timeline { padding-left: 0; }
    .bar { background: #1a1a18; height: 6px; border-radius: 3px; overflow: hidden; }
    .bar > div { height: 100%; background: var(--good); }
  `;
}

app.get("/", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`inspector:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429 as ContentfulStatusCode);

  const accept = c.req.header("Accept") ?? "";
  const days = Math.min(Math.max(parseInt(c.req.query("days") || "7", 10) || 7, 1), 30);
  const [health, threads, factTouches, audits] = await Promise.all([
    getDeliveryHealth(agentId, days),
    getRecentThreads(agentId, 8),
    getFactTouches(agentId, days),
    getRecentAudits(agentId, days),
  ]);

  if (accept.includes("text/html")) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Inspector — Trunk</title>
  <style>${raw(inspectorStyles())}</style>
</head>
<body>
  <div class="shell">
    <div class="nav">
      <a class="brand" href="/inspector">trunk / inspector</a>
      <span class="spacer"></span>
      <a class="small" href="/inspector/health/view">Delivery health</a>
      <a class="small" href="/inspector/facts/view">Fact provenance</a>
    </div>
    <h1>Inspector — ${agent?.name ?? agentId.slice(0, 8)} <span class="small">${agentId}</span></h1>
    <p class="small">Window: last ${days} days. Generated ${new Date().toISOString()}.</p>
    <h2>Delivery health</h2>
    <div class="grid">
      <div class="card"><h3>Attempts</h3><div class="v">${health.totals.attempts}</div></div>
      <div class="card"><h3>Successes</h3><div class="v ok">${health.totals.successes}</div></div>
      <div class="card"><h3>Failures</h3><div class="v bad">${health.totals.failures}</div></div>
      <div class="card"><h3>Avg latency</h3><div class="v">${health.totals.avg_latency_ms ?? "—"}ms</div></div>
    </div>
    <h2>Recent threads</h2>
    <ul class="timeline">
      ${threads.length === 0
        ? html`<li class="empty">No recent threads.</li>`
        : threads.map((t) => html`
          <li>
            <a href="/inspector/thread/${t.thread_id}/view">${t.thread_id.slice(0, 8)}…</a>
            <span class="small"> — ${t.message_count} messages, ${t.last_activity}</span>
          </li>
        `)}
    </ul>
    <h2>Recent fact touches</h2>
    <ul class="timeline">
      ${factTouches.length === 0
        ? html`<li class="empty">No recent fact touches.</li>`
        : factTouches.slice(0, 10).map((t) => html`
          <li>
            <strong>${t.key}</strong>
            <span class="small"> v${t.version} • ${t.set_at} • ${t.reason ?? "no reason"}</span>
          </li>
        `)}
    </ul>
    <h2>Recent audit events</h2>
    <ul class="timeline">
      ${audits.length === 0
        ? html`<li class="empty">No recent audits.</li>`
        : audits.slice(0, 10).map((a) => html`
          <li>${a.created_at} — ${a.action} on ${a.target_type}${a.target_id ? html` (${a.target_id.slice(0, 8)})` : ""}</li>
        `)}
    </ul>
  </div>
</body>
</html>`);
  }

  return c.json({
    agent_id: agentId,
    generated_at: new Date().toISOString(),
    health,
    recent_threads: threads,
    recent_facts: factTouches,
    recent_audits: audits,
  });
});

app.get("/health", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`inspector:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429 as ContentfulStatusCode);
  const days = Math.min(Math.max(parseInt(c.req.query("days") || "7", 10) || 7, 1), 30);
  return c.json(await getDeliveryHealth(agentId, days));
});

app.get("/thread/:threadId", async (c) => {
  const agentId = c.get("agentId");
  const threadId = c.req.param("threadId");
  if (!threadId || !isValidUUID(threadId)) {
    return c.json({ error: "Invalid thread id", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
  }
  const rateLimit = await checkRateLimit(`inspector:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429 as ContentfulStatusCode);
  return c.json(await getThreadTimeline(threadId));
});

app.get("/thread/:threadId/view", async (c) => {
  const agentId = c.get("agentId");
  const threadId = c.req.param("threadId");
  if (!threadId || !isValidUUID(threadId)) {
    return c.text("Invalid thread id", 400 as ContentfulStatusCode);
  }
  const rateLimit = await checkRateLimit(`inspector:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.text("Too many requests", 429 as ContentfulStatusCode);

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  const timeline = await getThreadTimeline(threadId);
  const delivered = timeline.counts.delivered;
  void timeline.counts.failed;
  const successPct = timeline.counts.messages > 0
    ? Math.round((delivered / timeline.counts.messages) * 100)
    : 0;

  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Thread timeline — Trunk Inspector</title>
  <style>${raw(inspectorStyles())}</style>
</head>
<body>
  <div class="shell">
    <div class="nav">
      <a class="brand" href="/inspector">trunk / inspector</a>
      <span class="small">Thread timeline</span>
      <span class="spacer"></span>
      <a class="small" href="/inspector">Back to overview</a>
    </div>
    <h1>Thread ${threadId.slice(0, 8)}…</h1>
    <p class="small">${timeline.counts.messages} messages • ${timeline.counts.delivered} delivered • ${timeline.counts.failed} failed • ${timeline.counts.edited} edited</p>
    <div class="bar"><div style="width:${successPct}%;"></div></div>
    <h2>Participants</h2>
    <p>${timeline.participants.map((p) => html`<span class="pill">${p.name ?? p.agent_id.slice(0, 8)}</span>`)}</p>
    <h2>Timeline</h2>
    ${timeline.entries.length === 0
      ? html`<p class="empty">No messages in this thread.</p>`
      : html`<table>
          <thead>
            <tr><th>When</th><th>From</th><th>To</th><th>Type</th><th>Status</th><th>Delivery</th><th>Attempts</th><th>Edits</th></tr>
          </thead>
          <tbody>
            ${timeline.entries.map((e) => html`
              <tr>
                <td>${e.created_at}</td>
                <td>${e.from_name ?? e.from.slice(0, 8)}</td>
                <td>${e.to_name ?? e.to.slice(0, 8)}</td>
                <td>${e.type}</td>
                <td>${e.status}</td>
                <td class="${e.delivery_state === "delivered" ? "ok" : e.delivery_state === "failed" ? "bad" : "warn"}">${e.delivery_state}</td>
                <td>${e.attempts ?? 0}</td>
                <td>${e.edited_at ? "edited" : ""}</td>
              </tr>
            `)}
          </tbody>
        </table>`}
    <h2>Raw</h2>
    <pre>${JSON.stringify(timeline, null, 2)}</pre>
    <p class="small">Inspector read-only. As ${agent?.name ?? agentId.slice(0, 8)}.</p>
  </div>
</body>
</html>`);
});

app.get("/health/view", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`inspector:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.text("Too many requests", 429 as ContentfulStatusCode);
  const days = Math.min(Math.max(parseInt(c.req.query("days") || "7", 10) || 7, 1), 30);
  const [agent, health] = await Promise.all([
    db.select().from(agents).where(eq(agents.id, agentId)).limit(1).then((rows) => rows[0]),
    getDeliveryHealth(agentId, days),
  ]);

  const successPct = health.totals.success_rate === null
    ? null
    : Math.round(health.totals.success_rate * 100);

  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Delivery health — Trunk Inspector</title>
  <style>${raw(inspectorStyles())}</style>
</head>
<body>
  <div class="shell">
    <div class="nav">
      <a class="brand" href="/inspector">trunk / inspector</a>
      <span class="small">Delivery health</span>
      <span class="spacer"></span>
      <a class="small" href="/inspector">Back to overview</a>
    </div>
    <h1>Delivery health — ${agent?.name ?? agentId.slice(0, 8)}</h1>
    <p class="small">Window: ${health.window.from} → ${health.window.to} (${days} days) • Webhook configured: ${health.webhook_configured ? "yes" : "no"}</p>
    <div class="grid">
      <div class="card"><h3>Attempts</h3><div class="v">${health.totals.attempts}</div><div class="sub">across ${health.by_event.length} event types</div></div>
      <div class="card"><h3>Successes</h3><div class="v ok">${health.totals.successes}</div><div class="sub">${successPct ?? "—"}% success rate</div></div>
      <div class="card"><h3>Failures</h3><div class="v bad">${health.totals.failures}</div><div class="sub">${health.totals.failures > 0 ? html`<a href="#failures">view ${health.totals.failures}</a>` : "all clear"}</div></div>
      <div class="card"><h3>Avg latency</h3><div class="v">${health.totals.avg_latency_ms ?? "—"}ms</div><div class="sub">measured across successful deliveries</div></div>
    </div>
    <h2>By event</h2>
    ${health.by_event.length === 0
      ? html`<p class="empty">No webhook events recorded in this window.</p>`
      : html`<table><thead><tr><th>Event</th><th>Attempts</th><th>Success</th><th>Failure</th></tr></thead><tbody>
        ${health.by_event.map((b) => html`<tr><td>${b.event}</td><td>${b.attempts}</td><td class="ok">${b.successes}</td><td class="bad">${b.failures}</td></tr>`)}
      </tbody></table>`}
    <h2 id="failures">Recent failures</h2>
    ${health.recent_failures.length === 0
      ? html`<p class="empty">No failures recorded.</p>`
      : html`<table><thead><tr><th>When</th><th>Event</th><th>URL</th><th>HTTP</th><th>Error</th></tr></thead><tbody>
        ${health.recent_failures.map((f) => html`<tr><td>${f.created_at}</td><td>${f.event}</td><td>${f.url}</td><td>${f.http_status ?? "—"}</td><td class="bad">${f.error ?? ""}</td></tr>`)}
      </tbody></table>`}
    <h2>Recent successes</h2>
    ${health.recent_successes.length === 0
      ? html`<p class="empty">No successes recorded.</p>`
      : html`<table><thead><tr><th>When</th><th>Event</th><th>URL</th><th>HTTP</th><th>Latency</th></tr></thead><tbody>
        ${health.recent_successes.map((f) => html`<tr><td>${f.created_at}</td><td>${f.event}</td><td>${f.url}</td><td>${f.http_status ?? "—"}</td><td>${f.latency_ms ?? "—"}ms</td></tr>`)}
      </tbody></table>`}
    <h2>Raw</h2>
    <pre>${JSON.stringify(health, null, 2)}</pre>
  </div>
</body>
</html>`);
});

app.get("/facts/view", async (c) => {
  const agentId = c.get("agentId");
  const rateLimit = await checkRateLimit(`inspector:${agentId}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) return c.text("Too many requests", 429 as ContentfulStatusCode);
  const days = Math.min(Math.max(parseInt(c.req.query("days") || "7", 10) || 7, 1), 30);
  const [agent, touches, audits, threads] = await Promise.all([
    db.select().from(agents).where(eq(agents.id, agentId)).limit(1).then((rows) => rows[0]),
    getFactTouches(agentId, days),
    getRecentAudits(agentId, days),
    getRecentThreads(agentId, 10),
  ]);

  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fact provenance — Trunk Inspector</title>
  <style>${raw(inspectorStyles())}</style>
</head>
<body>
  <div class="shell">
    <div class="nav">
      <a class="brand" href="/inspector">trunk / inspector</a>
      <span class="small">Fact provenance</span>
      <span class="spacer"></span>
      <a class="small" href="/inspector">Back to overview</a>
    </div>
    <h1>Fact touches — ${agent?.name ?? agentId.slice(0, 8)}</h1>
    <p class="small">Window: last ${days} days. Up to 50 most recent fact writes visible to you.</p>
    <h2>Recent fact writes</h2>
    ${touches.length === 0
      ? html`<p class="empty">No fact writes in this window.</p>`
      : html`<table>
          <thead><tr><th>When</th><th>Scope</th><th>Key</th><th>Version</th><th>Reason</th><th>Source</th></tr></thead>
          <tbody>
            ${touches.map((t) => html`
              <tr>
                <td>${t.set_at}</td>
                <td>${t.scope}</td>
                <td>${t.key}</td>
                <td>v${t.version}</td>
                <td>${t.reason ?? ""}</td>
                <td>${t.source_message_id ? html`<span class="pill">msg ${t.source_message_id.slice(0, 8)}</span>` : ""}${t.source_thread_id ? html`<span class="pill">thread ${t.source_thread_id.slice(0, 8)}</span>` : ""}</td>
              </tr>
            `)}
          </tbody>
        </table>`}
    <h2>Recent audit events</h2>
    <p>${audits.length} events</p>
    ${audits.length === 0
      ? html`<p class="empty">No audit events.</p>`
      : html`<table>
          <thead><tr><th>When</th><th>Action</th><th>Target</th></tr></thead>
          <tbody>
            ${audits.slice(0, 30).map((a) => html`
              <tr>
                <td>${a.created_at}</td>
                <td>${a.action}</td>
                <td>${a.target_type}${a.target_id ? html` <span class="small">${a.target_id.slice(0, 8)}</span>` : ""}</td>
              </tr>
            `)}
          </tbody>
        </table>`}
    <h2>Recent threads</h2>
    <ul class="timeline">
      ${threads.map((t) => html`
        <li>
          <a href="/inspector/thread/${t.thread_id}/view">${t.thread_id.slice(0, 8)}…</a>
          <span class="small"> — ${t.message_count} messages, last activity ${t.last_activity}</span>
        </li>
      `)}
    </ul>
  </div>
</body>
</html>`);
});

void getTaskChanges;
void getTaskChanges;
void getTaskChanges;

export default app;
