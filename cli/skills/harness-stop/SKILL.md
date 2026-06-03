---
name: harness-stop
description: Stop the Trunk agent harness — kills all agents and the zellij session. Use /harness-stop to shut everything down.
user_invocable: true
---

# Stop the Trunk agent harness

Kill all running agents and the zellij session.

## Steps

1. Run: `cd ~/dev/trunk/trunk && npx tsx cli/src/harness.ts stop-all`
2. Confirm all agents stopped
