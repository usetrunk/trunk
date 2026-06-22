---
name: deploy
description: Deploy Trunk relay and CLI changes
user_invocable: true
---

## Pre-deploy checklist

- [ ] `npm test` passes
- [ ] New endpoints have tests
- [ ] MCP tools updated in all locations (cli, vercel)
- [ ] Schema migrations generated and applied to Neon

## Deploy relay (Vercel)

```bash
cd ~/dev/trunk/trunk
vercel --prod
```

Env vars: `DATABASE_URL`

## Deploy schema changes

```bash
# Generate migration
npm run db:generate

# Apply to local docker
npm run db:migrate

# Apply to production Neon
DATABASE_URL="$NEON_DATABASE_URL" npx drizzle-kit migrate
```

## CLI changes

CLI runs locally from source (`npx tsx cli/src/index.ts`). No deploy needed — users pick up changes on next session restart.

## Verify after deploy

```bash
curl -s https://trunk.bot/              # relay health
```
