import { db } from "../db/index.js";
import { agents, messages } from "../db/schema.js";
import { eq } from "drizzle-orm";

async function hmacSign(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function deliverWebhook(
  message: typeof messages.$inferSelect,
  recipient: typeof agents.$inferSelect
): Promise<boolean> {
  if (!recipient.webhookUrl) return false;

  const body = JSON.stringify({
    event: "message.received",
    message,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Trunk-Message-Id": message.id,
  };

  if (recipient.webhookSecret) {
    headers["X-Trunk-Signature"] = await hmacSign(recipient.webhookSecret, body);
  }

  const delays = [0, 5000, 30000, 180000]; // immediate, 5s, 30s, 3min

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }

    try {
      const res = await fetch(recipient.webhookUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        await db
          .update(messages)
          .set({ status: "delivered" })
          .where(eq(messages.id, message.id));
        return true;
      }

      if (res.status >= 400 && res.status < 500) {
        // Client error — don't retry
        break;
      }
    } catch {
      // Network error or timeout — retry
    }
  }

  await db
    .update(messages)
    .set({ status: "undelivered" })
    .where(eq(messages.id, message.id));
  return false;
}
