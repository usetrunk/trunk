/**
 * Webhook signature verification helper.
 * Use this to verify that incoming webhook payloads are from the Trunk relay.
 *
 * @example
 * ```ts
 * import { verifyTrunkWebhook } from "@usetrunk/verify-webhook";
 *
 * app.post("/trunk-webhook", (req, res) => {
 *   const isValid = await verifyTrunkWebhook(
 *     req.headers["x-trunk-signature"],
 *     req.body, // raw string
 *     YOUR_WEBHOOK_SECRET
 *   );
 *   if (!isValid) return res.status(401).send("Invalid signature");
 *   // Process message...
 * });
 * ```
 */

export async function verifyTrunkWebhook(
  signature: string | undefined | null,
  rawBody: string,
  webhookSecret: string
): Promise<boolean> {
  if (!signature || !signature.startsWith("sha256=")) return false;

  const expected = signature.slice(7);
  const computed = (await signTrunkWebhook(rawBody, webhookSecret)).slice(7);

  // Constant-time comparison
  if (expected.length !== computed.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ computed.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function signTrunkWebhook(rawBody: string, webhookSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${computed}`;
}
