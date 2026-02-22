/**
 * x402 micropayment flow with the Anybrowse SDK.
 *
 * Paid endpoints (scrape, crawl, search) return HTTP 402 when payment is
 * required. This example shows how to catch that error and outlines the
 * payment signing flow.
 *
 * Run with: npx tsx examples/with-payment.ts
 */
import { AnybrowseClient, PaymentRequiredError } from "../src/index.js";

// x402 payment network constants
const PAYMENT = {
  chainId: 8453,                                           // Base
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",    // USDC on Base
  payTo: "0x8D76E8FB38541d70dF74b14660c39b4c5d737088",    // Anybrowse recipient
} as const;

async function main() {
  // Initialize the client with payment configuration.
  // The privateKey is used to sign USDC transfer authorizations on Base.
  const client = new AnybrowseClient({
    payment: {
      privateKey: process.env.WALLET_PRIVATE_KEY ?? "",
    },
  });

  try {
    const result = await client.scrape("https://example.com");
    console.log("Scrape succeeded:", result.title);
  } catch (err) {
    if (err instanceof PaymentRequiredError) {
      console.log("Payment required by the server.");
      console.log("Payment details:", JSON.stringify(err.paymentDetails, null, 2));
      console.log();
      console.log("To complete the payment:");
      console.log(`  1. Approve USDC spend on Base (chain ${PAYMENT.chainId})`);
      console.log(`  2. Sign a transfer of the requested amount`);
      console.log(`     Asset:  ${PAYMENT.asset}`);
      console.log(`     Pay to: ${PAYMENT.payTo}`);
      console.log("  3. Include the signed payment header and retry the request");
      console.log();
      console.log(
        "Tip: Use an x402-compatible library (e.g. @coinbase/x402) to " +
        "automate payment signing and header injection."
      );
    } else {
      throw err;
    }
  }
}

main().catch(console.error);
