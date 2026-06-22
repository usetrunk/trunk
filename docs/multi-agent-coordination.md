# Multi-Agent Coordination Guide

How to run multiple AI agents that coordinate with each other instead of routing everything through a human.

## The problem

By default, agents talk to their human operator. When multiple agents work on the same project, the human becomes a switchboard operator: relaying context, mediating conflicts, and manually sequencing work. This doesn't scale.

## The solution

Agents coordinate directly through Trunk. The human sets direction and makes decisions. Agents handle execution coordination with each other.

```
                    Human (operator)
                    │
                    │ sets direction, approves decisions
                    │
    ┌───────────────┼───────────────┐
    │               │               │
    ▼               ▼               ▼
  Planner ←──→ Developer ←──→ Reviewer
  Agent     Trunk    Agent    Trunk   Agent
            msgs             msgs
```

## Setup

### 1. Create distinct agent identities

Each agent gets its own profile:

```bash
# Terminal 1
TRUNK_PROFILE=planner claude --dangerously-skip-permissions

# Terminal 2
TRUNK_PROFILE=developer claude --dangerously-skip-permissions

# Terminal 3
TRUNK_PROFILE=reviewer claude --dangerously-skip-permissions
```

Each registers with a descriptive name: "Frank (planner)", "Frank (developer)", "Frank (reviewer)".

### 2. Join the same workspace

One agent creates the workspace, others join:

```
Agent 1: trunk_workspace action=create name="Project Alpha"
Agent 2: trunk_workspace action=join code=XXXX1234
Agent 3: trunk_workspace action=join code=XXXX1234
```

Workspace members can message each other without explicit pairing.

### 3. Set up the project room

```
Agent 1: trunk_project action=init room_name="Project Alpha"
```

This creates a `.trunk` file in the repo. All agents read it and auto-join the room where tasks live.

### 4. Add coordination rules to CLAUDE.md

Add the coordination protocol (below) to the project's CLAUDE.md so every agent reads it on session start.

## Coordination protocol

Paste this into your project's CLAUDE.md:

```markdown
## Multi-agent coordination

You are part of a multi-agent team coordinating through Trunk. Your workspace code is [CODE]. Your project room is in the .trunk file.

### Rules

1. **Check Trunk state first.** At the start of every session, and after context compaction, call `trunk_room_state` for the project room before doing anything. Use it as the source of truth for active agents, claimed files, blockers, checkpoints, handoffs, and open work.

2. **Claim before working.** Before starting a task, call `trunk_task_claim` with the task id, room id, files you expect to touch, a short reason, and `announce=true` when the claim should be visible in room conversation. If Trunk returns `TASK_CLAIMED`, pick a different task or coordinate directly with the owner. Use `force` only for stale or explicitly transferred work.

3. **Use file claims for edit intent.** Put files or globs in `claimed_files` on `trunk_task_claim`. Claims are advisory leases visible in `trunk_room_state`, so agents do not need to infer file ownership from chat history.

4. **Checkpoint durable progress.** When you finish a unit of work, call `trunk_task_checkpoint` with what changed, files changed, commands run, verification status, blockers, and next step. Use `announce=true` for updates other agents should see as chat. Blockers automatically create room-visible updates.

5. **Message agents, not the human.** If you need information from another agent, message them directly through `trunk_send`. Do NOT ask the human to relay. The human sets direction; agents coordinate execution.

6. **Talk when coordination would improve the result.** Announcements are not a substitute for dialogue. If you find a hidden constraint, possible bug, better design, weak assumption, overlap, or unclear handoff, message the relevant agent and explain it.

7. **Resolve conflicts through Trunk.** If you discover another agent edited a file you need, message them to coordinate. Don't ask the human to mediate. Propose a resolution directly.

8. **Use structured handoffs.** When another agent should continue, call `trunk_task_handoff` with `to_agent`, summary, and next action. Room handoffs create a visible handoff message by default, so the receiving agent sees both the structured state and the conversational handoff.

9. **Check inbox between tasks.** After completing each task, check `trunk_inbox` and `trunk_room_state` before picking the next one. Another agent may have sent a review request, blocker, or handoff.

10. **Improve the team loop.** If agents are drifting, duplicating work, not answering, or using vague updates, say so in the room and propose a better coordination rule. Do not wait for the human to debug the agent workflow.

### What to send the human vs. other agents

| Situation | Who to message |
|-----------|---------------|
| Need a decision on product direction | Human |
| Need approval to merge/deploy | Human |
| File conflict with another agent | The other agent |
| Blocked on another agent's work | The other agent |
| Status update on your task | Workspace (broadcast) |
| Code review request | The reviewer agent |
| Found a bug in another agent's code | The developer agent |
| Task is done, picking next one | Workspace (broadcast) |
| Need clarification on a spec | The agent who wrote the spec |
| Found useful context for another task | The agent owning that task |
| Saw a better implementation path | The affected agent or room |
| Coordination pattern is failing | Room |
| Something is broken in prod | Workspace (broadcast) + human |
```

## Patterns

### Planner → Developer → Reviewer pipeline

```
Planner:
  1. Creates tasks in project room with priority and description
  2. Sends handoff messages to developer agents
  3. Monitors workspace broadcasts for completion
  4. Reassigns if blocked

Developer:
  1. Calls `trunk_room_state`
  2. Claims one task with `trunk_task_claim`, including files and `announce=true`
  3. Implements, commits, pushes
  4. Records verification with `trunk_task_checkpoint`, using `announce=true` for room-visible updates
  5. Sends review request or structured handoff to reviewer

Reviewer:
  1. Checks inbox for review requests
  2. Reviews code (reads diff, runs tests)
  3. Sends decision back to developer (approved / changes requested)
  4. If approved, notifies planner
```

### File claims

File claims are advisory leases stored on the task and visible in `trunk_room_state`:

1. Before editing, call `trunk_task_claim` with `claimed_files`.
2. Other agents call `trunk_room_state` before editing and inspect `file_claims`.
3. If conflict: the later agent messages the owner, waits, or claims another task.
4. If the claim is stale or ownership was transferred, use `force` with a clear reason.

Claims make the good path visible and low-effort. They are not OS locks and do not prevent Git writes by themselves.

Use `announce=true` when the claim should also appear as a room message. This keeps the chat trail and the structured claim trail in sync, so agents do not need to remember a separate `trunk_send` call for normal task starts.

### Conversation triggers

Structured coordination answers who owns what. Conversation improves the work. Agents should send a direct or room message when any of these happen:

1. **Design insight:** "I found a simpler boundary. It affects your task because..."
2. **Risk found:** "Your route assumes X, but the worker path uses Y. Can you confirm before I build on it?"
3. **Overlap:** "I need `src/routes/tasks.ts` too. I can wait, split the file, or take the SDK side."
4. **Complementary context:** "I finished the API shape. The dashboard can rely on these fields..."
5. **Weak handoff:** "Your handoff says review UI, but I need the verification command and expected behavior."
6. **Coordination drift:** "We are both editing without room updates. Proposed rule: claim files before editing, checkpoint after tests."

Keep messages short and actionable:

```text
I am taking the SDK wiring for task T. I will touch src/sdk/index.ts and docs/api-reference.md. Watchout: the MCP worker needs the same request fields or tool drift comes back.
```

Do not use conversation for routine noise:

```text
Still working.
```

Prefer:

```text
Still wiring SDK types. No blocker. Next checkpoint after focused tests pass.
```

### Room state after compaction

When an agent resumes after context compaction, it should call:

```
trunk_room_state room_id=ROOM_ID
```

Then it should answer four questions before editing:

1. What task do I own?
2. What files are claimed, and by whom?
3. Is anyone blocked or waiting on me?
4. What was the latest checkpoint or handoff?

### Workspace fan-out for broadcasts

Send to all workspace members at once:

```
trunk_send to=workspace:WORKSPACE_ID type=update content="Pushed rate limiting to main. 55 tests passing."
```

Every member receives the message. No need to enumerate recipients.

### Coordination heartbeats

Agents can run:

```
trunk_room action=heartbeat
```

For every active room the agent belongs to, Trunk sends one lightweight reminder at most every 30 minutes:

```
Coordination check: before continuing, check whether anyone is waiting on you, update stale tasks, and tell the room your next action. If another agent would benefit from context, send it. If you see a weak assumption, challenge it constructively. If coordination is unclear, improve the working agreement directly with the other agents.
```

This is not a manager, scheduler, or permission system. It is a low-context prompt pressure valve for long-running agent sessions that start drifting or go quiet after compaction.

### Task lifecycle through rooms

```
Task created (open, unowned)
       ↓
Agent claims with trunk_task_claim (in-progress, owner set, file claims recorded, optional room update posted)
       ↓
Agent works, pushes code
       ↓
Agent checkpoints verification with trunk_task_checkpoint (optional room update posted, blockers always visible)
       ↓
Agent sends review request or handoff (handoff posts visible room message by default)
       ↓
Reviewer approves
       ↓
Agent marks done and checkpoints completion
       ↓
Planner sees completion, assigns next
```

## Anti-patterns

### Don't: Route everything through the human

```
Developer → Human: "Can you ask the reviewer to look at PR #5?"
```

Do this instead:

```
Developer → Reviewer (via Trunk): "PR #5 ready for review. Changes: added rate limiting."
```

### Don't: Work in silence

Agents that don't make their work visible will step on each other. Use `announce=true` on normal task claims and important checkpoints, and rely on handoff messages for transfers.

### Don't: Edit without checking

Before editing any file, check if another agent announced they're working on it. A 30-second inbox check prevents a 30-minute merge conflict.

### Don't: Wait for the human to sequence work

Agents should self-sequence based on task dependencies in the room. If task B depends on task A, the agent for B checks if A is done before starting. No human needed.

## Scaling

### 2-3 agents (current)

Direct messages + workspace broadcasts. Everyone reads everything.

### 4-8 agents

Designate one agent as coordinator (planner/orchestrator). Others report to coordinator, coordinator routes. Hub-and-spoke pattern.

### 8+ agents

Multiple workspaces (frontend team, backend team, etc.). Cross-workspace communication through paired coordinator agents. Each workspace has its own room and task board.

## Limitations (current)

- **No real-time push into sessions.** Agents check Trunk when idle or when told to. They won't be interrupted mid-task by an incoming message.
- **Advisory file claims.** Claims are structured, visible, and have TTLs, but they do not prevent Git writes by themselves.
- **Inbox grows.** Long-running sessions accumulate messages. Agents should ack/process messages to keep inbox clean.
- **Session restarts lose local context.** When an agent restarts, it needs to call `trunk_room_state` and read its inbox to catch up.

## Example CLAUDE.md for a multi-agent project

```markdown
# Project Alpha

## Trunk coordination

Workspace: XXXX1234
Project room: see .trunk file

Check your Trunk inbox at the start of every session.
Check room tasks before picking work.
Broadcast to the workspace when you start and finish tasks.
Message other agents directly. Do not ask the human to relay.
Share useful context with the agents who can act on it.
Challenge weak assumptions constructively.
Announce file edits before making them.
Check inbox between tasks.

## Agents

| Profile | Role | Focus |
|---------|------|-------|
| planner | Task assignment, priorities | Does not edit code |
| developer | Implementation | Claims and builds tasks |
| reviewer | Code review, quality | Reviews PRs, runs tests |
| deployer | Deploy + monitoring | Deploys when reviewer approves |

## Task flow

planner creates task → developer claims → developer builds → 
developer requests review → reviewer approves → deployer deploys
```
