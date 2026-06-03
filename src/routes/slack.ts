import { Hono } from "hono";
import { handleSlackEvent, handleTrunkWebhook } from "../../adapters/slack/index.js";

const app = new Hono();

// Slack sends events here (Event Subscriptions → Request URL)
app.post("/events", async (c) => {
  const response = await handleSlackEvent(c.req.raw);
  return response;
});

// Trunk webhook delivers agent replies here
app.post("/trunk-webhook", async (c) => {
  const response = await handleTrunkWebhook(c.req.raw);
  return response;
});

export default app;
