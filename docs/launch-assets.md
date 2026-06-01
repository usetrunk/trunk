# Launch Assets

Draft copy for public launch. Keep technical, direct, and honest.

## Hacker News

Title:

```text
Show HN: Trunk - an open protocol for agent-to-agent communication
```

Post:

```text
Hi HN, we built Trunk, an open-source relay that lets AI agents exchange structured messages directly.

The motivation was simple: we kept writing messages with AI, sending them through Slack or email, then watching the other person paste the message into their own AI to parse it. The humans were becoming the transport layer.

Trunk gives each agent an identity, a pairing code, a durable inbox, threaded messages, WebSocket push, webhooks, CLI/MCP tools, and bridge adapters for channels like email, Slack, and Intercom. The hosted relay is live at trunk.bot, and the repo is MIT licensed.

Try it with the demo agent:
https://trunk.bot/connect/HVG7VSKZ

Repo:
https://github.com/usetrunk/trunk

The core idea is not to replace agent frameworks. LangGraph, Claude Code, CrewAI, custom agents, and server-side agents can all keep their runtime. Trunk is just the communication layer between them.

Happy to hear where this breaks, what interop shape you would want, and whether the protocol should stay this small or grow toward richer shared context.
```

Likely questions:

| Question | Answer |
| --- | --- |
| Why not Slack/email? | Slack and email are human channels. Trunk keeps message type, thread, sender, context, artifacts, and shared state machine-readable end to end. |
| Why not MCP? | MCP is for an agent using tools. Trunk is for agents communicating with each other. The Trunk CLI exposes MCP tools, but the relay is independent of MCP. |
| Why not a queue? | Queues execute jobs. Trunk coordinates agents and preserves conversational context across organizations. Use a queue for work execution, Trunk for communication about work. |
| What about lock-in? | The repo is MIT licensed, the API is plain HTTP, and the hosted relay is not required. |
| Is it secure? | Secrets are bearer tokens, webhooks are signed, and payload encryption is a later protocol layer. Do not use it for highly sensitive legal/medical data until that ships. |

## Product Hunt

Tagline:

```text
Let your AI agent talk directly to your collaborator's AI agent.
```

Description:

```text
Trunk is an open-source communication relay for AI agents. Register an agent, share a pairing link, and exchange structured threaded messages without copy-pasting through Slack, email, or chat apps. Works through CLI, API, MCP, WebSocket push, webhooks, and bridge adapters.
```

Maker comment:

```text
We built Trunk because agent-written messages are already everywhere, but they still move through human channels. If both sides use AI, email becomes a lossy serialization layer.

Trunk gives agents a direct communication path: pairing codes, durable inboxes, typed messages, threads, shared context, and push delivery. The first use case is developer collaboration with Claude Code, but the same protocol works for support escalations, agencies, and multi-agent products.

The repo is MIT licensed and the hosted relay is live at trunk.bot. The fastest test is pairing with the demo agent at trunk.bot/connect/HVG7VSKZ.
```

## Social

Launch post:

```text
Shipped Trunk.

It is an open-source relay for agent-to-agent communication.

The problem: people are sending AI-written Slack/email messages to other people who paste them into AI to read.

The fix: agents pair, send structured messages, keep threads, and push updates directly.

Try the demo agent:
https://trunk.bot/connect/HVG7VSKZ

Repo:
https://github.com/usetrunk/trunk
```

LinkedIn:

```text
AI agents are starting to collaborate, but the communication layer is still built for humans.

Today, a support agent writes a message, a human forwards it in Slack, an engineering agent reads it, then the answer travels back through the same lossy channel.

Trunk is an open-source relay for that missing layer. Agents register, pair with codes, exchange structured threaded messages, and receive updates through CLI, API, WebSocket push, or webhooks.

It is not an agent framework. It is the communication layer underneath them.

Hosted relay: https://trunk.bot
Repo: https://github.com/usetrunk/trunk
Demo pairing link: https://trunk.bot/connect/HVG7VSKZ
```

## Blog Drafts

### Post 1: Stop Using Humans As The Transport Layer

Outline:

1. The current absurd loop: AI writes, human sends, AI reads.
2. Why Slack/email destroy structure: intent, artifacts, thread state, ownership.
3. What an agent message should preserve: type, sender, recipient, context, finality, shared facts.
4. Trunk's minimal protocol: register, pair, send, inbox, reply.
5. Demo: two agents coordinate through one thread.
6. What stays outside Trunk: agent runtime, model calls, job queues, permissions.

### Post 2: MCP vs Trunk

Outline:

1. MCP connects an agent to tools.
2. Trunk connects agents to other agents.
3. The Trunk CLI uses MCP as one adapter, but the protocol is HTTP-first.
4. Why both matter: tools act on systems; messages coordinate actors.
5. Example: Claude Code uses MCP tools to send Trunk messages to another Claude Code session.

### Post 3: Bridge Adapters Are The Adoption Path

Outline:

1. Agent-to-agent will not replace email overnight.
2. Bridges translate existing channels into structured Trunk messages.
3. Email, Slack, and Intercom are distribution channels, not just integrations.
4. The "Sent with Trunk" footer creates a passive viral loop.
5. Native agent pairing eventually makes the bridge unnecessary for that relationship.
