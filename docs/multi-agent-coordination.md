# Multi-Agent Coordination Guide

How to run multiple AI agents that coordinate with each other instead of routing everything through a human.

## The problem

By default, agents talk to their human operator. When multiple agents work on the same project, the human becomes a switchboard operator — relaying context, mediating conflicts, and manually sequencing work. This doesn't scale.

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

1. **Check Trunk first.** At the start of every session, check your inbox and the project room tasks before doing anything.

2. **Claim before working.** Before starting a task, check trunk_room_tasks to see if someone else claimed it. If unclaimed, update the task to in-progress with your agent ID. If claimed by another agent, pick a different task or message them to coordinate.

3. **Announce file edits.** Before editing files that other agents might touch, send a trunk_send to the workspace: "Starting work on src/routes/messages.ts and src/db/schema.ts — I'll broadcast when done." Wait 30 seconds for objections before proceeding.

4. **Broadcast completions.** When you finish a unit of work, send a trunk_send to the workspace with: what you changed, which files, test results, and any follow-up needed.

5. **Message agents, not the human.** If you need information from another agent, message them directly through trunk_send. Do NOT ask the human to relay. The human sets direction; agents coordinate execution.

6. **Resolve conflicts through Trunk.** If you discover another agent edited a file you need, message them to coordinate. Don't ask the human to mediate — propose a resolution directly.

7. **Check inbox between tasks.** After completing each task, check trunk_inbox before picking the next one. Another agent may have sent you a review request, blocker, or handoff.

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
  1. Checks room tasks, claims one
  2. Broadcasts "starting [task], touching [files]"
  3. Implements, commits, pushes
  4. Sends review request to reviewer agent
  5. Broadcasts "done with [task], PR #X"

Reviewer:
  1. Checks inbox for review requests
  2. Reviews code (reads diff, runs tests)
  3. Sends decision back to developer (approved / changes requested)
  4. If approved, notifies planner
```

### File locking protocol

Agents don't have real file locks. The protocol is announcement-based:

1. Before editing, broadcast: "I'm taking src/routes/messages.ts for the next 10 minutes"
2. Other agents check inbox before editing the same file
3. If conflict: the later agent messages the first agent to negotiate
4. When done, broadcast: "Released src/routes/messages.ts"

This works because agents check Trunk between tasks. It breaks if agents don't check — hence the CLAUDE.md rules.

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
Coordination check: before continuing, check whether anyone is waiting on you, update stale tasks, communicate blockers, and tell the room your next action. If coordination is unclear, improve it directly with the other agents.
```

This is not a manager, scheduler, or permission system. It is a low-context prompt pressure valve for long-running agent sessions that start drifting or go quiet after compaction.

### Task lifecycle through rooms

```
Task created (open, unowned)
       ↓
Agent claims (in-progress, owner set)
       ↓
Agent broadcasts "starting [task]"
       ↓
Agent works, pushes code
       ↓
Agent sends review request
       ↓
Reviewer approves
       ↓
Agent marks done, broadcasts completion
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

Agents that don't broadcast what they're doing will step on each other. Every task start and completion should be a workspace broadcast.

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
- **No file locking enforcement.** The protocol is convention-based, not enforced by tooling.
- **Inbox grows.** Long-running sessions accumulate messages. Agents should ack/process messages to keep inbox clean.
- **Session restarts lose context.** When an agent restarts, it needs to re-read Trunk inbox to catch up on what happened while it was down.

## Example CLAUDE.md for a multi-agent project

```markdown
# Project Alpha

## Trunk coordination

Workspace: XXXX1234
Project room: see .trunk file

Check your Trunk inbox at the start of every session.
Check room tasks before picking work.
Broadcast to the workspace when you start and finish tasks.
Message other agents directly — do not ask the human to relay.
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
