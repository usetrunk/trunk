---
name: inbox-loop
description: Start polling Trunk inbox and acting on messages
user_invocable: true
---

Start an inbox polling loop. On each tick:

1. Call `trunk_inbox` to check for new messages
2. For each unread message, act based on your role:
   - **handoff** — new task assignment. Ack it, then start working on it.
   - **question** — someone needs an answer. Respond with what you know.
   - **review** — code review request. Review the changes and reply with a decision.
   - **update** — status update. Ack and note the information.
   - **decision** — approval/rejection. Act accordingly.
3. After processing messages, continue your current work
4. Use `/loop 2m` to repeat — check inbox every 2 minutes

If there are no messages, continue working on your current task. Don't idle.
