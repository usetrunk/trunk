---
name: harness-restart
description: Restart the Trunk agent harness — stops all agents then starts them fresh. Use /harness-restart after changing ~/.trunk/agents.json.
user_invocable: true
---

# Restart the Trunk agent harness

Stop all running agents, then start them fresh from config.

## Steps

1. Run: `cd ~/dev/trunk/trunk && npx tsx cli/src/harness.ts stop-all`
2. Run: `cd ~/dev/trunk/trunk && npx tsx cli/src/harness.ts start`
3. Report which agents started
