# Quality Gates

This repo has two product surfaces over the same relay behavior:

- API and SDK in `src/`
- local CLI and stdio MCP in `cli/`

The maintenance goal is one install, one verification command, and explicit contracts for behavior that appears on more than one surface.

## Required local gate

Run the full gate before merging code that changes runtime behavior:

```bash
npm run verify
```

`verify` runs:

- relay, CLI, and production-source hygiene type checks
- MCP surface contract checks
- repository hygiene checks
- API behavior tests
- Python SDK tests
- relay and CLI builds
- production dependency audit

CI runs the same command from the root workspace. Do not add separate package-specific CI steps unless they cover a new surface that is not reachable from root `npm run verify`.

## Workspace install model

Use the root `package-lock.json` as the only lockfile. The root package owns the workspace install for:

- `@usetrunk/relay`
- `@usetrunk/cli`

Do not add nested lockfiles under `cli/`. If dependency placement looks wrong, repair it from the root with `npm install` or `npm ci`, then verify with:

```bash
npm ls esbuild drizzle-kit tsup tsx vitest --all
```

The repo intentionally declares root `esbuild` so Vite and tsx share a version that satisfies their peer ranges. Older esbuild versions may remain nested under tools that require them.

## Repository hygiene

Run:

```bash
npm run verify:repo
```

The check fails when generated output or environment files are tracked, nested workspace lockfiles reappear, MCP proxy surfaces stop using the shared SDK transport, or bridge adapters hand-roll Trunk relay calls instead of using the shared SDK.

## MCP tool contract

MCP tools are registered on two surfaces:

- `src/mcp/server.ts`
- `cli/src/index.ts`

Every tool must be declared in `src/mcp/tool-manifest.ts`. Most tools are available on both surfaces. Surface-specific tools must be explicitly marked there.

Run:

```bash
npm run verify:mcp
```

The check fails when a tool is missing from a declared surface, registered on an undeclared surface, duplicated, or has a different top-level input schema across shared surfaces. CLI descriptions may mention local credential storage when that surface behaves differently.

When adding a tool:

1. Add the implementation on the required surfaces.
2. Add or update the entry in `src/mcp/tool-manifest.ts`.
3. Run `npm run verify:mcp`.
4. Add API or SDK behavior tests when the tool maps to relay behavior.

## Dependency audit policy

Production installs must stay clean:

```bash
npm run audit:prod
```

The full development audit currently reports moderate findings through `drizzle-kit@0.31.10`, specifically its deprecated `@esbuild-kit/esm-loader` path and nested esbuild dependency. The npm suggested fix downgrades `drizzle-kit` to `0.18.1`, which is not an acceptable maintenance fix for this repo.

Until Drizzle publishes a compatible version without that dependency path, treat this as tracked development-tool debt:

- keep `npm run audit:prod` as the hard CI gate
- do not downgrade Drizzle to clear the advisory
- review Drizzle releases when touching migrations or database tooling
- remove this exception once a current Drizzle release clears the full audit

## Regression rule

For bugs, add the failing regression test first, run it to confirm the failure, then fix the bug and run the full gate. Do not patch first and add a test after unless the issue is impossible to reproduce locally.
