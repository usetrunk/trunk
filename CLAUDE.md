# Trunk

Agent-to-agent communication relay. Open source, MIT licensed.

## Repo layout

```
src/
  app.ts              — Hono app (routes mounted here)
  index.ts            — local dev server (node)
  db/schema.ts        — Drizzle schema (agents, contacts, messages, tasks, workspaces)
  db/index.ts         — database connection
  routes/             — API route handlers
    agents.ts         — registration, profile, secret rotation
    contacts.ts       — pairing (agent or workspace), listing, unpairing
    messages.ts       — send, inbox, thread, ack, reply, workspace fan-out
    tasks.ts          — shared tasks (contact, room, or workspace scoped)
    workspaces.ts     — create, join, leave, members
  lib/
    auth.ts           — bearer token middleware, secret hashing
    webhook.ts        — webhook delivery + push worker notification
    workspace.ts      — canMessage, getWorkspaceMembers, verifyWorkspaceAccess
    types.ts          — shared Hono type variables
  sdk/index.ts        — typed TrunkClient for API calls
  mcp/                — MCP server (Vercel, stateless)
api/index.ts          — Vercel function entry point
worker/               — Cloudflare Worker (push + MCP)
  src/index.ts        — DO + WebSocket + MCP endpoint
  src/mcp.ts          — MCP tools (proxies to Vercel API)
cli/                  — local stdio MCP server + notification daemon
  src/index.ts        — MCP server with WebSocket push
  src/daemon/         — OS notification daemon
tests/                — Vitest behavior tests
drizzle/              — migration files
```

## Development

```bash
docker compose up -d          # postgres
npm install
cp .env.example .env
npm run db:migrate
npm run dev                   # relay on :3111
```

## Testing

```bash
npm test                      # vitest run
```

**Every feature must ship with tests.** If you add an endpoint, add a test. If you fix a bug, add a regression test first, then fix.

Tests use the in-memory mock DB (see `tests/api.behavior.test.ts`) — no real Postgres needed. Test through the SDK client (`TrunkClient`) against the Hono app.

Pattern:
```typescript
const client = createClient(registered.secret);
const result = await client.send({ to: beta.agent_id, type: "question", payload: { content: "test" } });
expect(result.status).toBe("pending");
```

## Deploying

```bash
# Relay (Vercel)
vercel --prod

# Push worker (Cloudflare)
cd worker && npx wrangler deploy

# Both need DATABASE_URL, PUSH_WORKER_URL, PUSH_SECRET env vars
```

## Workspaces

Workspaces are identity groups for multi-agent teams. Members share contacts and can message each other without explicit pairing. External agents pair with the workspace code to reach all members.

- **Not rooms.** Rooms are project collaboration spaces. Workspaces are organizational boundaries.
- **One workspace per agent.** An agent must leave before joining another.
- **Fan-out messaging.** Send to `workspace:<id>` to deliver to all members.
- **Workspace-scoped tasks.** Use `workspace_id` when creating tasks for team visibility.
- **Contact resolution.** Contacts list merges direct contacts, workspace co-members, and workspace-paired externals.

## Multi-agent setup

Run multiple agents on the same machine using `TRUNK_PROFILE`:

```bash
# Terminal 1 (default profile → ~/.trunk/config.json)
claude

# Terminal 2 (named profile → ~/.trunk/config.frank2.json)
TRUNK_PROFILE=frank2 claude
```

Each profile gets its own registration, secret, and pairing code. To collaborate:

1. First agent creates a workspace: `trunk_workspace action=create name="Team"`
2. Second agent joins: `trunk_workspace action=join code="<pairing_code>"`
3. Both can now message each other and share tasks without explicit pairing.

## Rules

- **Tests with every change.** No PR without test coverage for new behavior.
- **Schema changes need migrations.** `npm run db:generate` then `npm run db:migrate` against Neon.
- **Self-messaging is allowed.** Don't add contact checks that block same-agent sends.
- **MCP tools exist in three places:** `cli/src/index.ts` (stdio), `worker/src/mcp.ts` (HTTP), `src/mcp/` (Vercel). Keep them in sync when adding new tools.
- **Conventional commits.** `feat:`, `fix:`, `test:`, `docs:`.
- **Never commit secrets.** No database URLs, API keys, or tokens in code, docs, or skills. Use `$ENV_VAR` placeholders. This is a public repo.
