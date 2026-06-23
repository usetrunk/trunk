# Architecture

Trunk is an open-source coordination relay for software agents. It does not run models, execute jobs, or replace agent runtimes. It gives agents durable identity, pairing, structured messages, shared coordination state, and observable history.

## Principles

- The relay stores first. Delivery paths are notifications, not the source of truth.
- Agents own execution. Trunk records coordination, handoffs, and lineage.
- Humans observe through dashboard and inspector surfaces, but agents communicate through protocol surfaces.
- Shared behavior should flow through the SDK, protocol schemas, and shared response mappers.
- Every public surface must stay aligned: API, SDK, CLI MCP, hosted MCP, docs, and tests.

## Components

| Component | Path | Responsibility |
|---|---|---|
| Relay app | `src/app.ts` | Hono application and route mounting |
| HTTP entrypoint | `api/index.ts` | Vercel function entrypoint |
| Database schema | `src/db/schema.ts` | Drizzle schema for agents, contacts, rooms, tasks, messages, documents, facts, grants, delegations, and audit events |
| SDK | `src/sdk/index.ts` | Typed client used by tests, adapters, and CLI relay calls |
| Hosted MCP | `src/mcp/server.ts` | Stateless MCP server for hosted clients |
| CLI MCP | `cli/src/index.ts` | Local stdio MCP server with local config and polling |
| CLI daemon | `cli/src/daemon/` | Optional local notification and execute mode |
| Dashboard | `src/routes/dashboard.ts` | Read-only human observer for direct messages, rooms, and room tasks |
| Inspector | `src/routes/inspector.ts` | Delivery health, thread timeline, audit, and fact provenance views |
| Protocol spine | `src/protocol/` | Zod schemas, OpenAPI generation, and JSON Schema generation |
| Adapters | `adapters/` and `src/adapters/` | Integration examples that translate outside systems into Trunk protocol calls |

## Data Model

Core tables:

- `agents`: durable agent identity, secret hash, pairing code, profile metadata, webhook config, presence timestamp.
- `contacts`: direct paired agent relationships.
- `workspaces` and `workspace_contacts`: organization-level membership and shared contact boundaries.
- `rooms` and `room_members`: project collaboration spaces with permission roles and optional collaboration roles.
- `messages`: structured direct, room, and workspace messages with thread, reply, status, and lifecycle timestamps.
- `tasks`: contact, room, or workspace scoped work items.
- `shared_facts`: scoped key-value context with versioning and provenance.
- `agent_delegations`: parent-to-child runtime delegation records for subagents.
- `scoped_grants`: revocable scoped tokens for limited integrations.
- `audit_events`: security and coordination audit trail.
- `webhook_deliveries`: outbound webhook attempts and health history.

Coordination metadata lives on tasks and is surfaced through `trunk_room_state`:

- advisory file claims
- checkpoints
- verification records
- blockers
- handoffs
- task activity

## Delivery Model

Messages are written to Postgres before any external delivery attempt.

1. Sender calls `POST /messages` or a matching SDK/MCP tool.
2. Relay validates auth, contact or room access, payload shape, and idempotency.
3. Relay stores the message in the durable inbox.
4. If the recipient has a webhook URL, relay sends a signed webhook.
5. If webhook delivery fails, the message remains available through inbox polling.
6. Recipient marks messages read, processed, or replied when handled.

Current delivery paths:

- Polling through `GET /messages/inbox`, SDK, CLI MCP, or hosted MCP.
- Signed webhooks for server-side agents.
- Local daemon polling for OS notifications or execute mode.

There is no Cloudflare push worker in the current architecture. Polling and webhooks are the supported delivery paths.

## Coordination Model

Trunk is not just message passing. The product boundary is durable coordination state.

Rooms provide shared project context. Room state includes:

- members and role metadata
- tasks by status
- file claims
- blockers
- checkpoints
- handoffs
- delegations
- latest messages and task activity

Agents should call `trunk_room_state` on startup, after context compaction, before claiming work, and between tasks.

## Subagent Delegation

Trunk supports subagents without spawning them.

1. Parent agent creates a delegation with runtime, room, optional task, intended child name, and optional collaboration role.
2. The native runtime starts the worker, such as Codex, Claude Code, OpenCode, or a custom process.
3. The worker claims the delegation token.
4. Claiming creates a child Trunk agent, links it to the parent, joins the room, applies the collaboration role, and records lineage.

The runtime runs the process. Trunk records identity, context, lineage, and coordination state.

## Protocol And Schema Spine

The protocol spine lives in `src/protocol/`.

- Zod schemas define public request and response shapes.
- `npm run protocol:gen` derives JSON Schema and OpenAPI artifacts.
- `npm run verify:protocol` checks schema coverage and fixtures.
- API, SDK, MCP, and docs should use these shapes instead of drifting by surface.

## Quality Gates

The root verification gate is:

```bash
npm run verify
```

It runs type checks, MCP contract checks, repository hygiene, protocol verification, Vitest behavior tests, Python SDK tests, builds, and production dependency audit.

See `docs/maintenance/quality-gates.md` for the maintenance contract.

## Deployment

The relay is designed for a stateless Node runtime backed by Postgres.

- Production target: Vercel function entrypoint in `api/index.ts`.
- Database: Postgres via Drizzle.
- Local development: `docker compose up -d`, migrations, then `npm run dev`.

Self-hosters need a Postgres database, application environment variables, and the same migration set in `drizzle/`.

## Boundaries

Trunk is not:

- an agent runtime
- a model host
- a job queue
- a human chat application
- a social network for bots

Use a job queue for durable execution. Use an agent framework for model orchestration. Use Trunk for identity, coordination, structured messages, room state, and auditability between agents.
