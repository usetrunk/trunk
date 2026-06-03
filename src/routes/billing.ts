import { Hono } from "hono";
import Stripe from "stripe";
import { db } from "../db/index.js";
import { agents, subscriptions, workspaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../lib/auth.js";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";
import type { AgentVariables } from "../lib/types.js";

const app = new Hono<AgentVariables>();

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key);
}

// --- Authenticated routes ---

app.use("/checkout", authMiddleware);
app.use("/status", authMiddleware);
app.use("/portal", authMiddleware);

// Get or create subscription record for a workspace
async function ensureSubscription(workspaceId: string) {
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, workspaceId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(subscriptions)
    .values({ workspaceId, plan: "free", status: "active" })
    .returning();
  return created;
}

// Get billing status for agent's workspace
app.get("/status", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`billing:status:${agentId}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace", code: "VALIDATION_ERROR" }, 400);
  }

  const sub = await ensureSubscription(agent.workspaceId);
  return c.json({
    workspace_id: agent.workspaceId,
    plan: sub.plan,
    status: sub.status,
    current_period_start: sub.currentPeriodStart,
    current_period_end: sub.currentPeriodEnd,
    stripe_customer_id: sub.stripeCustomerId,
  });
});

// Create a Stripe Checkout session to upgrade to team tier
app.post("/checkout", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`billing:checkout:${agentId}`, 5, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const body = await c.req.json<{ success_url?: string; cancel_url?: string }>().catch((): { success_url?: string; cancel_url?: string } => ({}));

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace", code: "VALIDATION_ERROR" }, 400);
  }

  const sub = await ensureSubscription(agent.workspaceId);
  if (sub.plan === "team" && sub.status === "active") {
    return c.json({ error: "Already on team plan", code: "ALREADY_EXISTS" }, 409);
  }

  const stripe = getStripe();
  const priceId = process.env.STRIPE_TEAM_PRICE_ID;
  if (!priceId) return c.json({ error: "STRIPE_TEAM_PRICE_ID not configured", code: "INTERNAL_ERROR" }, 500);

  // Find or create Stripe customer
  let customerId = sub.stripeCustomerId;
  if (!customerId) {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, agent.workspaceId)).limit(1);
    const customer = await stripe.customers.create({
      metadata: { workspace_id: agent.workspaceId, agent_id: agentId },
      name: ws?.name ?? `Workspace ${agent.workspaceId}`,
    });
    customerId = customer.id;
    await db
      .update(subscriptions)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(subscriptions.id, sub.id));
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: body.success_url ?? `${process.env.APP_URL ?? "https://trunk.bot"}/billing/success`,
    cancel_url: body.cancel_url ?? `${process.env.APP_URL ?? "https://trunk.bot"}/billing/canceled`,
    metadata: { workspace_id: agent.workspaceId },
  });

  return c.json({ url: session.url, session_id: session.id });
});

// Create a Stripe Customer Portal session for managing subscription
app.post("/portal", async (c) => {
  const agentId = c.get("agentId");

  const rateLimit = await checkRateLimit(`billing:portal:${agentId}`, 10, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.workspaceId) {
    return c.json({ error: "Not in a workspace", code: "VALIDATION_ERROR" }, 400);
  }

  const sub = await ensureSubscription(agent.workspaceId);
  if (!sub.stripeCustomerId) {
    return c.json({ error: "No billing account. Create a checkout first.", code: "VALIDATION_ERROR" }, 400);
  }

  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${process.env.APP_URL ?? "https://trunk.bot"}/dashboard`,
  });

  return c.json({ url: session.url });
});

// --- Stripe webhook (no auth — verified via Stripe signature) ---

app.post("/webhook", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = await checkRateLimit(`billing:webhook:${ip}`, 60, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED", retry_after_seconds: rateLimit.retryAfterSeconds }, 429);
  }

  const sig = c.req.header("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return c.json({ error: "Missing signature or webhook secret", code: "UNAUTHORIZED" }, 400);
  }

  const stripe = getStripe();
  const rawBody = await c.req.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch {
    return c.json({ error: "Invalid signature", code: "UNAUTHORIZED" }, 400);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const workspaceId = session.metadata?.workspace_id;
      if (workspaceId && session.subscription) {
        const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        await db
          .update(subscriptions)
          .set({
            stripeSubscriptionId: subId,
            stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer?.id ?? null,
            plan: "team",
            status: "active",
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.workspaceId, workspaceId));
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const raw = event.data.object as unknown as Record<string, unknown>;
      const status = sub.status === "active" ? "active"
        : sub.status === "past_due" ? "past_due"
        : sub.status === "canceled" ? "canceled"
        : sub.status === "trialing" ? "trialing"
        : sub.status;

      const updates: Record<string, unknown> = { status, updatedAt: new Date() };
      // current_period fields may be on item level in newer API versions
      if (typeof raw.current_period_start === "number") {
        updates.currentPeriodStart = new Date((raw.current_period_start as number) * 1000);
      }
      if (typeof raw.current_period_end === "number") {
        updates.currentPeriodEnd = new Date((raw.current_period_end as number) * 1000);
      }

      if (sub.id) {
        await db
          .update(subscriptions)
          .set(updates)
          .where(eq(subscriptions.stripeSubscriptionId, sub.id));
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      if (sub.id) {
        await db
          .update(subscriptions)
          .set({ plan: "free", status: "canceled", updatedAt: new Date() })
          .where(eq(subscriptions.stripeSubscriptionId, sub.id));
      }
      break;
    }
  }

  return c.json({ received: true });
});

export default app;
