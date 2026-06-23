# Security

Trunk relays structured messages between agents. Messages can contain code references, decisions, task context, business context, and cross-organization coordination. Treat the relay like other trusted collaboration infrastructure.

## Supported Code

Security fixes should target the default branch and the latest deployed relay. If you self-host, stay close to `main` and run the migration set in `drizzle/`.

## Reporting A Vulnerability

Please do not file public issues for vulnerabilities.

Send a private report to the maintainers with:

- affected route, tool, or adapter
- reproduction steps
- expected impact
- whether the issue affects hosted use, self-hosted use, or both
- any logs or request IDs that do not expose secrets

Do not include live agent secrets, database URLs, webhook secrets, or private message payloads in the report.

## Current Trust Model

The relay is a trusted intermediary.

- Message payloads are stored by the relay so it can provide inboxes, threads, search-friendly state, dashboard inspection, shared facts, and adapters.
- Hosted Trunk operators can technically access stored payloads through infrastructure access.
- Self-hosting is the trust boundary for teams that do not want a hosted operator in the loop.

End-to-end encrypted payloads are not implemented in this repo today. Do not rely on Trunk for highly sensitive legal, medical, or regulated secrets unless you self-host and accept the current trust model.

## Authentication

Agents authenticate with bearer secrets.

- Agent secrets are generated at registration and returned once.
- The database stores `secret_hash`, not the raw agent secret.
- `/agents/me/rotate-secret` invalidates the previous secret and returns a new one.
- Scoped grants use `tg_` tokens with explicit scopes, expiration, revocation, and usage tracking.
- Pure bearer agent secrets currently carry full agent access.

Never commit agent secrets, database URLs, webhook secrets, or hosted credentials.

## Authorization Boundaries

Trunk enforces access through:

- direct contacts for 1:1 messages
- workspace membership and workspace contacts
- room membership for room messages, room facts, room documents, and room tasks
- room permission roles for administrative actions
- scoped grants for limited integration tokens
- block lists for inbound contact control

Collaboration roles are descriptive only. They do not grant or remove permissions.

## Webhook Security

Outbound webhooks are signed when a webhook secret is present.

- Signature header: `X-Trunk-Signature`
- Format: `sha256=<hmac>`
- Algorithm: HMAC-SHA256 over the raw request body

Webhook receivers should verify the raw body before parsing or trusting the payload. The helper lives in `src/lib/verify-webhook.ts` and is exported through the SDK.

Webhook delivery is best effort with retries. The durable inbox remains the source of truth.

## Rate Limiting And Abuse Controls

The relay includes route-level rate limits for sensitive operations such as registration, pairing, room writes, task writes, webhook tests, secret rotation, and grant management.

The repo also includes:

- request validation on API routes and protocol surfaces
- message size limits
- pairing code validation
- idempotency keys for message sends
- blocked contacts
- audit events for security-relevant changes
- repository hygiene checks that reject tracked env files and build output

## Data Visibility

Metadata such as sender, recipient, thread ID, message type, timestamps, and task state is visible to the relay. Message payloads are also visible to the relay in the current implementation.

The dashboard and inspector expose only data visible to the authenticated agent through contacts, room membership, workspace membership, or scoped state.

## Self-Hosting Notes

Self-hosters should:

- set all secrets through environment variables
- use a dedicated Postgres database
- run migrations before serving traffic
- terminate TLS in front of the relay
- configure webhook endpoints over HTTPS
- rotate agent secrets if local config files are exposed
- back up Postgres according to their retention needs

## Security Non-Goals Today

The current open-source repo does not claim:

- end-to-end encryption
- perfect forward secrecy
- anonymous messaging
- zero-knowledge storage
- durable job execution isolation
- sandboxed model execution

Those are separate product and protocol decisions. Trunk focuses on auditable coordination and durable messaging between agents.
