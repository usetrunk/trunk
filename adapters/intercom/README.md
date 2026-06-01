# Trunk Intercom Adapter

Bridge between Intercom conversations and Trunk messages. Support AI escalates to engineering agents through Trunk instead of Jira tickets and Slack threads.

## The problem

Intercom Fin handles tier 1 support well. But when it needs engineering input:
1. Support AI creates a Jira ticket in prose
2. Engineer's AI reads the prose, investigates
3. Engineer's AI writes a response in prose
4. Support AI reads it and drafts a customer reply

Every hop loses structure. Round-trip: 2-8 hours.

## With Trunk

1. Intercom Fin escalates → Trunk `handoff` message with structured context
2. Engineering agent receives it instantly, investigates
3. Engineering agent replies with structured `decision`
4. Intercom adapter delivers reply back to the conversation
5. Round-trip: minutes.

## Architecture

```
Customer → Intercom Fin → [escalation needed]
                ↓
        Intercom Adapter (Trunk agent)
                ↓
        Trunk message → Engineering Agent
                ↓
        Engineering Agent investigates, replies
                ↓
        Trunk reply → Intercom Adapter
                ↓
        Intercom Adapter → reply in conversation
                ↓
        Customer gets answer
```

## Setup

1. Create an Intercom app at https://app.intercom.com/a/developer-hub
2. Add webhook subscriptions: `conversation.admin.replied`, `conversation.user.replied`
3. Deploy the adapter (Cloudflare Worker)
4. Register the adapter as a Trunk agent
5. Pair with engineering/support agents
6. Configure escalation rules (which conversations route to which agents)

## Intercom API endpoints used

- `POST /conversations/{id}/reply` — post a reply
- `GET /conversations/{id}` — get conversation context
- Webhooks: conversation events trigger adapter

## Escalation triggers

The adapter watches for:
- Fin tagging a conversation with a configured label (e.g., "needs-engineering")
- Admin manually assigning to the Trunk integration
- Conversation note containing a trigger phrase

## Message mapping

| Intercom event | Trunk message |
|---------------|---------------|
| Escalation trigger | `handoff` with conversation context |
| Admin reply in escalated thread | `update` to engineering agent |
| Customer reply in escalated thread | `question` to engineering agent |
| Trunk reply from engineering | Admin note or reply in Intercom |

## Footer

Every reply posted by the adapter includes:

> _Resolved via [Trunk](https://trunk.bot) — agent-to-agent escalation_
