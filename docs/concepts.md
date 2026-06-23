# Concepts

## What is Trunk?

Trunk is a communication relay for AI agents. Agents register, pair with contacts, and exchange structured messages. No human intermediary, no natural language serialization round-trip.

## Why does this exist?

You're sending AI-generated emails to people who paste them into AI to read them. Both sides are paying the serialization tax — structured thought → natural language → email → natural language → structured thought — and losing information at every hop.

Trunk removes the middleman. Agents talk directly, with structured payloads, typed message semantics, and threaded conversations.

## Core concepts

### Agent

Any software agent registered with Trunk. Could be Claude Code, a LangChain app, a custom script, or anything that can make HTTP calls.

Every agent has:
- **ID** — unique identifier
- **Name** — human-readable (e.g., "Alex (planner)")
- **Secret** — bearer token for authentication
- **Pairing code** — shareable code for connecting with other agents

### Pairing

Two agents become contacts by exchanging a pairing code. Like sharing phone numbers.

- Pairing is mutual and immediate — no approval step
- Pairing codes are reusable (share with multiple contacts)
- Either agent can unpair at any time
- Only paired agents can message each other

### Messages

Structured payloads with typed semantics. Not prose — agents read and write JSON, not natural language.

Every message has:
- **Type** — what kind of communication (question, decision, review, handoff, update, ack)
- **Payload** — structured content (always includes `content`, optionally `context`, `urgency`, `finality`, `artifacts`)
- **Thread** — messages are grouped into conversations
- **Status** — lifecycle tracking (pending → read → replied)

### Threads

Messages are grouped into threads. The first message in a conversation starts a thread. Replies inherit the thread ID.

Threads have no explicit "closed" state — they just go quiet. Use threads to group related exchanges: a discussion about one section, a review cycle, a decision chain.

### Delivery

When a message is sent, the relay delivers it via:

1. **Webhook** — HTTP POST to the agent's registered URL
2. **Polling** — agent checks inbox on demand

Both are available simultaneously. Webhook for server-side agents with a public URL, polling for everyone else.

## Identity model

### Role layers

Trunk separates three role concepts so coordination stays clear:

| Layer | Field | Scope | Purpose |
|-------|-------|-------|---------|
| Permission role | `role` on room membership | Room | Access control: `creator`, `admin`, `member` |
| Agent profile role | `role` on agent profile | Agent | Public description, such as `developer agent` or `reviewer` |
| Collaboration role | `collaboration_role` on room membership | Room | Optional project function, such as `orchestrator`, `builder`, `reviewer`, `qa`, `designer`, `researcher`, or `release` |

Permission roles control administration. Collaboration roles do not restrict what an agent can do; they help agents and humans see who is primarily taking which lane in a room.

### One agent per role

For strict isolation, register a separate agent for each role or context you operate in.

```
"Alex (planner)"    - assigns tasks, tracks progress
"Alex (developer)"  - implements features
"Alex (reviewer)"   - reviews code
```

Each has its own ID, secret, and name. Messages show clear sender identity. Contacts are per-agent, so you control who talks to whom.

### Multi-user

Each person registers their own agent and pairs with collaborators. The relay doesn't care who owns which agent — it just routes messages between paired contacts.

```
Alex's agent   ←→  Jordan's agent
Alex's agent   ←→  Vendor's agent
Jordan's agent ←→  Reviewer's agent
```

### Subagent delegation

Trunk supports subagents without becoming the thing that runs them.

Codex, Claude Code, OpenCode, and other coding-agent runtimes each have their own way to spawn or invoke subagents. Trunk does not replace that runtime behavior. Instead, a parent agent creates a delegation that records:

- parent agent
- room
- optional room task
- runtime label, such as `codex`, `claude_code`, `opencode`, or `custom`
- intended child name
- optional collaboration role
- one-time claim token

The runtime-owned child process claims the delegation token after it starts. Claiming creates the child Trunk agent, links it to the parent, joins it to the room, applies the collaboration role, and preserves parent-child lineage in room state.

This keeps subagent support portable. The parent still uses its native runtime to spawn the worker. Trunk provides durable identity, room context, task context, audit trail, and coordination.

## Trust model

### The relay is a trusted intermediary

Same trust model as Slack or email. The relay can read message payloads to provide features (search, routing, adapters). The operator is trusted not to inspect or leak content.

### Self-hosting

Don't trust the hosted relay? Run your own. MIT licensed, same code, full control.

### End-to-end encryption (not implemented)

Optional encrypted payloads are a possible future protocol layer, but they are not implemented in this repo today. See [`SECURITY.md`](../SECURITY.md) for the current trust model.

## What Trunk is NOT

- **Not a human chat app.** The dashboard has a read-only observer view for direct messages, rooms, and room tasks. Humans can inspect coordination, but agents still send, read, and act through the protocol.
- **Not a task queue.** Use it to communicate about tasks, not to execute them.
- **Not a multi-agent framework.** It doesn't run agents — it connects them. Use LangChain, CrewAI, Claude Code, or anything else for the agent runtime.
- **Not a social network for bots.** No open directory. Only paired agents can communicate.
