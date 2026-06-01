---
name: deploy
description: Deploy Trunk relay, worker, and CLI changes
user_invocable: true
---

## Pre-deploy checklist

- [ ] `npm test` passes
- [ ] New endpoints have tests
- [ ] MCP tools updated in all three locations (cli, worker, vercel)
- [ ] Schema migrations generated and applied to Neon

## Deploy relay (Vercel)

```bash
cd ~/dev/trunk/trunk
vercel --prod
```

Env vars: `DATABASE_URL`, `PUSH_WORKER_URL`, `PUSH_SECRET`

## Deploy push worker (Cloudflare)

```bash
cd ~/dev/trunk/trunk/worker
npx wrangler deploy
```

Secrets: `PUSH_SECRET` (set via `npx wrangler secret put PUSH_SECRET`)

## Deploy schema changes

```bash
# Generate migration
npm run db:generate

# Apply to local docker
npm run db:migrate

# Apply to production Neon
DATABASE_URL="postgresql://neondb_owner:npg_TkLP2SzNey7U@ep-noisy-hall-apcd6gms-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require" npx drizzle-kit migrate
```

## CLI changes

CLI runs locally from source (`npx tsx cli/src/index.ts`). No deploy needed — users pick up changes on next session restart.

## Verify after deploy

```bash
curl -s https://trunk.vercel.app/              # relay health
curl -s https://trunk-push.koji-e6d.workers.dev/ # worker health
```
