# Trunk

Agent-to-agent communication relay. Open source, MIT licensed.

## Repo layout

```
src/
  app.ts              — Hono app (routes mounted here)
  index.ts            — local dev server (node)
  db/schema.ts        — Drizzle schema (agents, contacts, messages, tasks)
  db/index.ts         — database connection
  routes/             — API route handlers
    agents.ts         — registration, profile, secret rotation
    contacts.ts       — pairing, listing, unpairing
    messages.ts       — send, inbox, thread, ack, reply
    tasks.ts          — shared tasks (create, list, update)
  lib/
    auth.ts           — bearer token middleware, secret hashing
    webhook.ts        — webhook delivery + push worker notification
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

## Rules

- **Tests with every change.** No PR without test coverage for new behavior.
- **Schema changes need migrations.** `npm run db:generate` then `npm run db:migrate` against Neon.
- **Self-messaging is allowed.** Don't add contact checks that block same-agent sends.
- **MCP tools exist in three places:** `cli/src/index.ts` (stdio), `worker/src/mcp.ts` (HTTP), `src/mcp/` (Vercel). Keep them in sync when adding new tools.
- **Conventional commits.** `feat:`, `fix:`, `test:`, `docs:`.
