import { db } from "../db/index.js";
import { agents, messages, webhookDeliveries } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { audit } from "./audit.js";
import { messageToJson } from "./response-shapes.js";
import { signTrunkWebhook } from "./verify-webhook.js";

export async function deliverWebhook(
  message: typeof messages.$inferSelect,
  recipient: typeof agents.$inferSelect
): Promise<boolean> {
  if (!recipient.webhookUrl) return false;

  const body = JSON.stringify({
    event: "message.received",
    message: messageToJson(message),
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Trunk-Message-Id": message.id,
  };

  if (recipient.webhookSecret) {
    headers["X-Trunk-Signature"] = await signTrunkWebhook(body, recipient.webhookSecret);
  }

  const delays = [0, 5000, 30000, 180000]; // immediate, 5s, 30s, 3min
  let lastHttpStatus: number | undefined;
  let lastError: string | undefined;
  let totalAttempts = 0;

  const start = Date.now();

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }

    totalAttempts++;

    try {
      const res = await fetch(recipient.webhookUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });

      lastHttpStatus = res.status;
      lastError = res.ok ? undefined : `HTTP ${res.status}`;

      if (res.ok) {
        await db
          .update(messages)
          .set({ status: "delivered" })
          .where(eq(messages.id, message.id));

        // Log successful delivery
        await db.insert(webhookDeliveries).values({
          agentId: recipient.id,
          messageId: message.id,
          url: recipient.webhookUrl,
          event: "message.received",
          success: 1,
          httpStatus: res.status,
          latencyMs: Date.now() - start,
          attempts: totalAttempts,
        });
        return true;
      }

      if (res.status === 429) {
        // Rate limited — continue retrying with backoff
        continue;
      }
      if (res.status >= 400 && res.status < 500) {
        // Client error — don't retry
        break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.constructor.name : "network_error";
      // Network error or timeout — retry
    }
  }

  await db
    .update(messages)
    .set({ status: "undelivered" })
    .where(eq(messages.id, message.id));

  // Log failed delivery
  await db.insert(webhookDeliveries).values({
    agentId: recipient.id,
    messageId: message.id,
    url: recipient.webhookUrl,
    event: "message.received",
    success: 0,
    httpStatus: lastHttpStatus ?? null,
    latencyMs: Date.now() - start,
    error: lastError ?? "all retries exhausted",
    attempts: totalAttempts,
  });

  await audit(message.fromAgent, "message.delivery_failed", "message", message.id, {
    to: message.toAgent,
    webhook_url_configured: Boolean(recipient.webhookUrl),
  });
  return false;
}
