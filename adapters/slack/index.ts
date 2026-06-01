/**
 * Trunk Slack Adapter
 *
 * Bridges Slack channels ↔ Trunk messages.
 * Deploy as a Cloudflare Worker, Vercel Function, or any Node.js server.
 *
 * Required env vars:
 * - SLACK_BOT_TOKEN: xoxb-... bot token
 * - SLACK_SIGNING_SECRET: Slack app signing secret
 * - TRUNK_AGENT_SECRET: Trunk agent secret for the adapter agent
 * - TRUNK_RELAY_URL: https://trunk.bot (default)
 */

const TRUNK_RELAY = process.env.TRUNK_RELAY_URL || "https://trunk.bot";
const TRUNK_SECRET = process.env.TRUNK_AGENT_SECRET || "";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_SIGNING = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_CHANNEL_AGENT_MAP = parseJsonMap(process.env.SLACK_CHANNEL_AGENT_MAP);

const slackToTrunkThread = new Map<string, string>();
const trunkToSlackThread = new Map<string, { channel: string; threadTs: string }>();

// --- Trunk API helpers ---

async function trunkSend(to: string, type: string, content: string, threadId?: string) {
  const res = await fetch(`${TRUNK_RELAY}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TRUNK_SECRET}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      to,
      type,
      payload: { content, source: "slack" },
      thread_id: threadId,
    }),
  });
  if (!res.ok) return null;
  return res.json() as Promise<{ id: string; thread_id: string; status: string }>;
}

async function trunkInbox() {
  const res = await fetch(`${TRUNK_RELAY}/messages/inbox`, {
    headers: { "Authorization": `Bearer ${TRUNK_SECRET}` },
  });
  return res.json() as Promise<{ messages: Array<{ id: string; payload: Record<string, unknown>; threadId: string }> }>;
}

async function trunkAck(messageId: string) {
  return fetch(`${TRUNK_RELAY}/messages/${messageId}/ack`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TRUNK_SECRET}` },
  });
}

// --- Slack API helpers ---

async function slackPost(channel: string, text: string, threadTs?: string) {
  return fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SLACK_TOKEN}`,
    },
    body: JSON.stringify({
      channel,
      text: `${text}\n\n_Sent with <https://trunk.bot|Trunk>_`,
      thread_ts: threadTs,
    }),
  });
}

async function verifySlackRequest(
  body: string,
  timestamp: string,
  signature: string
): Promise<boolean> {
  const baseString = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SLACK_SIGNING),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
  const computed = `v0=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  // Constant-time comparison
  if (computed.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

// --- Request handler ---

export async function handleSlackEvent(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const timestamp = request.headers.get("X-Slack-Request-Timestamp") || "";
  const signature = request.headers.get("X-Slack-Signature") || "";

  // Verify request is from Slack
  if (!await verifySlackRequest(rawBody, timestamp, signature)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = JSON.parse(rawBody);

  // URL verification challenge
  if (event.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: event.challenge }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Handle app_mention events
  if (event.event?.type === "app_mention") {
    const text = event.event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    const channel = event.event.channel;
    const threadTs = event.event.thread_ts || event.event.ts;
    const slackThreadKey = slackKey(channel, threadTs);

    const targetAgent = resolveSlackTarget(channel, threadTs);

    if (targetAgent) {
      const existingThread = slackToTrunkThread.get(slackThreadKey);
      const receipt = await trunkSend(targetAgent, "question", text, existingThread);
      if (receipt) {
        slackToTrunkThread.set(slackThreadKey, receipt.thread_id);
        trunkToSlackThread.set(receipt.thread_id, { channel, threadTs });
      }
    }

    return new Response("ok");
  }

  return new Response("ok");
}

// --- Trunk → Slack delivery (webhook handler) ---

export async function handleTrunkWebhook(request: Request): Promise<Response> {
  const body = await request.json() as {
    event: string;
    message: { id: string; payload: { content?: string }; threadId: string };
  };

  if (body.event === "message.received") {
    const content = body.message.payload.content || "(no content)";
    const destination = trunkToSlackThread.get(body.message.threadId);

    if (destination) {
      await slackPost(destination.channel, content, destination.threadTs);
      await trunkAck(body.message.id);
    }
  }

  return new Response("ok");
}

export function resolveSlackTarget(
  channel: string,
  threadTs?: string,
  channelMap: Record<string, string> = SLACK_CHANNEL_AGENT_MAP
): string {
  if (threadTs) {
    const threadTarget = channelMap[slackKey(channel, threadTs)];
    if (threadTarget) return threadTarget;
  }
  return channelMap[channel] || "";
}

function slackKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

function parseJsonMap(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
}
