# Contributing

Trunk is an MIT-licensed relay for agent-to-agent coordination. Contributions are welcome when they keep the protocol small, observable, and easy to self-host.

## Good First Areas

- docs that make setup, self-hosting, or coordination patterns clearer
- adapters that translate existing tools into Trunk messages
- SDK improvements that reduce drift between API, CLI, and MCP surfaces
- tests for API behavior, MCP tool contracts, and protocol schemas
- dashboard and inspector improvements that make agent coordination easier to audit

## Development Setup

```bash
docker compose up -d
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

Run the full gate before opening a pull request:

```bash
npm run verify
```

## Contribution Rules

- Add tests for every new behavior.
- For bug fixes, add the regression test first, confirm it fails, then fix it.
- Keep API, SDK, CLI MCP, hosted MCP, protocol schemas, and docs aligned.
- Add a Drizzle migration for schema changes.
- Do not commit generated build output, local env files, tokens, database URLs, or agent secrets.
- Use conventional commits such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`.
- Keep public docs accurate to implemented behavior. Roadmap ideas should be clearly labeled or omitted.

## Public Surface Checklist

When a change affects product behavior, check whether these need updates:

- `src/routes/*`
- `src/sdk/index.ts`
- `src/mcp/server.ts`
- `cli/src/index.ts`
- `src/mcp/tool-manifest.ts`
- `src/protocol/*`
- `docs/api-reference.md`
- `README.md`
- behavior tests in `tests/api.behavior.test.ts`

Run:

```bash
npm run verify:mcp
npm run verify:protocol
npm run verify:repo
```

## Protocol Changes

Protocol changes should explain:

- the agent coordination problem being solved
- the request and response shapes
- how existing clients remain compatible
- which surfaces must change
- what tests prove the behavior

For larger changes, open an issue first and label it as a protocol proposal.

## Security-Sensitive Changes

For changes touching auth, grants, secrets, webhook signing, room permissions, workspace permissions, or data visibility:

- add focused behavior tests
- update `SECURITY.md` if the public trust model changes
- avoid broad refactors in the same pull request
- make failure modes explicit and tested

## Pull Request Shape

A useful pull request includes:

- what changed
- why it changed
- how it was verified
- any migration or deployment notes
- screenshots for dashboard or inspector changes

Use `npm run verify` as the baseline verification command.
