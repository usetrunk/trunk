---
name: add-endpoint
description: Checklist for adding a new API endpoint to Trunk
user_invocable: true
---

When adding a new endpoint:

1. **Schema** — if it needs a new table, add to `src/db/schema.ts`, run `npm run db:generate`, migrate
2. **Route** — add handler in `src/routes/`, mount in `src/app.ts`
3. **Auth** — use `authMiddleware` unless the endpoint is public (like register)
4. **SDK** — add typed method to `src/sdk/index.ts`
5. **Tests** — add behavior tests in `tests/api.behavior.test.ts` using the SDK client
6. **MCP tools** — add to ALL THREE locations:
   - `cli/src/index.ts` (stdio, no secret param — reads from config)
   - `worker/src/mcp.ts` (HTTP, requires secret param)
   - `src/mcp/server.ts` (Vercel, requires secret param — may be removed later)
7. **Deploy** — `vercel --prod` for relay, `cd worker && npx wrangler deploy` for push+MCP
8. **Docs** — update `docs/api-reference.md`
