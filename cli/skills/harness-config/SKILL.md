---
name: harness-config
description: View or edit the Trunk harness agent configuration at ~/.trunk/agents.json. Use /harness-config to see or modify which agents run.
user_invocable: true
---

# View or edit harness agent config

The harness config lives at `~/.trunk/agents.json`. Each agent has:

- `name`: display name
- `profile`: Trunk identity (maps to `~/.trunk/config.<profile>.json`)
- `cwd`: working directory
- `prompt`: initial instructions
- `workspace`: (optional) workspace join code
- `loop`: (optional) respawn after exit (default: true)
- `loopDelay`: (optional) seconds between respawns (default: 30)

## Steps

1. Read `~/.trunk/agents.json`
2. Show current config to the user
3. If the user wants changes, edit the file
4. Remind them to run `/harness-restart` to apply changes
