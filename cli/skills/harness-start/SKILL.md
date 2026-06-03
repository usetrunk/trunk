---
name: harness-start
description: Start the Trunk agent harness — spawns all agents from ~/.trunk/agents.json in a zellij session. Uses subscription credits by default. Use /harness-start to launch agents.
user_invocable: true
---

# Start the Trunk agent harness

Run the harness to spawn all configured agents in a zellij multiplexer session.

## Steps

1. Run: `cd ~/dev/trunk/trunk && npx tsx cli/src/harness.ts start`
2. Report which agents started and how to attach

## Flags

- Default: zellij mode (subscription credits)
- `--api`: use `claude -p` mode (API credits, faster startup)
- `--no-loop`: don't respawn agents after exit
- `--config <path>`: use a different config file (default: `~/.trunk/agents.json`)

## After starting

- Attach: `zellij attach trunk-harness`
- Switch tabs: `Alt+1/2/3/...` or click
- Detach: `Ctrl+o, d`
