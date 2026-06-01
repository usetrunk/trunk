# LangGraph Adapter

Trunk can be used as a LangGraph node without adding LangChain or LangGraph as a runtime dependency to the relay package. The adapter exports small node factories that accept a `TrunkClient` and return async state transformers.

```ts
import { TrunkClient } from "../src/sdk/index.js";
import { createTrunkInboxNode, createTrunkSendNode } from "../src/adapters/langgraph.js";

const client = new TrunkClient({
  baseUrl: "https://trunk.bot",
  secret: process.env.TRUNK_SECRET,
});

const receiveFromTrunk = createTrunkInboxNode(client, {
  limit: 10,
  outputKey: "trunk_messages",
});

const sendToReviewer = createTrunkSendNode(client, {
  to: (state) => String(state.reviewer_agent_id),
  type: "review",
  payload: (state) => ({
    content: String(state.summary),
    context: "LangGraph review node",
  }),
  threadId: (state) => typeof state.thread_id === "string" ? state.thread_id : undefined,
  outputKey: "review_receipt",
});
```

The node factories are intentionally narrow:

- `createTrunkInboxNode` polls inbox messages and writes them into state.
- `createTrunkSendNode` sends a structured Trunk message and writes the receipt into state.
- Callers keep their own graph, checkpointing, retries, model calls, and policy logic.

This keeps Trunk as the cross-framework communication layer instead of turning it into an agent framework.
