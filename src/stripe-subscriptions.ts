/**
 * stripe-subscriptions.ts
 * Handles Stripe Pro subscription tier ($4.99/month, 10,000 scrapes/month)
 *
 * Env vars required:
 *   STRIPE_SECRET_KEY    — e.g. sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET — e.g. whsec_...
 *   STRIPE_PRICE_ID      — e.g. price_... (the $4.99/mo recurring price)
 */

import Stripe from "stripe";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";

const STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY || "sk_test_placeholder";
const STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET || "whsec_placeholder";
export const STRIPE_PRICE_ID =
  process.env.STRIPE_PRICE_ID || "price_placeholder";

const SUBSCRIPTIONS_FILE =
  process.env.STRIPE_SUBS_FILE || "/agent/data/stripe-subscriptions.json";

const MONTHLY_LIMIT = 10_000;
const STRIPE_ENABLED =
  process.env.STRIPE_SECRET_KEY &&
  process.env.STRIPE_SECRET_KEY !== "sk_test_placeholder";

// Only instantiate Stripe if keys are present
export const stripe = STRIPE_ENABLED
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-02-24.acacia" })
  : null;

// ────────────────────────────────────────────────
// Data model
// ────────────────────────────────────────────────

export interface SubscriptionRecord {
  apiKey: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: "active" | "cancelled" | "past_due";
  email: string;
  createdAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  usageThisPeriod: number;
  lastResetAt: string;
}

interface SubscriptionsStore {
  byApiKey: Record<string, SubscriptionRecord>;
  byCustomerId: Record<string, string>; // customerId -> apiKey
  bySubscriptionId: Record<string, string>; // subscriptionId -> apiKey
}

// ────────────────────────────────────────────────
// Store helpers
// ────────────────────────────────────────────────

function loadStore(): SubscriptionsStore {
  try {
    if (existsSync(SUBSCRIPTIONS_FILE)) {
      return JSON.parse(readFileSync(SUBSCRIPTIONS_FILE, "utf-8"));
    }
  } catch (err: any) {
    console.error("[stripe] Failed to load store:", err.message);
  }
  return { byApiKey: {}, byCustomerId: {}, bySubscriptionId: {} };
}

function saveStore(store: SubscriptionsStore): void {
  try {
    const dir = dirname(SUBSCRIPTIONS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (err: any) {
    console.error("[stripe] Failed to save store:", err.message);
  }
}

// ────────────────────────────────────────────────
// API key generation
// ────────────────────────────────────────────────

export function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(32);
  let key = "ab_";
  for (let i = 0; i < 32; i++) {
    key += chars[bytes[i] % chars.length];
  }
  return key;
}

// ────────────────────────────────────────────────
// Checkout session
// ────────────────────────────────────────────────

export async function createCheckoutSession(
  successUrl: string,
  cancelUrl: string
): Promise<Stripe.Checkout.Session> {
  if (!stripe) {
    throw new Error(
      "Stripe is not configured. Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID, and STRIPE_WEBHOOK_SECRET."
    );
  }

  const apiKey = generateApiKey();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [
      {
        price: STRIPE_PRICE_ID,
        quantity: 1,
      },
    ],
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
    metadata: {
      apiKey,
    },
    subscription_data: {
      metadata: {
        apiKey,
      },
    },
  });

  console.log(
    `[stripe] Checkout session created: ${session.id} apiKey=${apiKey.slice(0, 10)}...`
  );
  return session;
}

// ────────────────────────────────────────────────
// Retrieve checkout session (for success page)
// ────────────────────────────────────────────────

export async function getCheckoutSession(
  sessionId: string
): Promise<{ apiKey: string | null; email: string | null }> {
  if (!stripe) return { apiKey: null, email: null };

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return {
      apiKey: session.metadata?.apiKey || null,
      email: session.customer_details?.email || null,
    };
  } catch (err: any) {
    console.error("[stripe] Failed to retrieve session:", err.message);
    return { apiKey: null, email: null };
  }
}

// ────────────────────────────────────────────────
// Webhook event handler
// ────────────────────────────────────────────────

export async function handleWebhookEvent(
  rawBody: Buffer,
  signature: string
): Promise<void> {
  if (!stripe) {
    throw new Error("Stripe not configured");
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  console.log(`[stripe] Webhook event: ${event.type}`);
  const store = loadStore();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const apiKey = session.metadata?.apiKey;
      if (!apiKey || !session.subscription || !session.customer) break;

      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription as any).id;
      const customerId =
        typeof session.customer === "string"
          ? session.customer
          : (session.customer as any).id;

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const now = new Date().toISOString();

      const record: SubscriptionRecord = {
        apiKey,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        status: "active",
        email: session.customer_details?.email || "",
        createdAt: now,
        currentPeriodStart: new Date(
          subscription.current_period_start * 1000
        ).toISOString(),
        currentPeriodEnd: new Date(
          subscription.current_period_end * 1000
        ).toISOString(),
        usageThisPeriod: 0,
        lastResetAt: now,
      };

      store.byApiKey[apiKey] = record;
      store.byCustomerId[customerId] = apiKey;
      store.bySubscriptionId[subscriptionId] = apiKey;
      saveStore(store);
      console.log(
        `[stripe] Subscription activated: apiKey=${apiKey.slice(0, 10)}... customer=${customerId}`
      );
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const apiKey = store.bySubscriptionId[subscription.id];
      if (!apiKey) break;

      const record = store.byApiKey[apiKey];
      if (record) {
        record.status = "cancelled";
        saveStore(store);
        console.log(`[stripe] Subscription cancelled: apiKey=${apiKey.slice(0, 10)}...`);
      }
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const apiKey = store.bySubscriptionId[subscription.id];
      if (!apiKey) break;

      const record = store.byApiKey[apiKey];
      if (record) {
        record.status =
          subscription.status === "active"
            ? "active"
            : subscription.status === "past_due"
              ? "past_due"
              : "cancelled";
        const newPeriodStart = new Date(
          subscription.current_period_start * 1000
        ).toISOString();
        if (newPeriodStart !== record.currentPeriodStart) {
          // New billing period — reset usage
          record.usageThisPeriod = 0;
          record.lastResetAt = new Date().toISOString();
          record.currentPeriodStart = newPeriodStart;
        }
        record.currentPeriodEnd = new Date(
          subscription.current_period_end * 1000
        ).toISOString();
        saveStore(store);
        console.log(
          `[stripe] Subscription updated: apiKey=${apiKey.slice(0, 10)}... status=${record.status}`
        );
      }
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === "string"
          ? invoice.customer
          : (invoice.customer as any)?.id;
      if (!customerId) break;

      const apiKey = store.byCustomerId[customerId];
      if (!apiKey || !invoice.subscription) break;

      const record = store.byApiKey[apiKey];
      if (record) {
        const subId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : (invoice.subscription as any).id;
        try {
          const sub = await stripe.subscriptions.retrieve(subId);
          const newPeriodStart = new Date(
            sub.current_period_start * 1000
          ).toISOString();
          if (newPeriodStart !== record.currentPeriodStart) {
            record.usageThisPeriod = 0;
            record.lastResetAt = new Date().toISOString();
            record.currentPeriodStart = newPeriodStart;
            record.currentPeriodEnd = new Date(
              sub.current_period_end * 1000
            ).toISOString();
            saveStore(store);
            console.log(
              `[stripe] Usage reset for new billing period: apiKey=${apiKey.slice(0, 10)}...`
            );
          }
        } catch {}
      }
      break;
    }

    default:
      // Unhandled event type
      break;
  }
}

// ────────────────────────────────────────────────
// Subscription check (called in payment middleware)
// ────────────────────────────────────────────────

export interface SubscriptionCheckResult {
  valid: boolean;
  reason?: string;
  record?: SubscriptionRecord;
}

export function checkSubscription(apiKey: string): SubscriptionCheckResult {
  if (!apiKey || !apiKey.startsWith("ab_")) {
    return { valid: false, reason: "Not a Pro API key" };
  }

  const store = loadStore();
  const record = store.byApiKey[apiKey];

  if (!record) {
    return { valid: false, reason: "API key not found" };
  }

  if (record.status === "cancelled") {
    return { valid: false, reason: "Subscription has been cancelled" };
  }

  if (record.status === "past_due") {
    // Allow past_due subscriptions to continue for a grace period
    // Stripe will eventually cancel them if unpaid
    console.warn(`[stripe] Past-due subscription used: apiKey=${apiKey.slice(0, 10)}...`);
  }

  if (record.usageThisPeriod >= MONTHLY_LIMIT) {
    return {
      valid: false,
      reason: `Monthly limit of ${MONTHLY_LIMIT.toLocaleString()} scrapes reached. Resets at next billing date: ${record.currentPeriodEnd.slice(0, 10)}`,
    };
  }

  return { valid: true, record };
}

export function incrementUsage(apiKey: string): void {
  const store = loadStore();
  const record = store.byApiKey[apiKey];
  if (record) {
    record.usageThisPeriod = (record.usageThisPeriod || 0) + 1;
    saveStore(store);
  }
}

export function getSubscriptionStatus(
  apiKey: string
): SubscriptionRecord | null {
  const store = loadStore();
  return store.byApiKey[apiKey] || null;
}

export { STRIPE_ENABLED };
