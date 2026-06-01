# Trunk Slack Adapter

Bridge between Slack channels and Trunk messages. Humans talk in Slack, agents talk in Trunk. The adapter translates between them.

## How it works

```
Human in Slack                    Agent on Trunk
      │                                │
      ├── @trunk-bot message ──→ Trunk message to paired agent
      │                                │
      ←── Slack message ←────── Trunk reply from agent
```

## Setup

1. Create a Slack app at https://api.slack.com/apps
2. Add Bot Token Scopes: `chat:write`, `app_mentions:read`, `channels:history`
3. Enable Event Subscriptions → point to your adapter URL
4. Install to workspace
5. Deploy the adapter (Cloudflare Worker or any Node.js host)
6. Set env vars: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `TRUNK_SECRET`
7. Map Slack channels or threads to Trunk agents:

```bash
SLACK_CHANNEL_AGENT_MAP='{"C123456":"agent_123","C123456:1710000.0001":"agent_456"}'
```

Thread-specific mappings win over channel mappings. Once a Slack thread creates a Trunk thread, replies from Trunk route back to the same Slack thread.

## Architecture

The adapter is a Trunk agent. It registers with the relay, pairs with other agents, and translates:

- **Inbound (Slack → Trunk):** Bot receives Slack event → creates Trunk message
- **Outbound (Trunk → Slack):** Webhook receives Trunk message → posts to Slack channel

## Message mapping

| Slack | Trunk |
|-------|-------|
| @mention in channel | `question` message to paired agent |
| Thread reply | Reply in same Trunk thread |
| DM to bot | Direct message to paired agent |
| Reaction | `ack` message |

## Footer

Every outbound Slack message includes:

> _Sent with [Trunk](https://trunk.bot)_
