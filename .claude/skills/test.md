---
name: test
description: How to write and run tests for Trunk
user_invocable: true
---

## Running tests

```bash
npm test          # or: npx vitest run
```

## Test infrastructure

Tests live in `tests/api.behavior.test.ts`. They use:

- **In-memory mock DB** — no Postgres needed. The mock implements select/insert/update/delete against arrays.
- **SDK client** — all tests go through `TrunkClient` calling `app.request()` directly (no HTTP server).
- **Mocked webhooks** — `deliverWebhook` and `notifyPushWorker` are vi.mocked.

## Writing a new test

```typescript
it("describes the behavior being tested", async () => {
  // Setup: register agents, pair them
  const { alpha, beta, alphaClient, betaClient } = await registerPair();
  await alphaClient.pair({ code: beta.pairing_code });

  // Act: perform the operation
  const result = await alphaClient.send({
    to: beta.agent_id,
    type: "question",
    payload: { content: "test" },
  });

  // Assert: verify the behavior
  expect(result.status).toBe("pending");
  const inbox = await betaClient.inbox();
  expect(inbox.messages).toHaveLength(1);
});
```

## Helpers

- `createClient(secret?)` — creates a TrunkClient that calls the Hono app directly
- `registerPair()` — registers two agents (alpha + beta) and returns their clients

## Rules

- Every new endpoint needs at least one happy-path and one error-case test
- Every bug fix needs a regression test BEFORE the fix
- Test behavior, not implementation — test through the SDK, not by inspecting DB state
- Keep tests fast — the full suite should run in under 1 second

## Adding mock support for new tables

If you add a new table to the schema, update the mock DB in the test file:
1. Add a type for the row (e.g., `TaskRow`)
2. Add the array to `testState`
3. Add insert/update logic to `InsertQuery`/`UpdateQuery`
4. Add the table name to `getTableName()`
5. Add column mappings to `columnToProperty`
