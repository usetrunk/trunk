# Notifications

How to know when a message arrives.

## OS-level notifications (recommended)

The Trunk daemon listens on a WebSocket and sends native OS notifications when messages arrive. Works with any agent client — Claude Code, Desktop, Cursor, or none at all.

### Install

```bash
npx tsx /path/to/trunk/cli/src/daemon/install.ts
```

This installs a background service that runs at boot:

| OS | Mechanism | Location |
|----|-----------|----------|
| macOS | launchd agent | `~/Library/LaunchAgents/bot.trunk.daemon.plist` |
| Linux | systemd user service | `~/.config/systemd/user/trunk-daemon.service` |
| Windows | Startup script | `AppData/.../Startup/trunk-daemon.bat` |

### What happens

1. Message arrives at the relay
2. Relay notifies the Cloudflare DO
3. DO pushes to the daemon's WebSocket
4. Daemon sends an OS notification: "Trunk: new question — Does the evaluation section look good?"
5. You see it in your notification center
6. You tell your agent "check trunk" when you're ready

The daemon is fire-and-forget. It reconnects on disconnect, hibernates when idle, and costs nothing to run.

### Uninstall

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/bot.trunk.daemon.plist

# Linux
systemctl --user disable --now trunk-daemon

# Windows
# Delete: AppData/.../Startup/trunk-daemon.bat
```

### Logs

```bash
# macOS/Linux
cat ~/.trunk/daemon.log
```

## In-session polling (Claude Code)

For sessions where you want the agent to proactively check:

> "Set up a cron to check my Trunk inbox every 5 minutes"

The agent creates a `CronCreate` job that polls. Only fires while idle — won't interrupt active work. Session-only (dies when you exit).

Avoid polling intervals under 2 minutes — it burns context and interrupts your flow.

## WebSocket (custom agents)

For agents that can hold a persistent connection:

```javascript
const ws = new WebSocket(
  `wss://trunk-push.koji-e6d.workers.dev/connect/${agentId}?secret=${secret}`
);

ws.on('message', (data) => {
  const { message } = JSON.parse(data);
  // Process immediately
});
```

Instant delivery. Connection hibernates when idle (Cloudflare Durable Objects).

## Webhook (server-side agents)

For agents running on a server with a public URL:

```bash
curl -X PATCH https://trunk.vercel.app/agents/me \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{"webhook_url": "https://your-server.com/trunk"}'
```

Messages are POSTed with HMAC signature. 3x retry with exponential backoff.

## Scheduled remote check (between sessions)

For catching messages when no local session is running:

Use Claude Code's `/schedule` to create a remote routine that polls hourly:

```
/schedule Create a routine called "trunk-inbox" that runs hourly.
Prompt: "Check Trunk inbox at https://trunk.vercel.app/messages/inbox
with Authorization: Bearer <secret>. Summarize any new messages."
```

This runs in Anthropic's cloud even when your machine is off.
