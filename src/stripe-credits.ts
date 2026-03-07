/**
 * stripe-credits.ts — One-time credit pack purchases via Stripe
 *
 * Manages credit packs (no subscription — buy once, use as needed).
 * Also contains SQLite helper functions for credit tracking.
 *
 * Credit packs:
 *   Starter: $5  → 3,000  credits
 *   Growth:  $20 → 15,000 credits
 *   Scale:   $50 → 50,000 credits
 *
 * 1 credit = 1 /scrape call
 * /crawl   = 5 credits
 * /extract = 5 credits
 * /batch   = credits per URL
 */

import Stripe from "stripe";
import { randomBytes } from "crypto";
import { db } from "./db.js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const CREDITS_STRIPE_ENABLED = !!(STRIPE_SECRET_KEY && !STRIPE_SECRET_KEY.startsWith("sk_test_placeholder"));

export const stripe = CREDITS_STRIPE_ENABLED
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" as any })
  : null;

// ── Credit pack definitions ───────────────────────────────────────────────

export const CREDIT_PACKS = [
  { id: "starter", name: "Starter Pack", price: 500,  credits: 3000,  priceId: "" },
  { id: "growth",  name: "Growth Pack",  price: 2000, credits: 15000, priceId: "" },
  { id: "scale",   name: "Scale Pack",   price: 5000, credits: 50000, priceId: "" },
];

// ── SQLite credit tables ──────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS api_credits (
    api_key TEXT PRIMARY KEY,
    email TEXT,
    credits_remaining INTEGER DEFAULT 0,
    credits_purchased INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    last_used INTEGER
  );

  CREATE TABLE IF NOT EXISTS credit_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT,
    email TEXT,
    pack_id TEXT,
    credits INTEGER,
    amount_cents INTEGER,
    stripe_session_id TEXT UNIQUE,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_api_credits_key ON api_credits(api_key);
  CREATE INDEX IF NOT EXISTS idx_credit_purchases_key ON credit_purchases(api_key);
`);

console.log("[stripe-credits] Credit tables ready");

// ── Helper functions ─────────────────────────────────────────────────────

/**
 * Get remaining credits for an API key.
 * Returns 0 if key not found.
 */
export function getCredits(apiKey: string): number {
  if (!apiKey) return 0;
  const row = db.prepare("SELECT credits_remaining FROM api_credits WHERE api_key = ?").get(apiKey) as { credits_remaining: number } | undefined;
  return row?.credits_remaining ?? 0;
}

/**
 * Deduct credits from an API key.
 * Returns false if insufficient credits, true on success.
 */
export function deductCredits(apiKey: string, amount: number): boolean {
  if (!apiKey || amount <= 0) return false;
  const row = db.prepare("SELECT credits_remaining FROM api_credits WHERE api_key = ?").get(apiKey) as { credits_remaining: number } | undefined;
  if (!row || row.credits_remaining < amount) return false;

  db.prepare(`
    UPDATE api_credits
    SET credits_remaining = credits_remaining - ?,
        last_used = unixepoch() * 1000
    WHERE api_key = ?
  `).run(amount, apiKey);
  return true;
}

/**
 * Add credits to an API key (creating the record if needed).
 * Also inserts a purchase record.
 */
export function addCredits(
  apiKey: string,
  email: string,
  credits: number,
  packId: string,
  sessionId: string,
): void {
  const pack = CREDIT_PACKS.find(p => p.id === packId);
  const amountCents = pack?.price ?? 0;

  // Upsert api_credits row
  db.prepare(`
    INSERT INTO api_credits (api_key, email, credits_remaining, credits_purchased, created_at)
    VALUES (?, ?, ?, ?, unixepoch() * 1000)
    ON CONFLICT(api_key) DO UPDATE SET
      credits_remaining = credits_remaining + ?,
      credits_purchased = credits_purchased + ?,
      email = COALESCE(NULLIF(?, ''), email)
  `).run(apiKey, email, credits, credits, credits, credits, email);

  // Record the purchase (ignore duplicate session IDs)
  try {
    db.prepare(`
      INSERT OR IGNORE INTO credit_purchases
        (api_key, email, pack_id, credits, amount_cents, stripe_session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000)
    `).run(apiKey, email, packId, credits, amountCents, sessionId);
  } catch (err: any) {
    console.error("[stripe-credits] Failed to insert purchase record:", err.message);
  }

  console.log(`[stripe-credits] Added ${credits} credits to ${apiKey} (${email}) for pack=${packId}`);
}

/**
 * Generate a new credit-based API key.
 * Format: "ab_" + 32 hex chars
 */
export function generateCreditApiKey(): string {
  return "ab_" + randomBytes(16).toString("hex");
}

// ── Checkout session creation ─────────────────────────────────────────────

/**
 * Create a Stripe Checkout session for a credit pack.
 * Returns the redirect URL.
 */
export async function createCreditCheckout(packId: string, email?: string): Promise<string> {
  const pack = CREDIT_PACKS.find(p => p.id === packId);
  if (!pack) throw new Error(`Invalid pack id: ${packId}`);

  if (!stripe) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY.");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: {
          name: pack.name,
          description: `${pack.credits.toLocaleString()} API credits for anybrowse.dev — never expire`,
        },
        unit_amount: pack.price,
      },
      quantity: 1,
    }],
    customer_email: email || undefined,
    success_url: "https://anybrowse.dev/credits/success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://anybrowse.dev/credits",
    metadata: {
      pack_id: packId,
      credits: pack.credits.toString(),
      type: "credit_pack",
    },
  });

  console.log(`[stripe-credits] Checkout session created: ${session.id} pack=${packId}`);
  return session.url!;
}

/**
 * Retrieve a completed Stripe checkout session for credit packs.
 * Used on the success page to get the associated API key.
 */
export async function getCreditCheckoutSession(sessionId: string): Promise<{ apiKey: string | null; email: string | null; credits: number | null }> {
  if (!stripe) return { apiKey: null, email: null, credits: null };

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Look up the API key issued for this session
    const purchase = db.prepare(
      "SELECT api_key, credits FROM credit_purchases WHERE stripe_session_id = ?"
    ).get(session.id) as { api_key: string; credits: number } | undefined;

    return {
      apiKey: purchase?.api_key || null,
      email: session.customer_email || null,
      credits: purchase?.credits || (session.metadata?.credits ? parseInt(session.metadata.credits) : null),
    };
  } catch (err: any) {
    console.error("[stripe-credits] Failed to retrieve session:", err.message);
    return { apiKey: null, email: null, credits: null };
  }
}

export { CREDITS_STRIPE_ENABLED };
