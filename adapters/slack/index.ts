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
 *
 * Outbound Slack channel is resolved per-conversation (Slack origin stamped in the
 * message payload) then per-room (room.metadata.slack.channel, set by the room
 * owner via PATCH /rooms/:id). There is no global/default channel.
 */

import { TrunkApiError, TrunkClient } from "../../src/sdk/index.js";

const TRUNK_RELAY = process.env.TRUNK_RELAY_URL || "https://trunk.bot";
const TRUNK_SECRET = process.env.TRUNK_AGENT_SECRET || "";
const TRUNK_WEBHOOK_SECRET = process.env.TRUNK_WEBHOOK_SECRET || "";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_SIGNING = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_CHANNEL_AGENT_MAP = parseJsonMap(process.env.SLACK_CHANNEL_AGENT_MAP);

// In-memory caches — a fast path only. The durable source of truth is the Slack
// origin stamped into each inbound message's payload (see resolveSlackDestination),
// so routing survives serverless cold starts that wipe these maps.
const slackToTrunkThread = new Map<string, string>();
const trunkToSlackThread = new Map<string, { channel: string; threadTs?: string }>();

// Per-room Slack channel, resolved from the room's owner-set metadata
// (room.metadata.slack.channel) and cached briefly. This is the source of truth
// for where a room's outbound messages post — no global default.
const roomChannelCache = new Map<string, { channel: string | null; at: number }>();
const ROOM_CHANNEL_TTL_MS = 5 * 60 * 1000;

// Exposed for tests to clear cross-test cache state.
export function resetRoomChannelCache(): void {
  roomChannelCache.clear();
}

// --- Trunk API helpers ---

async function trunkSend(to: string, type: string, content: string, threadId?: string, extra?: Record<string, unknown>) {
  try {
    return await trunkClient().send({
      to,
      type,
      payload: { content, source: "slack", ...extra },
      thread_id: threadId,
      idempotency_key: crypto.randomUUID(),
    });
  } catch (error) {
    if (error instanceof TrunkApiError) return null;
    throw error;
  }
}

async function trunkAck(messageId: string) {
  return trunkClient().ack(messageId);
}

// Resolve a room's configured Slack channel from its owner-set metadata
// (room.metadata.slack.channel). Cached briefly. Requires the adapter agent to be
// a member of the room (to read room state); returns null otherwise.
async function resolveRoomChannel(roomId: string): Promise<string | null> {
  const now = Date.now();
  const cached = roomChannelCache.get(roomId);
  if (cached && now - cached.at < ROOM_CHANNEL_TTL_MS) return cached.channel;

  let channel: string | null = null;
  try {
    const state = (await trunkClient().roomState(roomId)) as { room?: { metadata?: Record<string, unknown> } };
    const slack = state.room?.metadata?.slack as { channel?: string } | undefined;
    if (typeof slack?.channel === "string" && slack.channel) {
      channel = slack.channel;
    }
  } catch {
    // Not a member, no access, or no config — leave channel null.
  }

  roomChannelCache.set(roomId, { channel, at: now });
  return channel;
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

  // Reject requests with timestamps older than 5 minutes (replay protection)
  const requestAge = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!timestamp || Number.isNaN(requestAge) || requestAge > 300) {
    return new Response("Request too old", { status: 401 });
  }

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
      // Stamp the Slack origin into the payload so outbound replies can recover
      // the channel/thread even after a cold start wipes the in-memory caches.
      const receipt = await trunkSend(targetAgent, "question", text, existingThread, {
        slack_channel: channel,
        slack_thread_ts: threadTs,
      });
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
  const rawBody = await request.text();

  // Verify Trunk webhook signature if a webhook secret is configured
  if (TRUNK_WEBHOOK_SECRET) {
    const signature = request.headers.get("X-Trunk-Signature") || "";
    if (!signature || !await verifyTrunkSignature(rawBody, signature, TRUNK_WEBHOOK_SECRET)) {
      return new Response("Invalid Trunk webhook signature", { status: 401 });
    }
  }

  const body = JSON.parse(rawBody) as {
    event: string;
    message: { id: string; payload: { content?: string }; thread_id: string; to_room?: string | null };
  };

  if (body.event === "message.received") {
    const content = body.message.payload.content || "(no content)";
    // 1) Reply in a known Slack conversation (origin stamped in the thread).
    const destination = await resolveSlackDestination(body.message.thread_id);
    // 2) Otherwise, a proactive/room-scoped message posts to the room's channel.
    const channel = destination?.channel
      || (body.message.to_room ? await resolveRoomChannel(body.message.to_room) : null);

    if (channel) {
      await slackPost(channel, content, destination?.threadTs);
      await trunkAck(body.message.id);
    }
  }

  return new Response("ok");
}

// Find the Slack origin (channel + thread_ts) for a Trunk thread by scanning its
// messages for the inbound Slack-sourced one. Pure + exported for testing.
export function findSlackOrigin(
  messages: Array<{ payload?: Record<string, unknown> | null }>
): { channel: string; threadTs?: string } | null {
  for (const msg of messages || []) {
    const p = msg.payload;
    if (p && p.source === "slack" && typeof p.slack_channel === "string") {
      return {
        channel: p.slack_channel,
        threadTs: typeof p.slack_thread_ts === "string" ? p.slack_thread_ts : undefined,
      };
    }
  }
  return null;
}

// Resolve where a Trunk thread should post in Slack. In-memory cache first (warm
// fast path), then the durable payload-stamped origin via the relay (survives cold
// starts), then null — caller falls back to the room's configured channel.
async function resolveSlackDestination(threadId: string): Promise<{ channel: string; threadTs?: string } | null> {
  if (!threadId) return null;
  const cached = trunkToSlackThread.get(threadId);
  if (cached) return cached;
  try {
    const thread = await trunkClient().thread(threadId);
    const origin = findSlackOrigin(thread.messages || []);
    if (origin) {
      trunkToSlackThread.set(threadId, origin);
      return origin;
    }
  } catch {
    // Fall through to the default channel.
  }
  return null;
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

async function verifyTrunkSignature(
  rawBody: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const computed = `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  // Constant-time comparison
  if (computed.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

function parseJsonMap(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
}

function trunkClient(): TrunkClient {
  return new TrunkClient({ baseUrl: TRUNK_RELAY, secret: TRUNK_SECRET });
}
