import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes, timingSafeEqual } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { getConfig } from "./autonomy/optimizer.js";

const PAY_TO = "0x8D76E8FB38541d70dF74b14660c39b4c5d737088";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NETWORK = "base" as const;
const FACILITATOR_URL = process.env.FACILITATOR_URL || "http://127.0.0.1:8080";
const PUBLIC_FACILITATOR = "https://anybrowse.dev/facilitator";
const PAYMENTS_LEDGER = "/agent/data/payments.json";

const DEFAULT_PRICES: Record<string, number> = {
  "/scrape": 3000,
  "/crawl": 5000,
  "/serp/search": 2000,
};

const USDC_EIP712 = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: USDC,
};

// Internal bypass token — regenerated every startup, used by MCP handler
export const INTERNAL_BYPASS_TOKEN = randomBytes(32).toString("hex");
const BYPASS_TOKEN_BUF = Buffer.from(INTERNAL_BYPASS_TOKEN, "hex");

// Payment replay protection — track recently settled payment hashes
const SETTLED_PAYMENTS = new Set<string>();

function getPaymentHash(payment: any): string {
  return Buffer.from(JSON.stringify(payment)).toString("base64").slice(0, 64);
}

// Clean up old entries periodically
setInterval(() => {
  if (SETTLED_PAYMENTS.size > 1000) {
    SETTLED_PAYMENTS.clear();
  }
}, 5 * 60 * 1000);

interface PaymentEvent {
  timestamp: string;
  endpoint: string;
  payer: string;
  amountMicro: number;
  amountUSDC: string;
  transaction: string | null;
  status: "settled" | "settlement_failed";
  error?: string;
}

function recordPayment(event: PaymentEvent): void {
  try {
    let ledger: PaymentEvent[] = [];
    if (existsSync(PAYMENTS_LEDGER)) {
      ledger = JSON.parse(readFileSync(PAYMENTS_LEDGER, "utf-8"));
    }
    ledger.push(event);
    if (ledger.length > 10000) {
      ledger = ledger.slice(-10000);
    }
    writeFileSync(PAYMENTS_LEDGER, JSON.stringify(ledger, null, 2));
  } catch (err: any) {
    console.error("[payment-gate] Failed to persist payment event:", err.message);
  }
}

/**
 * Timing-safe comparison for the bypass token
 */
function isValidBypassToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  try {
    const candidateBuf = Buffer.from(candidate, "hex");
    if (candidateBuf.length !== BYPASS_TOKEN_BUF.length) return false;
    return timingSafeEqual(candidateBuf, BYPASS_TOKEN_BUF);
  } catch {
    return false;
  }
}

export default fp(async function paymentGate(app: FastifyInstance) {
  const { useFacilitator } = await import("x402/verify");
  const facilitator = useFacilitator({
    url: FACILITATOR_URL as `${string}://${string}`,
  });

  console.log(`[payment-gate] Internal facilitator: ${FACILITATOR_URL}`);
  console.log(`[payment-gate] Public facilitator:   ${PUBLIC_FACILITATOR}`);
  console.log(`[payment-gate] Payment ledger:       ${PAYMENTS_LEDGER}`);

  function getCurrentPrice(path: string): number | undefined {
    const config = getConfig();
    const configPrices: Record<string, number> = {
      "/scrape": config.pricing.scrape,
      "/crawl": config.pricing.crawl,
      "/serp/search": config.pricing.search,
    };
    return configPrices[path] ?? DEFAULT_PRICES[path];
  }

  function buildPaymentRequirements(path: string, method: string, amount: number) {
    return {
      scheme: "exact" as const,
      network: NETWORK,
      maxAmountRequired: String(amount),
      resource: `https://anybrowse.dev${path}`,
      description:
        "anybrowse — autonomous web browsing agent. LLM-optimized Markdown.",
      mimeType: "application/json",
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      asset: USDC,
      outputSchema: {
        input: { type: "http", method, discoverable: true },
      },
      extra: USDC_EIP712,
    };
  }

  app.addHook(
    "preHandler",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const path = req.url.split("?")[0];

      // Skip payment for internal MCP tool calls (timing-safe comparison)
      if (isValidBypassToken(req.headers["x-internal-token"] as string)) return;

      const amount = getCurrentPrice(path);
      if (!amount) return;

      const paymentRequirements = buildPaymentRequirements(
        path,
        req.method,
        amount,
      );
      const xPayment = req.headers["x-payment"] as string | undefined;

      if (!xPayment) {
        reply.status(402).send({
          x402Version: 1,
          error: "X-PAYMENT header is required",
          accepts: [paymentRequirements],
          facilitator: PUBLIC_FACILITATOR,
        });
        return;
      }

      // Decode the base64-encoded payment payload
      let decodedPayment: any;
      try {
        const decoded = Buffer.from(xPayment, "base64").toString("utf-8");
        decodedPayment = JSON.parse(decoded);
      } catch {
        reply.status(402).send({
          x402Version: 1,
          error: "Invalid X-PAYMENT header — expected base64 JSON",
          accepts: [paymentRequirements],
          facilitator: PUBLIC_FACILITATOR,
        });
        return;
      }

      // Replay protection — reject duplicate payment payloads
      const paymentHash = getPaymentHash(decodedPayment);
      if (SETTLED_PAYMENTS.has(paymentHash)) {
        console.log(`[payment-gate] Replay rejected: ${paymentHash.slice(0, 16)}...`);
        reply.status(402).send({
          x402Version: 1,
          error: "Payment already used",
          accepts: [paymentRequirements],
          facilitator: PUBLIC_FACILITATOR,
        });
        return;
      }

      // Verify payment with facilitator
      try {
        const verifyResult = await facilitator.verify(
          decodedPayment,
          paymentRequirements,
        );
        if (!verifyResult.isValid) {
          console.log(
            `[payment-gate] Verification failed: ${verifyResult.invalidReason}`,
          );
          reply.status(402).send({
            x402Version: 1,
            error: `Payment verification failed: ${verifyResult.invalidReason}`,
            accepts: [paymentRequirements],
            facilitator: PUBLIC_FACILITATOR,
          });
          return;
        }
        console.log(
          `[payment-gate] Payment verified from ${verifyResult.payer}`,
        );
      } catch (err: any) {
        console.error(
          `[payment-gate] Verify error:`,
          err.message || err,
        );
        reply.status(402).send({
          x402Version: 1,
          error: "Payment verification error — try again",
          accepts: [paymentRequirements],
          facilitator: PUBLIC_FACILITATOR,
        });
        return;
      }

      (req as any).x402Payment = decodedPayment;
      (req as any).x402Requirements = paymentRequirements;
      (req as any).x402PaymentHash = paymentHash;
    },
  );

  app.addHook(
    "onSend",
    async (
      req: FastifyRequest,
      reply: FastifyReply,
      payload: unknown,
    ) => {
      const decodedPayment = (req as any).x402Payment;
      const paymentRequirements = (req as any).x402Requirements;
      const paymentHash = (req as any).x402PaymentHash as string | undefined;
      if (!decodedPayment || !paymentRequirements) return payload;

      const path = req.url.split("?")[0];
      const amount = getCurrentPrice(path) || 0;

      if (reply.statusCode >= 400) {
        console.log(
          `[payment-gate] Skipping settlement — response ${reply.statusCode}`,
        );
        return payload;
      }

      try {
        const settleResult = await facilitator.settle(
          decodedPayment,
          paymentRequirements,
        );
        if (!settleResult.success) {
          console.error(
            `[payment-gate] Settlement failed: ${settleResult.errorReason}`,
          );
          recordPayment({
            timestamp: new Date().toISOString(),
            endpoint: path,
            payer: settleResult.payer || "unknown",
            amountMicro: amount,
            amountUSDC: (amount / 1_000_000).toFixed(6),
            transaction: null,
            status: "settlement_failed",
            error: settleResult.errorReason,
          });
          reply.status(402);
          return JSON.stringify({
            x402Version: 1,
            error: `Payment settlement failed: ${settleResult.errorReason}`,
          });
        }

        console.log(
          `[payment-gate] Settled! tx=${settleResult.transaction} payer=${settleResult.payer}`,
        );

        // Mark payment as used (replay protection)
        if (paymentHash) {
          SETTLED_PAYMENTS.add(paymentHash);
        }

        recordPayment({
          timestamp: new Date().toISOString(),
          endpoint: path,
          payer: settleResult.payer || "unknown",
          amountMicro: amount,
          amountUSDC: (amount / 1_000_000).toFixed(6),
          transaction: settleResult.transaction,
          status: "settled",
        });

        const proof = Buffer.from(
          JSON.stringify(settleResult),
        ).toString("base64");
        reply.header("X-PAYMENT-RESPONSE", proof);
      } catch (err: any) {
        console.error(
          `[payment-gate] Settle error:`,
          err.message || err,
        );
        recordPayment({
          timestamp: new Date().toISOString(),
          endpoint: path,
          payer: "unknown",
          amountMicro: amount,
          amountUSDC: (amount / 1_000_000).toFixed(6),
          transaction: null,
          status: "settlement_failed",
          error: err.message || String(err),
        });
        reply.status(402);
        return JSON.stringify({
          x402Version: 1,
          error: "Payment settlement error",
        });
      }

      return payload;
    },
  );
});
