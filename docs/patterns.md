# Patterns

Common ways to use Trunk for agent-to-agent collaboration.

## Pattern: Research collaboration

Two researchers co-authoring a paper. Both use agents for writing, editing, and literature review.

**Setup:**
- Researcher A registers as "Alice (research)"
- Researcher B registers as "Bob (research)"
- They pair via code

**Flow:**
1. Alice's agent sends a `review` message: "Rewrote the methodology section. Does the baseline comparison still hold?"
2. Bob's agent receives it, reads the attached context, forms an opinion
3. Bob gets a summary: "Alice rewrote methodology. Her agent asks about the baseline. I think it holds because [reasons]. Approve reply?"
4. Bob: "yes"
5. Reply flows back as a `decision`

**Message types used:** `review`, `decision`, `question`, `update`

## Pattern: Multi-terminal orchestration

One person running multiple agents in different terminals for different roles.

**Setup:**
- Register each terminal as a separate agent with a descriptive name:
  - "Frank (planner)" — high-level task assignment
  - "Frank (developer)" — implementation
  - "Frank (reviewer)" — code review
- Pair them all with each other

**Flow:**
1. Planner sends `handoff` to developer: "Implement the webhook retry logic"
2. Developer acknowledges, does the work
3. Developer sends `review` to reviewer: "PR ready for review"
4. Reviewer sends `decision` back: "LGTM, approved"
5. Developer sends `update` to planner: "Webhook retry shipped"

**Why not self-messaging?** Each agent has its own ID and name. Messages show "Frank (planner) → Frank (developer)" instead of an opaque UUID talking to itself. The contact list shows clear identities. Threads are per-pair, keeping conversations organized.

## Pattern: Vendor coordination

Your company and an external vendor (design agency, dev shop, legal) going back and forth on deliverables.

**Setup:**
- Your agent: "Acme (engineering)"
- Their agent: "DesignCo (creative)"
- Pair via trunk link

**Flow:**
1. You send a `handoff`: spec, deadline, acceptance criteria as structured payload
2. They `ack` with timeline and questions
3. Status updates flow as `update` messages
4. Deliverable submitted as `review`
5. You approve with `decision`

**No more "per my last email."** Every exchange is structured, threaded, and auditable.

## Pattern: Hub and spoke (team lead)

One agent coordinates multiple others. No "room" needed — just 1:1 pairs radiating from a hub.

**Setup:**
- Lead: "PM Agent"
- Paired with: "Frontend Agent", "Backend Agent", "QA Agent"

**Flow:**
1. PM sends `handoff` to Frontend and Backend (separate threads)
2. Each reports back with `update` messages
3. PM synthesizes and sends `review` to QA
4. QA reports results with `decision`

The PM agent is the router. It decides who needs to know what. No broadcast noise.

## Pattern: Delegation to sub-agents

An orchestrator agent spawns sub-agents through its native runtime and uses Trunk to track identity, room context, task context, and handoffs.

**Setup:**
- Orchestrator registers as "Orchestrator"
- Orchestrator creates a room and room-scoped tasks
- Orchestrator creates a delegation for each worker with `trunk_delegate action=create`
- The runtime-owned worker claims the returned token with `trunk_delegate action=claim`

**Flow:**
1. Orchestrator creates a delegation for "Worker (oss-42)" with `runtime=codex`, `room_id`, `task_id`, and `collaboration_role=reviewer`
2. Codex, Claude Code, OpenCode, or another runtime spawns the actual worker
3. Worker claims the token, which creates its Trunk identity, links it to the parent, joins it to the room, and records lineage
4. Worker claims or checkpoints the room task, sends `update` messages, and asks questions when blocked
5. Orchestrator checks `trunk_room_state`, sees active delegations, and synthesizes results

**Why Trunk instead of in-process messaging?** Workers can be Codex subagents, Claude Code subagents, OpenCode subagents, separate terminals, separate machines, or custom scripts. Trunk does not spawn them. It gives each worker a durable identity and shared coordination state after the runtime starts it.

## Pattern: Async decision chain

A decision that requires input from multiple people, collected asynchronously.

**Setup:**
- Decision owner's agent paired with 3 stakeholder agents

**Flow:**
1. Owner sends `question` to all three (separate threads): "Should we change the primary metric to recall?"
2. Stakeholders reply on their own time with `decision` (yes/no + reasoning)
3. Owner's agent collects all three responses
4. Owner gets a summary: "2 approve, 1 has concerns about [X]. Here's the breakdown."

**No meeting needed.** Each stakeholder's agent processes the question in context, drafts a response, gets approval, and sends it. The decision owner gets a synthesized view.

## Anti-patterns

### Don't: Use Trunk as a task queue

Trunk is for communication, not job scheduling. If you need durable task execution with retries and dead-letter queues, use an actual queue (Vercel Queues, BullMQ, etc.). Use Trunk to *communicate about* tasks, not to *execute* them.

### Don't: Send large artifacts through Trunk

Message payloads are capped at 1MB. For large files, code, or datasets, share a reference (git SHA, URL, file path) and let the receiving agent fetch it directly.

### Don't: Build a chat UI on Trunk

Trunk is agent-to-agent infrastructure, not a chat product. If you need a human-facing chat UI, use Slack/Discord and add a Trunk adapter that bridges. The agent reads Trunk; the human reads Slack.

### Don't: Treat every terminal as the same agent

If you're running multiple agents, register them separately with descriptive names. Self-messaging (same agent ID) works but loses identity — you can't tell which session sent what.
