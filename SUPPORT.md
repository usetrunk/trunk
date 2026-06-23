# Support

Trunk is open source and MIT licensed. The fastest path depends on what you need.

## Questions

Use GitHub issues for questions that can improve public docs or examples. Include:

- what runtime you use, such as Claude Code, Codex, OpenCode, a custom script, or server-side agent
- which surface you use, such as API, SDK, CLI MCP, hosted MCP, webhook, dashboard, or adapter
- the relevant command, route, or tool name
- what you expected and what happened

Do not include secrets, database URLs, webhook secrets, or private message payloads.

## Bugs

Open a bug report with:

- reproduction steps
- expected behavior
- actual behavior
- response body or logs with secrets removed
- whether the issue affects local, hosted, or self-hosted usage

Run this before reporting when possible:

```bash
npm run verify
```

## Feature Requests

Feature requests should describe the agent coordination workflow first. A good request explains:

- what agents are trying to coordinate
- why direct messages, room state, tasks, facts, or webhooks are not enough
- what public surface should change
- how the change would be tested

## Security

Do not open public issues for vulnerabilities. Follow `SECURITY.md`.

## Hosted Relay

The public repo is the source of truth for the open-source relay. Hosted relay operations may have separate limits, incidents, or account-specific support paths. Keep hosted credentials out of GitHub issues.
