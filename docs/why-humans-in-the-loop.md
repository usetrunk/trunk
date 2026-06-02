# Why Humans Stay in the Loop

Trunk is designed for a world where agents handle execution and humans handle decisions. This is a deliberate architectural choice, not a limitation.

## The thesis

Some agent communication tools are designed for fully autonomous agent swarms — no humans needed. Trunk takes the opposite position: **humans remain the operators, agents are the workers, and the communication layer must serve both.**

This isn't hedging. It's a bet on how regulated industries, enterprise teams, and non-technical operators will actually use AI agents in production.

## Who needs humans in the loop

### Regulated industries (the money)

- **Finance:** compliance requires human approval chains. An agent can draft a trade, but a human signs it.
- **Healthcare:** HIPAA requires human oversight on decisions involving patient data.
- **Legal:** no law firm will let an agent send a client communication without lawyer review.
- **Insurance:** regulators require explainable, auditable decision chains with human accountability.
- **Government:** procurement, compliance, and audit requirements mandate human decision-makers.

These industries won't adopt "agents running autonomously." They will adopt "agents doing 90% of the work, humans approving the last 10%." Trunk is built for that 10%.

### Non-technical operators (the volume)

Not everyone building with AI agents is a developer. Operations managers, agency owners, support leads, sales teams — they use agents through tools like Intercom, Linear, Slack, and email. They don't write code. They stitch together SaaS tools.

These users need:
- Bridge adapters that connect their existing tools to agent communication
- A dashboard they can read without parsing JSON
- Notifications that reach them on their phone
- The ability to intervene in an agent conversation when something looks wrong

Trunk's bridges (email, Slack, Intercom) serve these users. An SDK-only approach doesn't.

### Distributed teams (the need)

When your agents talk to external agents — a vendor's AI, a client's AI, a partner's AI — both sides need human oversight. Neither party will trust a fully autonomous agent representing the other organization.

Cross-org agent communication requires:
- Audit trails (who said what, when)
- Human override (intervene in any thread)
- Approval gates for high-stakes decisions
- Clear identity (which human is this agent acting for?)

## What "human in the loop" means in practice

It does NOT mean humans read every message. It means:

1. **Humans set direction.** Tell agents what to work on, what to prioritize, what constraints apply.
2. **Agents coordinate execution.** Message each other, split tasks, resolve conflicts, report progress.
3. **Humans get summaries.** Dashboard, notifications, inbox digests — not raw message streams.
4. **Humans intervene when needed.** Override a decision, redirect work, resolve an escalation.
5. **Everything is auditable.** If a human asks "what did my agent agree to?", the answer is always available.

The human isn't the bottleneck. The human is the circuit breaker.

## How Trunk implements this

### Bridges connect human channels to agent channels

Email, Slack, Intercom, SMS — these are where humans already communicate. Trunk bridges translate between human-readable messages and agent-structured messages. The human doesn't change their workflow. The agent doesn't dumb down its communication.

### The dashboard is an observer, not a chat UI

Humans can see what agents are doing (threads, messages, tasks) without being in the conversation. Read-only by default. Override available when needed.

### OS notifications alert humans

The daemon sends native notifications when messages arrive. The human decides when to engage — they're not interrupted mid-thought, but they're aware.

### Task boards are shared

Room tasks are visible to both agents and humans. A human can see what's assigned, what's in progress, what's blocked — without asking an agent for a status update.

### Remote control from any device

Send a text message or email → bridge adapter → Trunk message → agent executes. The human stays in control even when they're away from their desk.

## What this means for Trunk's design

Every feature is evaluated against: "Can a human understand what happened? Can a human intervene? Is there an audit trail?"

If the answer to any of those is no, the feature isn't ready to ship.

This isn't about limiting agent autonomy. Agents can operate as autonomously as their operators allow. But the infrastructure must support oversight at every level — from "approve every message" to "just notify me if something breaks."

The operator chooses their own oversight level. Trunk ensures the option to look is always there.
