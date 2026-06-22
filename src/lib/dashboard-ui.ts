import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { IconNode } from "lucide";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Ban,
  Circle,
  CircleCheck,
  ClipboardList,
  Clock3,
  IdCard,
  Inbox,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Radio,
  Search,
  Sparkles,
} from "lucide";
import { db } from "../db/index.js";
import { agents, contacts, messages, roomMembers, rooms, tasks } from "../db/schema.js";
import { eq, or, desc, inArray } from "drizzle-orm";

type Rendered = HtmlEscapedString | Promise<HtmlEscapedString>;

export type NavKey = "feed" | "inbox" | "mission";

export interface SidebarContact {
  id: string;
  name: string;
  owner: string | null;
  messageCount: number;
}

export interface SidebarRoom {
  id: string;
  name: string;
  memberCount: number;
  openTaskCount: number;
}

export interface SidebarData {
  agentName: string;
  pairingCode: string;
  contacts: SidebarContact[];
  rooms: SidebarRoom[];
  pendingCount: number;
  activeRoomId?: string;
  activeNav?: NavKey;
}

export interface TopbarStat {
  label: string;
  value: string;
  tone?: "good" | "danger" | "accent" | "muted";
}

export interface TopbarOptions {
  eyebrow: string;
  title: string;
  badge?: string;
  stats?: TopbarStat[];
  live?: boolean;
}

export function timeAgo(date: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

export function statusIcon(status: string): Rendered {
  switch (status) {
    case "done": return icon("status-done");
    case "in-progress": return icon("status-progress");
    case "blocked": return icon("status-blocked");
    default: return icon("status-open");
  }
}

export function statusTone(status: string): "good" | "accent" | "danger" | "muted" {
  switch (status) {
    case "done": return "good";
    case "in-progress": return "accent";
    case "blocked": return "danger";
    default: return "muted";
  }
}

function icon(name: string): Rendered {
  const nodes: Record<string, IconNode> = {
    feed: MessageSquare,
    inbox: Inbox,
    mission: LayoutDashboard,
    inspector: Search,
    card: IdCard,
    signout: LogOut,
    back: ArrowLeft,
    check: BadgeCheck,
    alert: AlertTriangle,
    spark: Sparkles,
    room: Radio,
    task: ClipboardList,
    "status-done": CircleCheck,
    "status-progress": Clock3,
    "status-blocked": Ban,
    "status-open": Circle,
  };
  const node = nodes[name] ?? Sparkles;
  const body = node.map(([tag, attrs]) => {
    const attrText = Object.entries(attrs)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => `${key}="${value}"`)
      .join(" ");
    return `<${tag} ${attrText}></${tag}>`;
  }).join("");
  return raw(`<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`);
}

export async function loadSidebarData(agentId: string): Promise<SidebarData> {
  const [agentRow] = await db
    .select({ name: agents.name, pairingCode: agents.pairingCode })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const contactRows = await db
    .select()
    .from(contacts)
    .where(or(eq(contacts.agentA, agentId), eq(contacts.agentB, agentId)))
    .limit(500);

  const contactIds = contactRows.map((r) => (r.agentA === agentId ? r.agentB : r.agentA));

  const recent = await db
    .select()
    .from(messages)
    .where(or(eq(messages.fromAgent, agentId), eq(messages.toAgent, agentId)))
    .orderBy(desc(messages.createdAt))
    .limit(100);

  const pendingCount = recent.filter((m) => m.toAgent === agentId && m.status === "pending").length;

  const nameIds = unique([agentId, ...contactIds, ...recent.flatMap((m) => [m.fromAgent, m.toAgent])]);
  const nameRows = nameIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name, owner: agents.owner }).from(agents).where(inArray(agents.id, nameIds))
    : [];
  const nameMap = new Map(nameRows.map((r) => [r.id, r]));
  const ownerOf = (id: string) => nameMap.get(id)?.owner ?? null;

  const sidebarContacts: SidebarContact[] = contactIds.map((id) => ({
    id,
    name: nameMap.get(id)?.name ?? id,
    owner: ownerOf(id),
    messageCount: recent.filter((m) => m.fromAgent === id || m.toAgent === id).length,
  }));

  const memberships = await db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.agentId, agentId))
    .limit(200);
  const roomIds = memberships.map((m) => m.roomId);

  const roomRows = roomIds.length > 0
    ? await db.select().from(rooms).where(inArray(rooms.id, roomIds)).limit(200)
    : [];
  const allRoomMembers = roomIds.length > 0
    ? await db.select().from(roomMembers).where(inArray(roomMembers.roomId, roomIds)).limit(2000)
    : [];
  const allRoomTasks = roomIds.length > 0
    ? await db.select().from(tasks).where(inArray(tasks.scope, roomIds.map((id) => `room:${id}`))).limit(500)
    : [];

  const sidebarRooms: SidebarRoom[] = roomRows.map((r) => ({
    id: r.id,
    name: r.name,
    memberCount: allRoomMembers.filter((m) => m.roomId === r.id).length,
    openTaskCount: allRoomTasks.filter((t) => t.scope === `room:${r.id}` && t.status !== "done").length,
  }));

  return {
    agentName: agentRow?.name ?? "agent",
    pairingCode: agentRow?.pairingCode ?? "",
    contacts: sidebarContacts,
    rooms: sidebarRooms,
    pendingCount,
  };
}

export function renderSidebar(data: SidebarData): Rendered {
  return html`
    <aside class="sidebar" aria-label="Navigation">
      <div class="brand-block">
        <a class="brand" href="/dashboard">${icon("spark")}<span>trunk</span></a>
        <div class="agent-name" title="${data.agentName}">${data.agentName}</div>
      </div>

      <nav class="sidebar-scroll" aria-label="Sections">
        <div class="sidebar-section">
          <div class="sidebar-label">Contacts</div>
          ${data.contacts.length === 0
            ? html`<div class="sidebar-empty">No contacts yet</div>`
            : data.contacts.map((ca) => html`
              <a class="sidebar-item" href="/dashboard" aria-label="${ca.name}">
                <span class="presence-dot" aria-hidden="true"></span>
                <span class="sidebar-main">${ca.name}</span>
                ${ca.messageCount > 0 ? html`<span class="count-badge">${ca.messageCount}</span>` : ""}
              </a>
            `)}
        </div>

        <div class="sidebar-section">
          <div class="sidebar-label">Rooms</div>
          ${data.rooms.length === 0
            ? html`<div class="sidebar-empty">No rooms yet</div>`
            : data.rooms.map((room) => {
              const active = room.id === data.activeRoomId;
              return html`
                <a class="sidebar-item room ${active ? "active" : ""}" href="/dashboard/room/${room.id}" aria-current="${active ? "page" : "false"}">
                  <span class="room-mark" aria-hidden="true">${icon("room")}</span>
                  <span class="sidebar-main">${room.name}</span>
                  ${room.openTaskCount > 0 ? html`<span class="count-badge warn">${room.openTaskCount}</span>` : ""}
                  <span class="sidebar-sub">${room.memberCount} agents</span>
                </a>
              `;
            })}
        </div>

        <div class="sidebar-section">
          <div class="sidebar-label">Views</div>
          <a class="sidebar-item ${data.activeNav === "feed" ? "active" : ""}" href="/dashboard" aria-current="${data.activeNav === "feed" ? "page" : "false"}">
            ${icon("feed")}<span class="sidebar-main">Feed</span>
          </a>
          <a class="sidebar-item ${data.activeNav === "inbox" ? "active" : ""}" href="/dashboard/inbox" aria-current="${data.activeNav === "inbox" ? "page" : "false"}">
            ${icon("inbox")}<span class="sidebar-main">Inbox</span>
            ${data.pendingCount > 0 ? html`<span class="count-badge accent">${data.pendingCount}</span>` : ""}
          </a>
          <a class="sidebar-item ${data.activeNav === "mission" ? "active" : ""}" href="/dashboard/gantt" aria-current="${data.activeNav === "mission" ? "page" : "false"}">
            ${icon("mission")}<span class="sidebar-main">Mission control</span>
          </a>
          <a class="sidebar-item" href="/inspector">
            ${icon("inspector")}<span class="sidebar-main">Inspector</span>
          </a>
          <a class="sidebar-item" href="/agents/me/card">
            ${icon("card")}<span class="sidebar-main">Agent card</span>
          </a>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-label">Pairing code</div>
        <a class="pairing-code" href="https://trunk.bot/connect/${data.pairingCode}" rel="noopener">${data.pairingCode}</a>
        <form method="POST" action="/dashboard/logout" class="signout-form">
          <button type="submit" class="signout-btn">${icon("signout")}<span>Sign out</span></button>
        </form>
      </div>
    </aside>`;
}

export function renderTopbar(opts: TopbarOptions): Rendered {
  return html`
    <header class="topbar">
      <div class="topbar-title">
        <div class="eyebrow">
          ${opts.eyebrow}
          ${opts.badge ? html`<span class="badge">${opts.badge}</span>` : ""}
          ${opts.live ? html`<span class="live-dot" aria-label="live"><span class="live-pulse"></span>live</span>` : ""}
        </div>
        <h1>${opts.title}</h1>
      </div>
      ${opts.stats && opts.stats.length > 0 ? html`
        <div class="health-strip">
          ${opts.stats.map((s) => html`
            <div class="stat">
              <span class="stat-label">${s.label}</span>
              <strong class="stat-value ${s.tone ?? ""}">${s.value}</strong>
            </div>
          `)}
        </div>
      ` : ""}
    </header>`;
}

export function emptyState(opts: { icon?: string; title: string; hint?: string }): Rendered {
  return html`
    <div class="empty-state">
      <div class="empty-icon">${opts.icon ? icon(opts.icon) : icon("spark")}</div>
      <div class="empty-title">${opts.title}</div>
      ${opts.hint ? html`<div class="empty-hint">${opts.hint}</div>` : ""}
    </div>`;
}

export function sectionLabel(text: string, trailing?: Rendered): Rendered {
  return html`<div class="section-label">${text}${trailing ?? ""}</div>`;
}

export function typePill(type: string): Rendered {
  return html`<span class="pill type">${type}</span>`;
}

export function finalityPill(finality: string): Rendered {
  return html`<span class="pill finality">${finality}</span>`;
}

export function urgencyPill(urgency: string): Rendered {
  return html`<span class="pill urgency">${urgency}</span>`;
}

export interface MessageBubbleOpts {
  from: string;
  fromId?: string;
  to?: string;
  toId?: string;
  type: string;
  content: string;
  context?: string;
  finality?: string;
  time: string;
  exactTime?: string;
  isMine: boolean;
  status?: string;
  threadLink?: string;
  messageId?: string;
  threadId?: string | null;
  recipientCount?: number;
  recipientLabel?: string;
}

export function messageBubble(opts: MessageBubbleOpts): Rendered {
  return html`
    <article class="chat-message ${opts.isMine ? "mine" : "theirs"}">
      <div class="avatar" aria-hidden="true">${initials(opts.from)}</div>
      <div class="bubble">
        <div class="message-heading">
          <strong>${opts.from}</strong>
          ${opts.to ? html`<span class="to">to ${opts.to}</span>` : ""}
          ${typePill(opts.type)}
          ${opts.finality ? finalityPill(opts.finality) : ""}
          ${opts.status ? html`<span class="pill status">${opts.status}</span>` : ""}
          ${opts.recipientCount && opts.recipientCount > 1 ? html`<span class="pill status">${opts.recipientCount} recipients</span>` : ""}
          ${opts.threadLink ? html`<a class="thread-link-inline" href="${opts.threadLink}">view thread →</a>` : ""}
          <time title="${opts.exactTime ?? opts.time}">${opts.time}</time>
        </div>
        <div class="message-meta">
          ${opts.fromId ? html`<span>from <code>${opts.fromId.slice(0, 8)}</code></span>` : ""}
          ${opts.toId ? html`<span>to <code>${opts.toId.slice(0, 8)}</code></span>` : ""}
          ${opts.threadId ? html`<span>thread <code>${opts.threadId.slice(0, 8)}</code></span>` : ""}
          ${opts.messageId ? html`<span>msg <code>${opts.messageId.slice(0, 8)}</code></span>` : ""}
          ${opts.recipientLabel ? html`<span>${opts.recipientLabel}</span>` : ""}
        </div>
        <div class="message-copy">${opts.content}</div>
        ${opts.context ? html`<div class="message-context">${opts.context}</div>` : ""}
      </div>
    </article>`;
}

export function taskRow(opts: {
  title: string;
  status: string;
  owner: string | null;
  priority?: string | null;
  blockedByCount?: number;
  hasDeps?: boolean;
  details?: string[];
  age: string;
}): Rendered {
  const tone = statusTone(opts.status);
  const pri = opts.priority === "critical" ? "!!!" : opts.priority === "high" ? "!!" : "";
  const blocked = opts.blockedByCount ?? 0;
  return html`
    <div class="task-row">
      <div class="task-row-head">
        <span class="task-icon ${tone}">${statusIcon(opts.status)}</span>
        <span class="task-title ${opts.status === "done" ? "done" : ""}">${opts.title}</span>
        ${pri ? html`<span class="task-pri">${pri}</span>` : ""}
      </div>
      <div class="task-meta">
        ${opts.owner ? html`<span class="owner">${opts.owner}</span>` : html`<span class="unassigned">unassigned</span>`}
        ${blocked > 0 ? html`<span class="blocked-by">blocked by ${blocked}</span>` : ""}
        ${opts.hasDeps && blocked === 0 ? html`<span class="deps-met">deps met</span>` : ""}
        <span class="age">${opts.age}</span>
      </div>
      ${opts.details && opts.details.length > 0 ? html`
        <div class="task-details">
          ${opts.details.map((detail) => html`<span>${detail}</span>`)}
        </div>
      ` : ""}
    </div>`;
}

export function moduleCard(opts: {
  name: string;
  counts: { active?: number; blocked?: number; queued?: number; done?: number };
  progressPct: number;
  rows: Rendered[];
}): Rendered {
  const c = opts.counts;
  return html`
    <div class="module-card">
      <div class="module-head">
        <div>
          <div class="module-name">${opts.name}</div>
          <div class="module-counts">
            ${c.active ? html`<span class="module-count active">${c.active} active</span>` : ""}
            ${c.blocked ? html`<span class="module-count blocked">${c.blocked} blocked</span>` : ""}
            ${c.queued ? html`<span class="module-count queued">${c.queued} open</span>` : ""}
            ${c.done ? html`<span class="module-count done">${c.done} done</span>` : ""}
          </div>
        </div>
        <div class="module-progress">
          <div class="mini-bar"><div class="mini-bar-fill" style="width:${opts.progressPct}%"></div></div>
          <span class="module-pct">${opts.progressPct}%</span>
        </div>
      </div>
      <div class="task-list">${opts.rows}</div>
    </div>`;
}

export function dashboardStyles(): string {
  return `
*,*::before,*::after { margin:0; padding:0; box-sizing:border-box; }
:root {
  color-scheme: dark;
  --bg:#0c0d0a;
  --surface:#10110d;
  --surface-2:#151611;
  --surface-3:#1a1b14;
  --border:#2a281f;
  --border-strong:#403d30;
  --text:#f4f1e8;
  --text-dim:#a49d8c;
  --text-faint:#6d6758;
  --accent:#d9ff66;
  --accent-dim:#b9d957;
  --accent-2:#7aa7ff;
  --good:#7ee787;
  --warn:#f0c050;
  --danger:#ff7d7b;
  --radius:6px;
  --radius-sm:4px;
  --focus:#7aa7ff;
  --sidebar-w:264px;
  --rail-w:332px;
  --font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, "Fira Code", monospace;
}
html,body { height:100%; }
body {
  font-family: var(--font);
  background:
    linear-gradient(rgba(244,241,232,0.018) 1px, transparent 1px),
    linear-gradient(90deg, rgba(244,241,232,0.018) 1px, transparent 1px),
    var(--bg);
  background-size: 48px 48px;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  font-size: 14px;
  line-height: 1.5;
}
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; }
.ic { width:16px; height:16px; flex:none; }
.mono { font-family: var(--mono); }

:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
:where(a, button, input, select, textarea, [tabindex]):focus:not(:focus-visible) { outline: none; }

::-webkit-scrollbar { width:10px; height:10px; }
::-webkit-scrollbar-thumb { background:#2a2b20; border-radius:8px; border:2px solid var(--bg); }
::-webkit-scrollbar-thumb:hover { background:#3a3b2e; }
::-webkit-scrollbar-track { background:transparent; }

.shell { display:grid; grid-template-columns: var(--sidebar-w) minmax(0,1fr); height:100vh; overflow:hidden; border-top:1px solid var(--border); }

.sidebar {
  display:flex; flex-direction:column; min-height:0;
  background: rgba(16,17,13,0.94);
  border-right: 1px solid var(--border);
}
.brand-block { padding: 19px 18px 16px; border-bottom: 1px solid var(--border); }
.brand { display:inline-flex; align-items:center; gap:8px; font-weight:800; font-size:16px; letter-spacing:0; color: var(--text); }
.brand .ic { color: var(--accent); width:14px; height:14px; }
.agent-name {
  margin-top:6px; font-size:13px; color: var(--text-dim);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.sidebar-scroll { flex:1; overflow-y:auto; padding:18px 12px 10px; display:flex; flex-direction:column; gap:20px; }
.sidebar-section { display:flex; flex-direction:column; gap:2px; }
.sidebar-label {
  color: var(--text-faint); font-size:11px; font-weight:700;
  text-transform:uppercase; letter-spacing:0.07em; padding: 0 8px 6px;
}
.sidebar-item {
  display:flex; align-items:center; gap:9px; min-height:32px;
  padding:7px 8px; border-radius: var(--radius-sm);
  color: var(--text-dim); font-size:13px; position:relative;
  border:1px solid transparent;
}
.sidebar-item:hover { background: #11120e; color: var(--text); border-color: var(--border); }
.sidebar-item.active { background: #151611; color: var(--text); border-color: var(--border-strong); }
.sidebar-item.active::before {
  content:""; position:absolute; left:-12px; top:7px; bottom:7px; width:3px;
  border-radius:0 3px 3px 0; background: var(--accent);
}
.sidebar-main { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sidebar-item.room { gap:6px; }
.room-mark { color: var(--text-faint); display:inline-flex; }
.room-mark .ic { width:14px; height:14px; }
.sidebar-item.active .room-mark { color: var(--accent-2); }
.sidebar-sub { grid-column:auto; color: var(--text-faint); font-size:11px; }
.count-badge {
  min-width:18px; height:18px; padding:0 5px; border-radius:4px;
  display:inline-flex; align-items:center; justify-content:center;
  font-size:11px; font-weight:600; color: var(--text-dim);
  background: var(--surface-3); border:1px solid var(--border);
}
.count-badge.warn { color: var(--warn); border-color: rgba(240,192,80,0.25); }
.count-badge.accent { color: var(--accent); border-color: rgba(217,255,102,0.25); }
.sidebar-empty { color: var(--text-faint); font-size:13px; padding:6px 8px; }
.presence-dot { width:7px; height:7px; border-radius:999px; background: var(--accent); box-shadow: 0 0 18px rgba(217,255,102,0.32); flex:none; }

.sidebar-footer { padding:14px 16px; border-top:1px solid var(--border); display:flex; flex-direction:column; gap:8px; }
.pairing-code {
  font-family: var(--mono); font-size:13px; color: var(--accent);
  letter-spacing:0.12em; padding:6px 8px; border-radius: var(--radius-sm);
  background: rgba(217,255,102,0.06); border:1px solid rgba(217,255,102,0.15);
  align-self:flex-start;
}
.pairing-code:hover { background: rgba(217,255,102,0.1); }
.signout-form { margin:0; }
.signout-btn {
  display:inline-flex; align-items:center; gap:7px; cursor:pointer;
  background:transparent; border:none; color: var(--text-faint);
  font-size:12px; padding:4px 2px; border-radius: var(--radius-sm);
}
.signout-btn:hover { color: var(--text-dim); }

.main { display:flex; flex-direction:column; min-width:0; min-height:0; }
.topbar {
  position:sticky; top:0; z-index:5; flex:none;
  display:flex; align-items:flex-end; justify-content:space-between; gap:16px;
  padding:20px 28px 18px; background: rgba(12,13,10,0.92);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-bottom:1px solid var(--border);
}
.topbar-title { min-width:0; }
.eyebrow {
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  color: var(--accent); font-size:11px; font-weight:800;
  text-transform:uppercase; letter-spacing:0.08em; margin-bottom:6px;
}
.badge {
  display:inline-flex; align-items:center; padding:2px 7px; border-radius:4px;
  font-size:10px; font-weight:600; letter-spacing:0.02em; text-transform:none;
  color: var(--text-dim); background: var(--surface-3); border:1px solid var(--border);
}
.live-dot { display:inline-flex; align-items:center; gap:5px; color: var(--good); text-transform:none; letter-spacing:0; font-weight:600; }
.live-pulse { width:6px; height:6px; border-radius:999px; background: var(--good); box-shadow:0 0 10px rgba(126,231,135,0.6); animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
h1 { font-size: clamp(22px, 2.8vw, 34px); line-height:1; letter-spacing:0; font-weight:900; }

.health-strip {
  display:flex; align-items:stretch; flex:none;
  border:1px solid var(--border); border-radius: 0; overflow:hidden;
  background: #10110d;
}
.stat { min-width:88px; padding:7px 12px; border-left:1px solid var(--border); }
.stat:first-child { border-left:none; }
.stat-label { display:block; color: var(--text-faint); font-size:10px; text-transform:uppercase; letter-spacing:0.06em; }
.stat-value { display:block; margin-top:3px; font-size:15px; font-weight:700; }
.stat-value.good { color: var(--good); }
.stat-value.danger { color: var(--danger); }
.stat-value.accent { color: var(--accent); }
.stat-value.muted { color: var(--text-dim); }

.main-body { flex:1; min-height:0; overflow-y:auto; background: rgba(12,13,10,0.58); }
.body-grid { display:grid; grid-template-columns: minmax(0,1fr) var(--rail-w); min-height:100%; }
.chat-stream { min-width:0; padding:28px; display:flex; flex-direction:column; gap:18px; }
.context-rail {
  border-left:1px solid var(--border); background: rgba(16,17,13,0.94);
  padding:28px 20px; display:flex; flex-direction:column; gap:18px;
}
.rail-card {
  border:1px solid var(--border); border-radius: 0; background: var(--surface-2);
  padding:15px; display:flex; flex-direction:column; gap:10px;
}
.rail-title { color: var(--text-faint); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.07em; }

.section-label {
  display:flex; align-items:center; justify-content:space-between; gap:8px;
  color: var(--text-faint); font-size:11px; font-weight:700;
  text-transform:uppercase; letter-spacing:0.07em; padding-bottom:2px;
}
.section-label a { color: var(--accent-2); font-weight:600; text-transform:none; letter-spacing:0; font-size:12px; }
.section-label a:hover { text-decoration: underline; }

.chat-message { display:grid; grid-template-columns:40px minmax(0,1fr); gap:12px; }
.avatar {
  width:40px; height:40px; border-radius: 6px;
  display:grid; place-items:center; flex:none;
  background: #151611; border:1px solid var(--border-strong);
  color: var(--accent); font-size:12px; font-weight:700;
}
.chat-message.theirs .avatar { color: var(--accent-2); }
.bubble {
  min-width:0; padding:13px 15px; border-radius: 0;
  background: #10110d; border:1px solid var(--border);
  box-shadow: 0 24px 80px rgba(0,0,0,0.18);
}
.chat-message.mine .bubble { border-left:3px solid var(--accent); }
.chat-message.theirs .bubble { border-left:3px solid var(--accent-2); }
.message-heading {
  display:flex; align-items:center; flex-wrap:wrap; gap:7px;
  color: var(--text-faint); font-size:12px; margin-bottom:7px;
}
.message-heading strong { color: var(--text); font-size:13px; font-weight:800; }
.message-heading .to { color: var(--text-faint); }
.message-heading time { margin-left:auto; color: var(--text-faint); font-size:11px; }
.thread-link-inline { color: var(--accent-2); font-size:11px; }
.thread-link-inline:hover { text-decoration: underline; }
.message-meta {
  display:flex; align-items:center; flex-wrap:wrap; gap:6px 10px;
  margin:-2px 0 8px; color: var(--text-faint); font-size:10px;
}
.message-meta code {
  color: var(--text-dim); font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size:10px; background:var(--surface-3); border:1px solid var(--border);
  border-radius:4px; padding:1px 4px;
}
.message-copy { color: var(--text); font-family: var(--mono); font-size:13px; line-height:1.58; white-space:pre-wrap; overflow-wrap:anywhere; }
.message-context {
  margin-top:8px; padding-left:10px; border-left:2px solid var(--border-strong);
  color: var(--text-dim); font-size:12px; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere;
}

.pill {
  display:inline-flex; align-items:center; padding:1px 7px; border-radius:4px;
  font-size:11px; font-weight:600; color: var(--text-dim);
  background: var(--surface-3); border:1px solid var(--border);
}
.pill.type { color: var(--accent-2); border-color: rgba(108,196,255,0.22); background: rgba(108,196,255,0.07); }
.pill.finality { color: var(--good); border-color: rgba(126,231,135,0.22); background: rgba(126,231,135,0.07); }
.pill.urgency { color: var(--danger); border-color: rgba(255,125,123,0.22); background: rgba(255,125,123,0.07); }
.pill.status { color: var(--text-faint); text-transform: capitalize; }

.pill-row { display:flex; flex-wrap:wrap; gap:6px; }
.member-pill {
  display:inline-flex; align-items:center; gap:6px; padding:4px 10px 4px 5px;
  border-radius:6px; background: var(--surface-2); border:1px solid var(--border);
  font-size:12px; color: var(--text-dim);
}
.member-pill .avatar { width:20px; height:20px; font-size:9px; border-radius:5px; }
.member-pill .role { color: var(--text-faint); font-size:10px; }

.empty-state {
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  text-align:center; gap:8px; padding:48px 24px;
  border:1px dashed var(--border-strong); border-radius: 0;
  background: #10110d;
}
.empty-icon { color: var(--text-faint); display:grid; place-items:center; width:40px; height:40px; border-radius: var(--radius-sm); background: var(--surface-2); border:1px solid var(--border); }
.empty-icon .ic { width:20px; height:20px; }
.empty-title { color: var(--text-dim); font-size:14px; font-weight:600; }
.empty-hint { color: var(--text-faint); font-size:12px; max-width:42ch; }
.empty-inline { color: var(--text-faint); font-size:13px; font-style:italic; padding:6px 2px; }

.inbox-tabs { display:flex; flex-wrap:wrap; gap:6px; }
.inbox-tab {
  padding:6px 13px; border-radius: 0; font-size:13px; font-weight:700;
  color: var(--text-dim); background: var(--surface-2); border:1px solid var(--border);
}
.inbox-tab:hover { color: var(--text); border-color: var(--border-strong); }
.inbox-tab.active { color: #0a0b08; background: var(--accent); border-color: var(--accent); font-weight:600; }

.inbox-card {
  border:1px solid var(--border); border-radius: 0; background: var(--surface-2);
  padding:13px 15px; display:flex; flex-direction:column; gap:8px;
}
.inbox-card:hover { border-color: var(--border-strong); }

.thread-msg { padding:14px 16px; border-bottom:1px solid var(--border); }
.thread-msg:last-child { border-bottom:none; }
.thread-msg.mine { border-left:3px solid var(--accent); }
.thread-msg.theirs { border-left:3px solid var(--accent-2); }
.thread-msg-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
.thread-msg-head strong { color: var(--text); font-size:13px; }
.thread-msg-head time { margin-left:auto; color: var(--text-faint); font-size:11px; }
.thread-msg-body { color: var(--text); font-size:14px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; }
.thread-msg-context { margin-top:8px; color: var(--text-dim); font-size:12px; font-style:italic; border-left:2px solid var(--border-strong); padding-left:10px; }
.thread-wrap { border:1px solid var(--border); border-radius: 0; background: var(--surface); overflow:hidden; }

.progress-track { height:5px; background: var(--surface-3); border-radius:999px; overflow:hidden; }
.progress-fill { height:100%; background: var(--good); border-radius:999px; transition: width 0.5s; }

.task-summary { display:flex; gap:12px; flex-wrap:wrap; font-size:12px; }
.task-summary .active { color: var(--accent); }
.task-summary .blocked { color: var(--danger); }
.task-summary .queued { color: var(--text-faint); }
.task-summary .done { color: var(--good); }

.module-card { border:1px solid var(--border); border-radius: 0; background: var(--surface-2); overflow:hidden; }
.module-head {
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:10px 14px; border-bottom:1px solid var(--border); background: var(--surface);
}
.module-name { font-size:12px; font-weight:700; color: var(--accent-2); text-transform:uppercase; letter-spacing:0.05em; }
.module-counts { display:flex; gap:7px; margin-top:4px; }
.module-count { font-size:11px; padding:1px 6px; border-radius: var(--radius-sm); }
.module-count.active { color: var(--accent); border:1px solid rgba(217,255,102,0.2); }
.module-count.blocked { color: var(--danger); border:1px solid rgba(255,125,123,0.2); }
.module-count.queued { color: var(--text-faint); border:1px solid var(--border); }
.module-count.done { color: var(--good); border:1px solid rgba(126,231,135,0.2); }
.module-progress { display:flex; align-items:center; gap:8px; }
.mini-bar { width:84px; height:4px; background: var(--surface-3); border-radius:999px; overflow:hidden; }
.mini-bar-fill { height:100%; background: var(--good); border-radius:999px; }
.module-pct { font-size:12px; color: var(--text-faint); min-width:2.5em; text-align:right; }
.task-list { padding:4px 0; }
.task-row { padding:8px 14px; border-bottom:1px solid var(--border); }
.task-row:last-child { border-bottom:none; }
.task-row:hover { background: rgba(255,255,255,0.018); }
.task-row-head { display:flex; align-items:center; gap:7px; }
.task-icon { display:inline-flex; min-width:14px; flex:none; color: var(--text-faint); }
.task-icon .ic { width:14px; height:14px; }
.task-icon.good { color: var(--good); }
.task-icon.accent { color: var(--accent); }
.task-icon.danger { color: var(--danger); }
.task-icon.muted { color: var(--text-faint); }
.task-title { flex:1; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.task-title.done { color: var(--text-faint); text-decoration: line-through; text-decoration-color: var(--border-strong); }
.task-pri { font-size:11px; color: var(--danger); font-weight:700; }
.task-meta { display:flex; gap:8px; font-size:11px; color: var(--text-faint); padding-left:18px; margin-top:3px; }
.task-meta .owner { color: var(--text-dim); }
.task-meta .blocked-by { color: var(--danger); }
.task-meta .deps-met { color: var(--good); }
.task-meta .age { margin-left:auto; }
.task-meta .unassigned { color: var(--warn); font-style:italic; }
.task-details { display:flex; flex-wrap:wrap; gap:6px; padding-left:18px; margin-top:6px; }
.task-details span { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color: var(--text-dim); border:1px solid var(--border); background: rgba(255,255,255,0.018); border-radius:6px; padding:3px 7px; }

.dag-card { border:1px solid var(--border); border-radius: 0; background: var(--surface-2); overflow:hidden; }
.dag-head {
  display:flex; align-items:center; justify-content:space-between; gap:10px;
  padding:9px 14px; border-bottom:1px solid var(--border); background: var(--surface);
}
.dag-head-label { font-size:12px; font-weight:700; color: var(--accent-2); text-transform:uppercase; letter-spacing:0.05em; }
.dag-head-label .dim { color: var(--text-faint); font-weight:400; text-transform:none; letter-spacing:0; margin-left:6px; }
.dag-controls { display:flex; align-items:center; gap:5px; }
.dag-zoom-label { font-size:11px; color: var(--text-faint); min-width:2.6em; text-align:right; }
.dag-btn {
  display:grid; place-items:center; cursor:pointer;
  border:1px solid var(--border); border-radius:5px; background: var(--surface-2); color: var(--text);
  font-size:13px; width:26px; height:26px;
}
.dag-btn:hover { border-color: var(--border-strong); }
.dag-btn.fit { width:auto; padding:0 8px; font-size:11px; color: var(--text-faint); }
.dag-viewport { height:560px; overflow:hidden; cursor:grab; position:relative; background:#080906; }
.dag-viewport:active { cursor:grabbing; }
.dag-inner { transform-origin:0 0; will-change:transform; }

.room-meta-row { font-size:13px; color: var(--text-dim); }
.room-meta-row .mono { color: var(--accent); }
.rail-list-item { display:flex; gap:8px; align-items:flex-start; padding:7px 0; border-bottom:1px solid var(--border); font-size:13px; }
.rail-list-item:last-child { border-bottom:none; }
.rail-list-item .mark { display:inline-flex; flex:none; margin-top:2px; color: var(--text-faint); }
.rail-list-item .mark .ic { width:14px; height:14px; }
.rail-list-item .mark.good { color: var(--good); }
.rail-list-item .mark.danger { color: var(--danger); }
.rail-list-item .text { flex:1; color: var(--text-dim); }
.rail-list-item .age { color: var(--text-faint); font-size:11px; white-space:nowrap; }
.rail-waiting { color: var(--text-faint); font-size:11px; margin-top:3px; }
.rail-ok { color: var(--good); font-size:13px; }

.mc-shell { padding:22px 24px; max-width:1400px; margin:0 auto; }
.mc-stats { display:flex; gap:0; align-items:stretch; border:1px solid var(--border); border-radius: 0; overflow:hidden; background: var(--surface); }
.mc-stat { padding:8px 16px; border-left:1px solid var(--border); text-align:center; min-width:88px; }
.mc-stat:first-child { border-left:none; }
.mc-stat-val { font-size:18px; font-weight:700; }
.mc-stat-lbl { font-size:11px; color: var(--text-faint); text-transform:uppercase; letter-spacing:0.06em; margin-top:2px; }
.mc-overall { padding:8px 16px; display:flex; flex-direction:column; justify-content:center; gap:5px; min-width:150px; border-left:1px solid var(--border); }
.mc-body { display:grid; grid-template-columns: minmax(0,1fr) 320px; gap:18px; margin-top:18px; }
.mc-modules { display:flex; flex-direction:column; gap:14px; align-content:start; }
.mc-sidebar-panels { display:flex; flex-direction:column; gap:14px; align-content:start; }
.mc-panel { border:1px solid var(--border); border-radius: 0; background: var(--surface-2); padding:14px; display:flex; flex-direction:column; gap:10px; }
.mc-panel-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color: var(--text-faint); }
.mc-agent-row { display:flex; align-items:center; gap:8px; font-size:13px; }
.mc-agent-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color: var(--text-dim); }
.mc-agent-stat { font-size:12px; min-width:1.4em; text-align:center; }
.mc-feed-item { display:flex; align-items:flex-start; gap:8px; padding:7px 0; border-bottom:1px solid var(--border); font-size:13px; }
.mc-feed-item:last-child { border-bottom:none; }
.mc-feed-icon { display:inline-flex; flex:none; margin-top:2px; }
.mc-feed-icon .ic { width:14px; height:14px; }
.mc-feed-text { flex:1; color: var(--text-dim); line-height:1.35; }
.mc-feed-text .agent { color: var(--accent-2); }
.mc-feed-text .group { color: var(--accent); }
.mc-feed-time { font-size:11px; color: var(--text-faint); white-space:nowrap; }

.stack { display:flex; flex-direction:column; gap:14px; }
.row-gap { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.spacer-top { margin-top:14px; }

.login-shell {
  min-height:100vh; display:grid; place-items:center; padding:24px;
  background:
    linear-gradient(rgba(244,241,232,0.024) 1px, transparent 1px),
    linear-gradient(90deg, rgba(244,241,232,0.024) 1px, transparent 1px),
    var(--bg);
  background-size: 48px 48px;
}
.login-card {
  width:100%; max-width:380px; display:flex; flex-direction:column; gap:12px;
  padding:28px; border-radius: 0; background: var(--surface-2);
  border:1px solid var(--border); box-shadow:0 24px 80px rgba(0,0,0,0.35);
}
.login-brand { font-weight:900; font-size:17px; letter-spacing:0; color: var(--text); }
.login-card h2 { font-size:20px; font-weight:900; letter-spacing:0; margin-top:4px; }
.login-sub { color: var(--text-dim); font-size:13px; line-height:1.45; margin-bottom:4px; }
.login-error {
  color: var(--danger); font-size:13px; padding:8px 10px; border-radius: var(--radius-sm);
  background: rgba(255,125,123,0.08); border:1px solid rgba(255,125,123,0.22);
}
.login-field { display:flex; flex-direction:column; gap:6px; }
.login-label { color: var(--text-faint); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.07em; }
.login-field input {
  width:100%; padding:10px 12px; font-size:14px; color: var(--text);
  background: #10110d; border:1px solid var(--border); border-radius: 0;
  font-family: var(--mono);
}
.login-field input::placeholder { color: var(--text-faint); }
.login-field input:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px rgba(217,255,102,0.12); }
.login-submit {
  margin-top:6px; padding:11px 14px; font-size:14px; font-weight:800; cursor:pointer;
  color: #111; background: var(--accent); border:1px solid var(--accent); border-radius: 6px;
}
.login-submit:hover { background: #e6ff8a; }

@media (max-width: 1080px) {
  :root { --rail-w: 300px; }
}
@media (max-width: 920px) {
  .shell { grid-template-columns: 1fr; height:auto; overflow:visible; }
  .sidebar { position:static; height:auto; border-right:none; border-bottom:1px solid var(--border); }
  .sidebar-scroll { flex-direction:row; flex-wrap:wrap; overflow:visible; }
  .sidebar-section { flex:1 1 160px; }
  .sidebar-footer { flex-direction:row; align-items:center; flex-wrap:wrap; }
  .signout-form { margin-left:auto; }
  .main { min-height:0; }
  .topbar { position:static; flex-direction:column; align-items:flex-start; }
  .body-grid { grid-template-columns: 1fr; }
  .context-rail { border-left:none; border-top:1px solid var(--border); }
  .mc-body { grid-template-columns: 1fr; }
}
@media (max-width: 620px) {
  .chat-stream, .context-rail, .topbar { padding-left:16px; padding-right:16px; }
  .health-strip { width:100%; display:grid; grid-template-columns: repeat(2,1fr); }
  .stat { min-width:0; border-left:none; border-top:1px solid var(--border); }
  .stat:nth-child(-n+2) { border-top:none; }
  .message-heading time { margin-left:0; }
  .chat-message { grid-template-columns: 1fr; }
  .avatar { display:none; }
}
@media (prefers-reduced-motion: reduce) {
  .live-pulse { animation: none; }
  * { transition: none !important; }
}
`;
}

export function documentShell(opts: {
  title: string;
  sidebar: Rendered;
  topbar: Rendered;
  body: Rendered;
  headExtra?: Rendered;
}): Rendered {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts.title}</title>
  <style>${raw(dashboardStyles())}</style>
  ${opts.headExtra ?? html``}
</head>
<body>
  <div class="shell">
    ${opts.sidebar}
    <main class="main">
      ${opts.topbar}
      <div class="main-body">${opts.body}</div>
    </main>
  </div>
</body>
</html>`;
}
