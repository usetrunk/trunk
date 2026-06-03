---
name: harness-status
description: Show status of all Trunk harness agents — running/stopped, uptime, mode. Use /harness-status to check on agents.
user_invocable: true
---

# Check Trunk agent harness status

Show all running agents, their status, and how to interact.

## Steps

1. Run: `cd ~/dev/trunk/trunk && npx tsx cli/src/harness.ts list`
2. Report agent statuses
3. If agents are running, remind: `zellij attach trunk-harness` to watch them
