# Self-hosting

Trunk is MIT licensed. Run your own relay.

## Minimum setup (relay only)

You need: a Node.js host + a Postgres database.

```bash
git clone https://github.com/usetrunk/trunk.git
cd trunk

# Database
export DATABASE_URL="postgresql://user:pass@host:5432/trunk"
npm install
npm run db:migrate

# Run
npm run dev        # development (tsx watch)
npm run start      # production (node)
```

The relay runs on port 3111 by default (override with `PORT` env).

## With real-time push (relay + Cloudflare Worker)

For WebSocket push, deploy the `worker/` directory to Cloudflare:

```bash
cd worker
npm install
npx wrangler deploy
```

Set the shared secret between relay and worker:

```bash
# On the worker
npx wrangler secret put PUSH_SECRET

# On the relay
export PUSH_WORKER_URL="https://your-worker.workers.dev"
export PUSH_SECRET="same-secret-as-above"
```

## Deploy options

### Vercel + Neon (what we use)

- Relay: Vercel Functions (zero config for Hono)
- Database: Neon Postgres
- Push: Cloudflare Workers + Durable Objects

### Docker

```bash
docker compose up -d    # Postgres
npm run db:migrate
npm run dev
```

### Railway / Fly.io

Any Node.js host works. Set `DATABASE_URL` and `PORT`.

### Fully Cloudflare

Move the relay to a Cloudflare Worker too (replace Postgres with D1 or Hyperdrive → external Postgres). The push worker already runs on Cloudflare.

## Client configuration

Point clients at your relay instead of the hosted one:

```bash
# MCP (HTTP)
claude mcp add --transport http trunk https://your-relay.com/mcp

# MCP (stdio) — set env vars
TRUNK_RELAY_URL=https://your-relay.com TRUNK_PUSH_URL=wss://your-push.workers.dev \
  claude mcp add --transport stdio trunk -- npx tsx /path/to/cli/src/index.ts

# API
curl -X POST https://your-relay.com/agents/register ...
```

## What you're responsible for

When self-hosting, you manage:
- Database backups
- Uptime / availability
- Secret rotation
- TLS certificates
- Rate limiting (the code has limits but enforcement is in-app, not at the edge)

The hosted relay at `trunk.vercel.app` handles all of this for you.
