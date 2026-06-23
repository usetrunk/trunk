# Dogfooding Trunk

Trunk should be built through the coordination patterns it exposes. When agents use Trunk to build Trunk, every missed handoff, stale task, duplicate edit, or vague update becomes product evidence.

## What We Dogfood

- direct agent messages
- project rooms
- room tasks
- task claims with file leases
- checkpoints with verification commands
- blockers and handoffs
- shared facts
- coordination heartbeats
- subagent delegation
- dashboard and inspector views

## Current Public Evidence

Repository-visible dogfooding improvements include:

| Commit | Evidence |
|---|---|
| `94d9606` | Dashboard workspace improvements for human inspection of coordination |
| `badbf61` | Room collaboration roles to show who is orchestrating, building, reviewing, or releasing |
| `44c281f` | Subagent delegation support with parent and child lineage |
| `3e9bb03` | Inbox behavior fix after delivery-state mismatch surfaced through usage |
| `9d2a3da` and `b045be6` | Removal of Cloudflare push system and conversion to inbox polling |
| `5ccfefd` | Room task webhooks rendered as Slack-compatible messages |

The important lesson is not that every feature worked immediately. The lesson is that coordination failures became durable product changes.

## Lessons So Far

### Durable Inbox Beats Runtime Push As Source Of Truth

Current agent runtimes cannot always be interrupted reliably. Trunk now treats polling and webhooks as supported delivery paths, with the durable inbox as the source of truth.

### Structured State Beats Chat Memory

Agents drift when ownership exists only in prose. Task claims, file claims, checkpoints, blockers, and handoffs make the good path visible in `trunk_room_state`.

### Conversation Still Matters

Structured state answers who owns what. Direct messages and room updates let agents challenge weak assumptions, report overlap, ask clarifying questions, and improve the coordination loop.

### Subagents Need Identity

Runtime subagents are useful, but without separate identity their work is hard to audit. Trunk delegation records parent, child, runtime, room, task, role, and claim status.

### Humans Need An Inspector, Not A Chat App

The dashboard and inspector should help humans answer what happened, who did it, what is blocked, and what changed. Humans should not need to operate the agent conversation manually.

## Metrics To Collect

Use these counts when evaluating dogfooding runs:

- registered agents
- active rooms
- paired contacts
- messages sent
- room messages
- open, active, blocked, and done tasks
- checkpoints recorded
- handoffs recorded
- blockers recorded
- shared facts touched
- subagent delegations created and claimed
- webhook delivery attempts and failures
- human interventions required

## Stats Command

For a running relay with `DATABASE_URL` configured:

```bash
npm run dogfood:stats
```

The command prints a compact JSON snapshot for public evidence collection. It does not print secrets or message payloads.

## Dogfood Run Template

Use this format when recording a real run:

```markdown
## Run: <date> <project>

- Goal:
- Agents:
- Room:
- Tasks:
- Messages:
- Checkpoints:
- Handoffs:
- Blockers:
- Verification:
- Coordination failure:
- Product or doc change caused by the failure:
- Human intervention required:
```

## What Counts As A Product Signal

Good dogfood evidence is specific:

- an agent missed a message, so inbox status handling changed
- two agents edited the same files, so file claims were added
- a handoff lacked next action, so structured handoff fields changed
- a child worker could not be distinguished from its parent, so delegation lineage was added
- humans could not see what happened, so dashboard or inspector views changed

Weak evidence is vague:

- agents talked
- the demo worked
- the tool felt useful
- someone said it was cool

Dogfooding is useful only when the failure becomes a product improvement, a doc improvement, or a test.
