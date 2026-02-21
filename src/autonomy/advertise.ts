/**
 * Farcaster Self-Promotion Module
 *
 * Posts to Farcaster channels (/x402, /agents, /base).
 *
 * Two modes (checked in order):
 *   1. Neynar REST API (preferred) — if NEYNAR_API_KEY + NEYNAR_SIGNER_UUID are set
 *   2. Direct Hub submission (legacy) — if FARCASTER_SIGNER_KEY is set
 *
 * Neynar setup:
 *   1. Sign up at neynar.com, get API key
 *   2. Create a managed signer via their dashboard or API
 *   3. Set NEYNAR_API_KEY and NEYNAR_SIGNER_UUID in .env
 *
 * Direct hub setup (legacy):
 *   1. npm install @farcaster/core
 *   2. Run: node generate-signer.mjs
 *   3. Register signer on-chain via KeyGateway
 *   4. Set FARCASTER_SIGNER_KEY in .env
 */

import { loadEnvString } from "../env.js";

// --- Config ---

const NEYNAR_API_URL = "https://api.neynar.com/v2/farcaster/cast";
const PINATA_HUB = "https://hub.pinata.cloud/v1";
const FID = 411426; // hellabandsmyg

// Channel IDs for Neynar API
const CHANNEL_IDS = ["x402", "agents", "base"];

// Farcaster channel parent URLs (for legacy hub submission)
const CHANNEL_PARENT_URLS: Record<string, string> = {
  x402: "https://farcaster.xyz/~/channel/x402",
  agents: "https://warpcast.com/~/channel/agents",
  base: "https://warpcast.com/~/channel/base",
};

// Post templates — rotated daily, each must be <= 320 bytes
const POST_TEMPLATES = [
  "anybrowse.dev \u2014 Any URL to LLM-ready Markdown via real Chrome.\n\nMCP tools: scrape ($0.003), crawl ($0.005), search ($0.002)\n\nEndpoint: https://anybrowse.dev/mcp\nx402 payments on Base. No API keys.",

  "Web scraping for AI agents? anybrowse runs real Chrome, returns clean Markdown.\n\nAdd to Claude/Cursor:\n{\"mcpServers\":{\"anybrowse\":{\"url\":\"https://anybrowse.dev/mcp\"}}}\n\nPay per request, USDC on Base.",

  "Your AI agent needs to read the web? Most sites need JS.\n\nanybrowse.dev renders with real Chrome, returns clean Markdown.\n\nx402 payments | MCP server | No API keys\nhttps://anybrowse.dev",

  "anybrowse \u2014 web scraping API for AI agents.\n\nReal Chrome rendering\nMCP server for Claude/Cursor\nx402 micropayments (USDC on Base)\n$0.003/page\n\nhttps://anybrowse.dev",
];

let lastPostDate = "";
let templateIndex = 0;

function getNextTemplate(): string {
  const t = POST_TEMPLATES[templateIndex % POST_TEMPLATES.length];
  templateIndex++;
  return t;
}

function getChannelForDay(): string {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000
  );
  return CHANNEL_IDS[dayOfYear % CHANNEL_IDS.length];
}

// ============================================================
// Neynar REST API approach (preferred)
// ============================================================

async function submitCastViaNeynar(
  text: string,
  channelId: string,
  apiKey: string,
  signerUuid: string
): Promise<boolean> {
  try {
    const body = {
      signer_uuid: signerUuid,
      text,
      embeds: [{ url: "https://anybrowse.dev" }],
      channel_id: channelId,
    };

    const res = await fetch(NEYNAR_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(
        "[farcaster/neynar] Cast submitted successfully to /" + channelId,
        data?.cast?.hash ? `(hash: ${data.cast.hash})` : ""
      );
      return true;
    } else {
      const errText = await res.text();
      console.warn(
        "[farcaster/neynar] API rejected cast:",
        res.status,
        errText
      );
      return false;
    }
  } catch (err) {
    console.error("[farcaster/neynar] Failed to submit cast:", err);
    return false;
  }
}

// ============================================================
// Direct Hub submission (legacy fallback)
// ============================================================

async function submitCastViaHub(
  text: string,
  parentUrl: string,
  signerKeyHex: string
): Promise<boolean> {
  try {
    // Dynamic import so the module is only loaded when actually needed.
    // This avoids a hard dependency on @farcaster/core when using Neynar.
    const {
      makeCastAdd,
      NobleEd25519Signer,
      FarcasterNetwork,
      Message,
    } = await import("@farcaster/core");

    const signerKey = new Uint8Array(Buffer.from(signerKeyHex, "hex"));
    const signer = new NobleEd25519Signer(signerKey);

    const castResult = await makeCastAdd(
      {
        text,
        embeds: [{ url: "https://anybrowse.dev" }],
        embedsDeprecated: [],
        mentions: [],
        mentionsPositions: [],
        parentUrl,
        type: 0,
      },
      { fid: FID, network: FarcasterNetwork.MAINNET },
      signer
    );

    if (castResult.isErr()) {
      console.error("[farcaster/hub] Failed to build cast:", castResult.error);
      return false;
    }

    const messageBytes = Message.encode(castResult.value).finish();

    const res = await fetch(PINATA_HUB + "/submitMessage", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: messageBytes,
    });

    if (res.ok) {
      console.log("[farcaster/hub] Cast submitted successfully");
      return true;
    } else {
      const errText = await res.text();
      console.warn("[farcaster/hub] Hub rejected cast:", res.status, errText);
      return false;
    }
  } catch (err) {
    console.error("[farcaster/hub] Failed to submit to hub:", err);
    return false;
  }
}

// ============================================================
// Main posting logic
// ============================================================

type PostingMode = "neynar" | "hub" | "disabled";

function detectMode(): PostingMode {
  // Prefer Neynar if both keys are available
  try {
    const apiKey = loadEnvString("NEYNAR_API_KEY");
    const signerUuid = loadEnvString("NEYNAR_SIGNER_UUID");
    if (apiKey && signerUuid) return "neynar";
  } catch {
    // not configured
  }

  // Fall back to direct hub submission
  try {
    const key = loadEnvString("FARCASTER_SIGNER_KEY");
    if (key && key.length >= 64) return "hub";
  } catch {
    // not configured
  }

  return "disabled";
}

/**
 * Run daily Farcaster promotion.
 * Posts once per day to a rotating Farcaster channel.
 * Silently skips if no posting credentials are configured.
 */
export async function runFarcasterPromotion(): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  if (today === lastPostDate) return;

  const mode = detectMode();
  if (mode === "disabled") return;

  const channelId = getChannelForDay();
  const text = getNextTemplate();

  console.log(
    `[farcaster] Posting to /${channelId} via ${mode}...`
  );

  let success = false;

  if (mode === "neynar") {
    const apiKey = loadEnvString("NEYNAR_API_KEY");
    const signerUuid = loadEnvString("NEYNAR_SIGNER_UUID");
    success = await submitCastViaNeynar(text, channelId, apiKey, signerUuid);
  } else if (mode === "hub") {
    const signerKeyHex = loadEnvString("FARCASTER_SIGNER_KEY");
    const parentUrl = CHANNEL_PARENT_URLS[channelId];
    success = await submitCastViaHub(text, parentUrl, signerKeyHex);
  }

  if (success) {
    lastPostDate = today;
    console.log("[farcaster] Daily post complete (/" + channelId + ")");
  }
}

// --- Lifecycle exports for autonomy module ---

const ADVERTISER_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
let advertiserTimer: ReturnType<typeof setInterval> | null = null;

interface AdvertiseStatus {
  lastRun: string | null;
  lastPostDate: string;
  nextChannel: string;
  configured: boolean;
  mode: PostingMode;
  posted: boolean;
}

export function startAdvertiser(): void {
  if (advertiserTimer) return;
  const mode = detectMode();
  console.log(`[farcaster] Starting advertiser (mode: ${mode}, interval: daily)`);
  setTimeout(runFarcasterPromotion, 6 * 60_000);
  advertiserTimer = setInterval(runFarcasterPromotion, ADVERTISER_INTERVAL_MS);
}

export function stopAdvertiser(): void {
  if (advertiserTimer) {
    clearInterval(advertiserTimer);
    advertiserTimer = null;
  }
}

export function getAdvertiseStatus(): AdvertiseStatus {
  const mode = detectMode();
  const channelId = getChannelForDay();
  return {
    lastRun: lastPostDate || null,
    lastPostDate,
    nextChannel: channelId,
    configured: mode !== "disabled",
    mode,
    posted: lastPostDate === new Date().toISOString().split("T")[0],
  };
}
