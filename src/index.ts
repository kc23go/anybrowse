import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadEnvNumber, loadEnvString } from "./env.js";
import { registerSerpRoutes } from "./serp.js";
import { registerCrawlRoutes } from "./crawl.js";
import { initPool, shutdownPool } from "./pool.js";
import paymentGate, { emailVerifiedIps } from "./payment-gate.js";
import { stats } from "./stats.js";
import { startHealer, stopHealer, getHealthStatus } from "./autonomy/healer.js";
import { startOptimizer, stopOptimizer, getConfig } from "./autonomy/optimizer.js";
import { startWarmer, stopWarmer, getWarmerStatus } from "./warmer.js";
import { intelligence } from "./autonomy/intelligence.js";
import { startPromoter, stopPromoter, getPromotionStatus } from "./autonomy/promoter.js";
import { startAdvertiser, stopAdvertiser, getAdvertiseStatus } from "./autonomy/advertise.js";
import { registerMcpRoute } from "./mcp-transport.js";
// relay module loaded dynamically to isolate startup errors
let _relayModule: typeof import('./relay.js') | null = null;
async function loadRelay() {
  if (_relayModule) return _relayModule;
  try {
    _relayModule = await import('./relay.js');
    return _relayModule;
  } catch (err) {
    console.error('[relay] Module load failed (relay disabled):', err);
    return null;
  }
}
import { registerBatchRoutes } from "./batch.js";
import { registerWatchRoutes, startWatchPoller } from "./watch.js";
import { registerExtractRoutes } from "./extract.js";
import { registerAggregateRoutes } from "./aggregate.js";
import { registerAggregateStreamRoutes } from "./aggregate-stream.js";
import { logRequest, buildLogEntry, getClientBreakdown, computeInsights, shouldExcludeFromStats, addExcludedIp, getDynamicExclusions, hashIp, getCleanRequestCount } from "./request-log.js";
import { db, addEmailSubscriber } from "./db.js";
import { runDrip } from "./drip.js";
import {
  createCheckoutSession,
  getCheckoutSession,
  handleWebhookEvent,
  getSubscriptionStatus,
  STRIPE_ENABLED,
} from "./stripe-subscriptions.js";
import {
  createCreditCheckout,
  getCreditCheckoutSession,
  getCredits,
  deductCredits,
  addCredits,
  generateCreditApiKey,
  CREDIT_PACKS,
  CREDITS_STRIPE_ENABLED,
  stripe as creditsStripe,
} from "./stripe-credits.js";
import { sendEmail, isMailerEnabled, sendApiKeyEmail } from "./mailer.js";
import { trackEvent, shutdownAnalytics } from "./analytics.js";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEBUG_LOG =
  process.env.DEBUG_LOG === "1" || process.env.DEBUG_LOG === "true";

// Known API paths — used to filter attack probes from public stats
const KNOWN_PATHS = new Set([
  "/", "/scrape", "/crawl", "/serp/search", "/serp", "/mcp",
  "/batch", "/watch", "/watches", "/extract", "/aggregate", "/aggregate/stream",
  "/health", "/stats", "/status", "/earnings", "/autonomy", "/gaps",
  "/capture-email", "/upgrade-free", "/insights", "/data-export",
  "/tos", "/privacy", "/integrations", "/checkout",
  "/credits", "/credits/checkout", "/credits/success", "/credits/balance",
  "/benchmark", "/vs/firecrawl", "/vs/jina", "/vs/diffbot",
  "/blog/benchmarking-web-scraping-apis",
  "/.well-known/agent-card.json",
  "/manage", "/portal", "/dashboard", "/dashboard/data",
]);

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>anybrowse \u2014 any url to markdown</title>
<meta name="description" content="Convert any URL to clean, LLM-ready Markdown. x402 micropayments on Base. No API key. No signup.">
<link rel="canonical" href="https://anybrowse.dev/">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='none' stroke='%231a1a1a' stroke-width='3'/><line x1='50' y1='10' x2='50' y2='80' stroke='%23ff4a00' stroke-width='5'/><polygon points='40,75 50,92 60,75' fill='%23ff4a00'/></svg>">
<meta property="og:type" content="website">
<meta property="og:title" content="anybrowse \u2014 any URL to Markdown">
<meta property="og:description" content="Convert any URL to clean, LLM-ready Markdown. $0.002/page. No API key. No signup. x402 micropayments on Base.">
<meta property="og:url" content="https://anybrowse.dev/">
<meta property="og:site_name" content="anybrowse">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="anybrowse \u2014 any URL to Markdown">
<meta name="twitter:description" content="Convert any URL to clean, LLM-ready Markdown. $0.002/page. No API key. x402 micropayments on Base.">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Helvetica Neue",Helvetica,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f4f0eb;color:#1a1a1a;max-width:720px;margin:0 auto;padding:4rem 1.5rem 2.5rem;line-height:1.7;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.header{display:flex;align-items:center;gap:1rem;margin-bottom:.5rem}
.logo{width:44px;height:44px;flex-shrink:0}
.wordmark{font-size:1.15rem;font-weight:300;letter-spacing:.04em;color:#1a1a1a}
.wordmark b{font-weight:700}
.virgil-labels{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:3rem}
.vl{font-size:.6rem;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:#767676;font-style:italic}
.vl::before{content:'\\201C'}
.vl::after{content:'\\201D'}
.version{font-size:.55rem;letter-spacing:.12em;text-transform:uppercase;color:#767676;border:1px solid #bbb;border-radius:3px;padding:1px 6px;font-weight:500;font-style:normal;margin-left:.25rem}
h1{font-size:clamp(2.4rem,7vw,3.8rem);font-weight:800;letter-spacing:-.03em;line-height:1;margin-bottom:.6rem;color:#1a1a1a}
h1 .q::before{content:'\\201C';color:#d94400;font-weight:300;margin-right:.05em}
h1 .q::after{content:'\\201D';color:#d94400;font-weight:300;margin-left:.05em}
h1 .arrow{color:#d94400;font-weight:300}
.sub{font-size:1rem;color:#555;margin-bottom:3rem;letter-spacing:.01em}
.sub strong{color:#1a1a1a;font-weight:600}
h2{font-size:.6rem;font-weight:500;letter-spacing:.25em;text-transform:uppercase;color:#767676;margin:3.5rem 0 1rem;font-style:italic}
pre{background:#fff;border:1px solid #e0dcd7;border-radius:6px;padding:1.25rem 1.5rem;font-family:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace;font-size:.82rem;line-height:1.7;overflow-x:auto;cursor:pointer;position:relative;transition:border-color .2s}
pre:hover,pre:focus{border-color:#ccc;outline:2px solid #d94400;outline-offset:2px}
pre::after{content:"click to copy";position:absolute;top:.85rem;right:1rem;font-size:.55rem;color:#999;letter-spacing:.12em;text-transform:uppercase;font-family:"Helvetica Neue",Helvetica,system-ui,sans-serif;transition:color .2s}
pre:hover::after,pre:focus::after{color:#767676}
pre.ok::after{content:"copied";color:#d94400}
.d{color:#999}
.c{color:#1a1a1a}
.f{color:#d94400}
.s{color:#555}
.live{display:flex;align-items:center;gap:1.75rem;font-size:.82rem;flex-wrap:wrap;margin:2.5rem 0 0}
.dot{width:6px;height:6px;border-radius:50%;background:#16a34a;display:inline-block;margin-right:.35rem;box-shadow:0 0 6px #16a34a60;animation:p 2s ease-in-out infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
.ll{color:#1a1a1a;font-weight:600;font-size:.6rem;letter-spacing:.2em;text-transform:uppercase}
.live span.m{color:#767676}
.v{color:#1a1a1a;font-weight:500}
.ep{font-size:.85rem;display:flex;flex-direction:column;gap:0}
.er{display:flex;justify-content:space-between;align-items:baseline;padding:.75rem 0;border-bottom:1px solid #e0dcd7}
.er:last-child{border-bottom:none}
.el{display:flex;align-items:baseline;gap:.75rem;min-width:0}
.em{color:#fff;background:#d94400;font-family:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace;font-size:.6rem;font-weight:700;flex-shrink:0;padding:2px 6px;border-radius:3px;letter-spacing:.04em}
.epath{color:#1a1a1a;font-family:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace;font-size:.8rem;font-weight:500}
.edesc{color:#767676;font-style:italic;font-size:.8rem}
.edesc::before{content:'\\201C'}
.edesc::after{content:'\\201D'}
.eprice{color:#1a1a1a;font-family:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace;font-size:.8rem;flex-shrink:0;margin-left:1rem;font-weight:500}
.fr{color:#16a34a}
.mc{background:#fff;border:1px solid #e0dcd7;border-radius:6px;padding:1.15rem 1.4rem;font-family:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace;font-size:.78rem;line-height:1.6;color:#767676}
.mk{color:#1a1a1a}
.ms{color:#d94400}
.pay{color:#555;font-size:.9rem;line-height:1.7}
.pay code{background:#fff;border:1px solid #e0dcd7;padding:2px 6px;border-radius:3px;font-size:.8rem;color:#1a1a1a;font-family:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace}
a{color:#d94400;text-decoration:none}
a:hover{text-decoration:underline}
a:focus{outline:2px solid #d94400;outline-offset:2px}
.co{font-size:.7rem;color:#767676;letter-spacing:.08em;font-style:italic;margin-bottom:.75rem}
.nav-links{margin-bottom:2rem;display:flex;gap:1.5rem;flex-wrap:wrap}
.nav-links a{color:#767676;text-decoration:none;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;transition:color .15s}
.nav-links a:hover{color:#d94400}
footer{margin-top:5rem;padding-top:1.5rem;border-top:1px solid #ddd8d2;font-size:.75rem;color:#767676;line-height:2.4}
footer a{color:#767676;text-decoration:none;transition:color .15s;padding:.25rem 0}
footer a:hover{color:#1a1a1a}
.mn{font-family:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace}
@media(max-width:520px){
body{padding:2.5rem 1rem 1.5rem}
.live{gap:.6rem 1.25rem}
.edesc{display:none}
pre{padding:1rem;font-size:.75rem}
h1{font-size:2rem}
}
</style>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "anybrowse",
  "url": "https://anybrowse.dev",
  "description": "Convert any URL to LLM-ready Markdown via real Chrome browsers. Pay per request with x402 micropayments.",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Any",
  "softwareVersion": "1.0.0",
  "featureList": ["URL to Markdown conversion", "JavaScript rendering via real Chrome", "Google search + scrape", "MCP server for AI agents", "x402 micropayments", "No API key required"],
  "offers": {
    "@type": "AggregateOffer",
    "priceCurrency": "USD",
    "lowPrice": "0.002",
    "highPrice": "0.01",
    "offerCount": "3"
  },
  "creator": {
    "@type": "Organization",
    "name": "anybrowse",
    "url": "https://anybrowse.dev",
    "sameAs": ["https://github.com/kc23go/anybrowse"]
  }
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is anybrowse?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "anybrowse is a web scraping API that converts any URL to LLM-ready Markdown using real Chrome browsers, with x402 micropayments on Base."
      }
    },
    {
      "@type": "Question",
      "name": "How much does anybrowse cost?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Scrape: $0.002/page, Crawl: $0.01/request, Search: $0.002/query. Pay per request with USDC on Base. No subscriptions."
      }
    },
    {
      "@type": "Question",
      "name": "How do I use anybrowse with Claude Code or Cursor?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Add this to your MCP config: {\\"mcpServers\\":{\\"anybrowse\\":{\\"url\\":\\"https://anybrowse.dev/mcp\\"}}}. anybrowse exposes scrape, crawl, and search tools."
      }
    },
    {
      "@type": "Question",
      "name": "Does anybrowse render JavaScript?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. anybrowse uses real Chrome browsers (Playwright) with full JavaScript rendering. It handles SPAs, dynamic content, and client-side rendered pages."
      }
    },
    {
      "@type": "Question",
      "name": "Do I need an API key to use anybrowse?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. anybrowse uses x402 micropayments instead of API keys. Send a request, receive a 402 with payment instructions, sign with your crypto wallet, and resend. No signup or account needed."
      }
    },
    {
      "@type": "Question",
      "name": "What is x402?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "x402 is an open micropayment protocol using HTTP 402 status codes. It enables pay-per-request APIs without API keys or subscriptions. Payments are made in USDC on the Base network."
      }
    },
    {
      "@type": "Question",
      "name": "How does anybrowse compare to other web scraping APIs?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "anybrowse is optimized for LLM consumption with real Chrome rendering, MCP-native agent integration, and pay-per-use micropayments. No API keys, no subscriptions, no rate limit tiers. Just send USDC per request."
      }
    },
    {
      "@type": "Question",
      "name": "What format does anybrowse return?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "anybrowse returns clean, structured Markdown optimized for LLM consumption. The response includes the page title, URL, full markdown content, and a status field."
      }
    }
  ]
}
</script>
</head>
<body>

<div class="header">
<svg class="logo" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-label="anybrowse logo" role="img">
<defs><clipPath id="gc"><circle cx="100" cy="100" r="72"/></clipPath></defs>
<circle cx="100" cy="100" r="72" fill="none" stroke="#1a1a1a" stroke-width="3.5"/>
<g clip-path="url(#gc)" fill="none" stroke="#1a1a1a" stroke-width="1.8">
<line x1="28" y1="100" x2="172" y2="100"/>
<line x1="36" y1="68" x2="164" y2="68"/>
<line x1="36" y1="132" x2="164" y2="132"/>
<ellipse cx="100" cy="100" rx="26" ry="72"/>
<ellipse cx="100" cy="100" rx="56" ry="72"/>
</g>
<line x1="100" y1="28" x2="100" y2="154" stroke="#d94400" stroke-width="7"/>
<polygon points="85,148 100,172 115,148" fill="#d94400"/>
</svg>
<span class="wordmark">any<b>browse</b></span>
</div>

<div class="virgil-labels">
<span class="vl">AGENT TO AGENT</span>
<span class="vl">WEB BRIDGE</span>
<span class="vl">BYPASS</span>
<span class="version">v1.0</span>
</div>

<div class="nav-links">
<a href="/docs">Documentation</a>
<a href="/pricing">Pricing</a>
</div>

<h1><span class="q">ANY URL</span> <span class="arrow">&rarr;</span> MARKDOWN</h1>
<p class="sub"><strong>$0.002</strong> per scrape &middot; <strong>$0.01</strong> per crawl &middot; No API key &middot; No signup &middot; Paid in USDC on Base</p>

<pre id="cmd" tabindex="0" role="button" aria-label="Copy curl command" onclick="cp(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();cp(this)}"><span class="d">$</span> <span class="c">curl</span> <span class="f">-X POST</span> https://anybrowse.dev/scrape <span class="f">\\</span>
  <span class="f">-H</span> <span class="s">"Content-Type: application/json"</span> <span class="f">\\</span>
  <span class="f">-d</span> <span class="s">'{"url": "https://example.com"}'</span>

<span class="d">&larr;</span> <span class="f">200</span>  <span class="d"># Example Domain</span>
<span class="d"># Full markdown content returned...</span></pre>

<div class="live">
<span class="ll"><span class="dot"></span> Live</span>
<span class="m"><span class="v" id="sr">-</span> requests</span>
<span class="m"><span class="v" id="se">-</span> earned</span>
<span class="m"><span class="v" id="su">-</span> uptime</span>
</div>

<h2>ENDPOINTS</h2>
<div class="ep">
<div class="er">
<div class="el"><span class="em">POST</span> <span class="epath">/scrape</span> <span class="edesc">url to markdown</span></div>
<span class="eprice">$0.002</span>
</div>
<div class="er">
<div class="el"><span class="em">POST</span> <span class="epath">/crawl</span> <span class="edesc">search + scrape</span></div>
<span class="eprice">$0.01</span>
</div>
<div class="er">
<div class="el"><span class="em">POST</span> <span class="epath">/serp/search</span> <span class="edesc">raw search</span></div>
<span class="eprice">$0.002</span>
</div>
<div class="er">
<div class="el"><span class="em">POST</span> <span class="epath">/mcp</span> <span class="edesc">agent tooling</span></div>
<span class="eprice fr">free</span>
</div>
</div>

<h2>MCP SERVER</h2>
<p class="co">for Claude Code, Cursor, Windsurf</p>
<div class="mc">{
  <span class="mk">"mcpServers"</span>: {
    <span class="mk">"anybrowse"</span>: {
      <span class="mk">"type"</span>: <span class="ms">"streamable-http"</span>,
      <span class="mk">"url"</span>: <span class="ms">"https://anybrowse.dev/mcp"</span>
    }
  }
}</div>

<h2>PAYMENT</h2>
<p class="pay">All paid endpoints use <a href="https://www.x402.org">x402</a> micropayments on Base. Send a request without payment &mdash; receive a <code>402</code> with instructions. Sign with your wallet, resend with the <code>X-PAYMENT</code> header. No signup. No API keys.</p>

<footer>
<a href="/.well-known/agent-card.json">agent card</a> &middot; <a href="/stats">stats</a> &middot; <a href="/health">health</a> &middot; <a href="/earnings">earnings</a> &middot; <a href="/mcp">mcp</a> &middot; <a href="/docs">docs</a> &middot; <a href="/pricing">pricing</a><br>
<span class="mn">anybrowse.base.eth</span><br>
<span class="mn" style="font-size:.65rem;color:#999">0x8D76E8FB38541d70dF74b14660c39b4c5d737088</span><br>
<span id="ps"></span>
</footer>

<script>
function cp(e){try{navigator.clipboard.writeText('curl -X POST https://anybrowse.dev/scrape -H "Content-Type: application/json" -d \\'{"url":"https://example.com"}\\'');e.classList.add("ok");setTimeout(function(){e.classList.remove("ok")},1400)}catch(err){}}
function ls(){
fetch("/stats").then(function(r){return r.json()}).then(function(s){
var h=Math.floor(s.uptimeSeconds/3600),m=Math.floor((s.uptimeSeconds%3600)/60);
document.getElementById("su").textContent=h>0?h+"h "+m+"m":m+"m";
document.getElementById("sr").textContent=s.totalRequests.toLocaleString();
return fetch("/earnings")}).then(function(r){return r.json()}).then(function(e){
document.getElementById("se").textContent="$"+parseFloat(e.estimatedEarningsUSDC||"0").toFixed(3)
}).catch(function(){document.querySelector(".dot").style.background="#ef4444";document.querySelector(".dot").style.boxShadow="0 0 6px #ef444480"})}
ls();setInterval(ls,30000);
document.getElementById("ps").textContent="This page is "+(new Blob([document.documentElement.outerHTML]).size/1024).toFixed(1)+"KB.";
</script>
</body>
</html>
`;

const LANDING_JSON = {
  name: "anybrowse",
  description: "Autonomous web browsing agent. Converts any URL to clean, LLM-ready Markdown.",
  url: "https://anybrowse.dev",
  version: "1.0.0",
  capabilities: [
    { endpoint: "POST /scrape", description: "Convert any URL to Markdown", price: "$0.002 USDC" },
    { endpoint: "POST /crawl", description: "Search + scrape top results", price: "$0.01 USDC" },
    { endpoint: "POST /serp/search", description: "Multi-engine search results (Google, Bing, DuckDuckGo)", price: "$0.002 USDC" },
    { endpoint: "POST /mcp", description: "MCP tool server (JSON-RPC 2.0)", price: "free" },
  ],
  protocols: ["x402", "a2a", "mcp"],
  payment: {
    network: "base-mainnet",
    asset: "USDC",
    address: "0x8D76E8FB38541d70dF74b14660c39b4c5d737088",
  },
  links: {
    agentCard: "/.well-known/agent-card.json",
    mcp: "/mcp",
    stats: "/stats",
    health: "/health",
    earnings: "/earnings",
    docs: "/docs",
    pricing: "/pricing",
  },
};

// ── IP extraction helper ─────────────────────────────────────────────────────
// nginx sets X-Real-IP to $remote_addr (cannot be spoofed by client).
// trustProxy is disabled — we extract the real IP ourselves.
import type { FastifyRequest } from "fastify";

function getClientIp(req: FastifyRequest): string {
  // nginx sets X-Real-IP from $remote_addr — this is the authoritative source
  return (req.headers['x-real-ip'] as string) || req.socket.remoteAddress || 'unknown';
}

// ── Structured failure logging ────────────────────────────────────────────────
// Writes JSON log lines to /agent/data/api-failures.jsonl for querying.
// Each line: { ts, endpoint, failure_reason, client_ip, latency_ms, user_agent, api_key, status_code }
const FAILURE_LOG_PATH = "/agent/data/api-failures.jsonl";

/** Map status codes to human-readable failure reasons */
function inferFailureReason(statusCode: number, explicitReason?: string): string {
  if (explicitReason) return explicitReason;
  switch (statusCode) {
    case 400: return 'bad_request';
    case 401: return 'unauthorized';
    case 402: return 'payment_required';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 422: return 'scrape_failed';
    case 429: return 'rate_limited';
    case 500: return 'internal_error';
    case 502: return 'bad_gateway';
    case 503: return 'service_unavailable';
    case 504: return 'timeout';
    default: return statusCode >= 500 ? 'server_error' : 'client_error';
  }
}

function logApiFailure(opts: {
  endpoint: string;
  failureReason: string;
  clientIp: string;
  latencyMs: number;
  userAgent: string;
  apiKey: string;
  statusCode: number;
}): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      endpoint: opts.endpoint,
      failure_reason: opts.failureReason,
      client_ip: opts.clientIp,
      latency_ms: opts.latencyMs,
      user_agent: opts.userAgent.slice(0, 200),
      api_key: opts.apiKey,
      status_code: opts.statusCode,
    }) + '\n';
    appendFileSync(FAILURE_LOG_PATH, line);
  } catch {
    // Never let logging failures crash the app
  }
}

async function buildServer() {
  // trustProxy disabled: we use X-Real-IP (set by nginx from $remote_addr)
  // to prevent rate-limit bypass via X-Forwarded-For header spoofing
  const app = Fastify({ logger: true, trustProxy: false });
  await app.register(cors, { origin: true });

  // ── Remove server fingerprinting headers ──────────────────────────────────
  app.addHook('onSend', async (_req, reply) => {
    reply.removeHeader('X-Powered-By');
    reply.removeHeader('Server');
  });

  // ── Raw body capture for Stripe webhook signature verification ──
  // Override default JSON parser to also store raw Buffer on request.
  // All routes still receive parsed JSON; /webhook gets rawBody too.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body: Buffer, done) => {
      (req as any).rawBody = body;
      try {
        done(null, JSON.parse(body.toString("utf-8")));
      } catch (err: any) {
        done(err, undefined);
      }
    }
  );

  // x402 payment gate (returns 402 for paid routes without X-PAYMENT header)
  const paymentsEnabled = process.env.ENABLE_PAYMENTS !== "false";
  if (paymentsEnabled) {
    await app.register(paymentGate);
    console.log("[anybrowse] x402 payment gate enabled");
  }

  // Stats tracking hook — record every response
  app.addHook("onResponse", async (req, reply) => {
    const path = req.url.split("?")[0];
    const responseTime = reply.elapsedTime;
    const hadPayment = !!req.headers["x-payment"];
    const ua = (req.headers["user-agent"] as string) || "";
    const ip = getClientIp(req);

    // Determine if this request should be excluded from all metrics
    const ownerExclude = !!(req as any).excludeFromStats;
    const excluded = ownerExclude || shouldExcludeFromStats(hashIp(ip), ua, path);

    if (!excluded) {
      stats.recordRequest(path, reply.statusCode, responseTime, hadPayment);
    }

    // Request logging (skip /mcp — handled with session tracking in mcp-transport.ts)
    if (path !== "/mcp" && !excluded) {
      // Extract scraped URL from request body for /scrape and /crawl
      let scrapedUrl: string | undefined;
      if (path === "/scrape" || path === "/crawl") {
        const body = req.body as Record<string, unknown> | undefined;
        if (body && typeof body.url === "string") {
          scrapedUrl = body.url;
        }
      }
      logRequest(await buildLogEntry({
        endpoint: path,
        ua,
        ip,
        statusCode: reply.statusCode,
        ms: responseTime,
        url: scrapedUrl,
      }));
      // Track successful API requests for funnel analytics
      if (reply.statusCode < 400 && (path === "/scrape" || path === "/crawl" || path === "/serp/search" || path === "/extract")) {
        const ipHash = hashIp(ip);
        const isAgent = !ua.includes('Mozilla') || ua.toLowerCase().includes('python') || ua.toLowerCase().includes('curl');
        let scrapedDomain = '';
        try { scrapedDomain = new URL(scrapedUrl || '').hostname; } catch {}
        trackEvent('api_request', {
          endpoint: path,
          client: isAgent ? 'agent' : 'browser',
          statusCode: reply.statusCode,
          success: true,
          domain: scrapedDomain,
        }, ipHash);
      }
      // Track errors and rate limit hits
      if (reply.statusCode >= 400 && (path === "/scrape" || path === "/crawl" || path === "/serp/search" || path === "/extract")) {
        const ipHash = hashIp(ip);
        const isAgent = !ua.includes('Mozilla') || ua.toLowerCase().includes('python') || ua.toLowerCase().includes('curl');
        trackEvent('api_error', {
          endpoint: path,
          client: isAgent ? 'agent' : 'browser',
          statusCode: reply.statusCode,
          isRateLimit: reply.statusCode === 402,
        }, ipHash);
      }

      // ── Structured failure logging (JSON lines for querying) ──────────────
      // Log ALL 4xx/5xx on API endpoints with full context.
      const API_LOG_PATHS = new Set([
        '/scrape', '/crawl', '/serp/search', '/serp',
        '/extract', '/batch', '/aggregate', '/aggregate/stream',
      ]);
      if (reply.statusCode >= 400 && API_LOG_PATHS.has(path)) {
        const authHeader = (req.headers['authorization'] as string) || '';
        const apiKeyRaw = authHeader.startsWith('Bearer ') ? authHeader.slice(7) :
          ((req.headers['x-api-key'] as string) || '');
        // Mask: show first 8 chars only (e.g. ab_owner → ab_owner...)
        const apiKeyMasked = apiKeyRaw ? apiKeyRaw.slice(0, 8) + '...' : 'none';
        const explicitReason = (req as any).failureReason as string | undefined;
        logApiFailure({
          endpoint: path,
          failureReason: inferFailureReason(reply.statusCode, explicitReason),
          clientIp: ip,
          latencyMs: Math.round(responseTime),
          userAgent: ua,
          apiKey: apiKeyMasked,
          statusCode: reply.statusCode,
        });
      }
    }
  });

  // Landing page
  app.get("/", async (req, reply) => {
    const accept = req.headers.accept || "";
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return reply.send(LANDING_JSON);
    }
    try {
      const landingPath = join(__dirname, "static", "landing.html");
      const landingHtml = readFileSync(landingPath, "utf-8");
      reply.type("text/html").send(landingHtml);
    } catch (err) {
      // Fallback to embedded landing page if file not found
      reply.type("text/html").send(LANDING_HTML);
    }
  });

  // Health check endpoint (enhanced)
  app.get("/health", async () => {
    const snapshot = stats.getSnapshot();
    const healthStatus = getHealthStatus();
    return {
      ok: true,
      agent: "anybrowse",
      version: "1.0.0",
      payments: paymentsEnabled,
      uptime: snapshot.uptimeSeconds,
      totalRequests: snapshot.totalRequests,
      health: healthStatus ? {
        healthy: healthStatus.healthy,
        lastCheck: healthStatus.lastCheck,
        memory: healthStatus.checks.memory,
        pool: healthStatus.checks.pool,
      } : null,
      warmer: getWarmerStatus(),
    };
  });

  // Stats endpoint (free) — filtered to hide attack probe paths and bot traffic
  app.get("/stats", async () => {
    const snapshot = stats.getSnapshot();
    const filteredEndpoints: Record<string, any> = {};
    for (const [path, data] of Object.entries(snapshot.endpoints)) {
      if (KNOWN_PATHS.has(path)) {
        filteredEndpoints[path] = data;
      }
    }
    // Add client breakdown from last 30 days of request-log.jsonl
    const clients = getClientBreakdown(30);
    // Clean 7-day count from SQLite (excludes bots/health/internal)
    const clean7d = getCleanRequestCount(7);
    return {
      ...snapshot,
      endpoints: filteredEndpoints,
      clients,
      realRequests7d: clean7d.clean,
      filteredOut7d: clean7d.filteredOut,
      note: 'Excludes registry probers, health checks, WP scanners, and internal/owner traffic. realRequests7d shows the clean 7-day count from request log.',
    };
  });

  // ── /status: public success-rate benchmark by domain category ─────────────
  // Cached for 1 hour. Powers the live benchmark page.
  let statusCache: { data: any; expiresAt: number } | null = null;

  app.get("/status", async (req, reply) => {
    const now = Date.now();
    if (statusCache && now < statusCache.expiresAt) {
      return reply.header("Cache-Control", "public, max-age=3600").send(statusCache.data);
    }

    try {
      // Query SQLite: group by target_category, count success vs total
      const rows = db.prepare(`
        SELECT
          target_category,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count
        FROM requests
        WHERE endpoint IN ('/scrape', '/crawl')
          AND target_category IS NOT NULL
          AND target_category != ''
          AND ts > 0
        GROUP BY target_category
        ORDER BY total DESC
      `).all() as Array<{ target_category: string; total: number; success_count: number }>;

      const categories: Record<string, { success: number; total: number; rate: string }> = {};
      let overallSuccess = 0;
      let overallTotal = 0;

      for (const row of rows) {
        const cat = row.target_category || 'other';
        const success = Number(row.success_count) || 0;
        const total = Number(row.total) || 0;
        categories[cat] = {
          success,
          total,
          rate: total > 0 ? (success / total * 100).toFixed(1) + '%' : 'n/a',
        };
        overallSuccess += success;
        overallTotal += total;
      }

      const result = {
        categories,
        overall: {
          success: overallSuccess,
          total: overallTotal,
          rate: overallTotal > 0 ? (overallSuccess / overallTotal * 100).toFixed(1) + '%' : 'n/a',
        },
        benchmark: {
          note: 'Measured success rates across representative URL samples.',
          categories: {
            'general_websites': { rate: '90%+', description: 'News, blogs, documentation, public sites' },
            'javascript_spa': { rate: '80%', description: 'React/Vue/Angular single-page applications' },
            'cloudflare_protected': { rate: '70%', description: 'Sites behind Cloudflare bot protection' },
            'social_media': { rate: '60%', description: 'Twitter, LinkedIn, Reddit, and similar' },
            'paywalled_content': { rate: '20%', description: 'Sites requiring subscriptions or login' },
          },
          scrape_overall: '84%',
          search_overall: '62%',
          crawl_overall: '75%',
          powered_by: ['rebrowser-patches stealth mode', 'CapSolver CAPTCHA solving', '50 Chrome workers (Windows relay)', 'residential proxy fallback'],
        },
        updatedAt: new Date().toISOString(),
        note: 'Live success rates by URL category. Cached 1h. See benchmark field for category breakdown.',
      };

      // Cache for 1 hour
      statusCache = { data: result, expiresAt: now + 3_600_000 };
      return reply.header("Cache-Control", "public, max-age=3600").send(result);
    } catch (err: any) {
      return reply.status(500).send({ error: "Failed to compute status", message: err.message });
    }
  });

  // Earnings endpoint (free) — filtered to hide attack probe paths
  app.get("/earnings", async () => {
    const snapshot = stats.getSnapshot();
    return {
      agent: "anybrowse",
      wallet: "0x8D76E8FB38541d70dF74b14660c39b4c5d737088",
      network: "base-mainnet",
      asset: "USDC",
      totalPayments: snapshot.totalPayments,
      estimatedEarningsUSDC: snapshot.estimatedEarningsUSDC,
      breakdown: Object.entries(snapshot.endpoints)
        .filter(([path]) => KNOWN_PATHS.has(path))
        .map(([path, ep]) => ({
          endpoint: path,
          payments: ep.x402Payments,
          totalRequests: ep.total,
        })),
    };
  });

  // Insights endpoint (owner-only) — analytics on who is calling anybrowse
  app.get("/insights", async (req, reply) => {
    const ownerKey = process.env.OWNER_API_KEY || process.env.ADMIN_SECRET_TOKEN;
    if (!ownerKey) {
      return reply.status(503).send({ error: "Insights not configured (no owner key)" });
    }

    // Accept X-Admin-Token header or Authorization: Bearer {key}
    const adminToken = req.headers["x-admin-token"] as string | undefined;
    const authHeader = req.headers["authorization"] as string | undefined;
    let providedKey: string | undefined;
    if (adminToken) {
      providedKey = adminToken;
    } else if (authHeader?.startsWith("Bearer ")) {
      providedKey = authHeader.slice(7).trim();
    }

    if (!providedKey || providedKey !== ownerKey) {
      return reply.status(401).send({ error: "Unauthorized. Provide X-Admin-Token or Authorization: Bearer <owner_key>" });
    }

    const insights = computeInsights();
    return insights;
  });

  // Admin: add IP to exclusion list (owner key only)
  app.post("/admin/exclude-ip", async (req, reply) => {
    const ownerKey = process.env.OWNER_API_KEY || process.env.ADMIN_SECRET_TOKEN;
    if (!ownerKey) {
      return reply.status(503).send({ error: "Not configured (no owner key)" });
    }

    const adminToken = req.headers["x-admin-token"] as string | undefined;
    const authHeader = req.headers["authorization"] as string | undefined;
    let providedKey: string | undefined;
    if (adminToken) {
      providedKey = adminToken;
    } else if (authHeader?.startsWith("Bearer ")) {
      providedKey = authHeader.slice(7).trim();
    }

    if (!providedKey || providedKey !== ownerKey) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const body = req.body as any;
    const ipHash = (body?.ip_hash as string || '').trim();
    const reason = (body?.reason as string || 'manually excluded').trim();

    if (!ipHash || ipHash.length < 8) {
      return reply.status(400).send({ error: "ip_hash must be at least 8 hex chars" });
    }

    const ok = addExcludedIp(ipHash, reason);
    if (!ok) {
      return reply.status(500).send({ error: "Failed to persist exclusion" });
    }

    return {
      ok: true,
      ip_hash: ipHash.slice(0, 8),
      reason,
      message: `IP hash ${ipHash.slice(0, 8)} added to exclusion list`,
      allExclusions: getDynamicExclusions(),
    };
  });

  // Admin: list all excluded IPs (owner key only)
  app.get("/admin/exclude-ip", async (req, reply) => {
    const ownerKey = process.env.OWNER_API_KEY || process.env.ADMIN_SECRET_TOKEN;
    if (!ownerKey) return reply.status(503).send({ error: "Not configured" });

    const adminToken = req.headers["x-admin-token"] as string | undefined;
    const authHeader = req.headers["authorization"] as string | undefined;
    let providedKey: string | undefined;
    if (adminToken) providedKey = adminToken;
    else if (authHeader?.startsWith("Bearer ")) providedKey = authHeader.slice(7).trim();

    if (!providedKey || providedKey !== ownerKey) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    return {
      staticExclusions: ['5c2a3f8f'],
      dynamicExclusions: getDynamicExclusions(),
    };
  });

  // Data export endpoint (owner-only) — CSV of last N days of requests
  app.get("/data-export", async (req, reply) => {
    const ownerKey = process.env.OWNER_API_KEY || process.env.ADMIN_SECRET_TOKEN;
    if (!ownerKey) {
      return reply.status(503).send({ error: "Data export not configured (no owner key)" });
    }

    const adminToken = req.headers["x-admin-token"] as string | undefined;
    const authHeader = req.headers["authorization"] as string | undefined;
    let providedKey: string | undefined;
    if (adminToken) {
      providedKey = adminToken;
    } else if (authHeader?.startsWith("Bearer ")) {
      providedKey = authHeader.slice(7).trim();
    }

    if (!providedKey || providedKey !== ownerKey) {
      return reply.status(401).send({ error: "Unauthorized. Provide X-Admin-Token or Authorization: Bearer <owner_key>" });
    }

    const query = req.query as Record<string, string>;
    const days = Math.min(Math.max(parseInt(query.days || "30", 10), 1), 365);
    const format = query.format || "csv";

    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      const rows = db.prepare(`
        SELECT
          id, ts, endpoint, client, ua, ip_hash,
          country, country_code, city, org,
          target_url, target_domain, target_category,
          status, response_ms,
          mcp_tool, mcp_session, is_agent
        FROM requests
        WHERE ts >= ?
        ORDER BY ts DESC
        LIMIT 100000
      `).all(sinceMs) as Array<Record<string, unknown>>;

      if (format === "json") {
        return reply.header("Content-Type", "application/json").send(rows);
      }

      // CSV output
      const headers = [
        "id", "ts", "endpoint", "client", "ua", "ip_hash",
        "country", "country_code", "city", "org",
        "target_url", "target_domain", "target_category",
        "status", "response_ms", "mcp_tool", "mcp_session", "is_agent"
      ];

      const escape = (v: unknown): string => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      const lines = [
        headers.join(","),
        ...rows.map(row => headers.map(h => escape(row[h])).join(","))
      ];

      const csv = lines.join("\n");
      const filename = `anybrowse-requests-${days}d-${new Date().toISOString().slice(0, 10)}.csv`;

      return reply
        .header("Content-Type", "text/csv")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(csv);

    } catch (err: any) {
      return reply.status(500).send({ error: "Export failed", message: err.message });
    }
  });

  // Capability gaps endpoint (free)
  app.get("/gaps", async () => {
    const intel = intelligence.getSnapshot();
    return {
      gaps: intel.capabilityGaps,
      quality: intel.quality,
    };
  });

  // Autonomy status endpoint — redacted public version
  app.get("/autonomy", async () => {
    const healthStatus = getHealthStatus();
    return {
      status: "operational",
      healer: healthStatus ? {
        healthy: healthStatus.healthy,
        lastCheck: healthStatus.lastCheck,
      } : null,
      version: "1.0.0",
    };
  });

  // Register route handlers
  await registerSerpRoutes(app);
  await registerCrawlRoutes(app);
  await registerBatchRoutes(app);
  await registerWatchRoutes(app);
  await registerExtractRoutes(app);
  await registerAggregateRoutes(app);
  registerAggregateStreamRoutes(app);
  await registerMcpRoute(app);
  const relayMod = await loadRelay();
  if (relayMod) {
    try { relayMod.registerRelayRoutes(app); } catch (err) { console.error('[relay] Route registration failed:', err); }
  }

  // Documentation page (public)
  app.get("/docs", async (req, reply) => {
    try {
      const docsPath = join(__dirname, "static", "docs.html");
      const docsHtml = readFileSync(docsPath, "utf-8");
      reply.type("text/html").send(docsHtml);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load documentation" });
    }
  });

  // x402 payment integration guide
  app.get("/docs/x402", async (req, reply) => {
    try {
      const html = readFileSync(join(__dirname, "static", "docs-x402.html"), "utf-8");
      reply.type("text/html").send(html);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load x402 documentation" });
    }
  });

  // Pricing page (public)
  app.get("/pricing", async (req, reply) => {
    try {
      const pricingPath = join(__dirname, "static", "pricing.html");
      const pricingHtml = readFileSync(pricingPath, "utf-8");
      reply.type("text/html").send(pricingHtml);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load pricing page" });
    }
  });

  // Terms of Service page
  app.get("/tos", async (req, reply) => {
    try {
      const tosPath = join(__dirname, "static", "tos.html");
      const tosHtml = readFileSync(tosPath, "utf-8");
      reply.type("text/html").send(tosHtml);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load terms of service" });
    }
  });

  // Privacy Policy page
  app.get("/privacy", async (req, reply) => {
    try {
      const privacyPath = join(__dirname, "static", "privacy.html");
      const privacyHtml = readFileSync(privacyPath, "utf-8");
      reply.type("text/html").send(privacyHtml);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load privacy policy" });
    }
  });

  app.get("/integrations", async (req, reply) => {
    try {
      reply.type("text/html").send(readFileSync(join(__dirname, "static", "integrations.html"), "utf-8"));
    } catch (err) {
      reply.status(500).send({ error: "Failed to load integrations page" });
    }
  });

  // Benchmark page
  app.get("/benchmark", async (req, reply) => {
    try {
      const benchPath = join(__dirname, "static", "benchmark.html");
      const benchHtml = readFileSync(benchPath, "utf-8");
      reply.type("text/html").send(benchHtml);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load benchmark page" });
    }
  });

  // Comparison pages
  app.get("/vs/firecrawl", async (req, reply) => {
    try {
      const html = readFileSync(join(__dirname, "static", "vs-firecrawl.html"), "utf-8");
      reply.type("text/html").send(html);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load page" });
    }
  });

  app.get("/vs/jina", async (req, reply) => {
    try {
      const html = readFileSync(join(__dirname, "static", "vs-jina.html"), "utf-8");
      reply.type("text/html").send(html);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load page" });
    }
  });

  app.get("/vs/diffbot", async (req, reply) => {
    try {
      const html = readFileSync(join(__dirname, "static", "vs-diffbot.html"), "utf-8");
      reply.type("text/html").send(html);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load page" });
    }
  });

  app.get("/landing-v2", async (req, reply) => {
    try {
      const html = readFileSync(join(__dirname, "static", "landing-v2.html"), "utf-8");
      reply.type("text/html").send(html);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load page" });
    }
  });

  // Blog post: benchmarking web scraping APIs
  app.get("/blog/benchmarking-web-scraping-apis", async (req, reply) => {
    try {
      const html = readFileSync(join(__dirname, "static", "blog", "benchmarking-web-scraping-apis.html"), "utf-8");
      reply.type("text/html").send(html);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load blog post" });
    }
  });

  // ── Static asset downloads (zip, png, etc.) ──
  app.get("/windows-relay-setup.ps1", async (req, reply) => {
    try {
      const file = readFileSync(join(__dirname, "static", "windows-relay-setup.ps1"), "utf-8");
      reply.type("text/plain").send(file);
    } catch { reply.status(404).send({ error: "not_found" }); }
  });
  app.get("/anybrowse-relay.zip", async (req, reply) => {
    try {
      const data = readFileSync(join(__dirname, "static", "anybrowse-relay.zip"));
      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", 'attachment; filename="anybrowse-relay.zip"');
      reply.send(data);
    } catch { reply.status(404).send({ error: "not_found" }); }
  });
  app.get("/icon128.png", async (req, reply) => {
    try {
      const data = readFileSync(join(__dirname, "static", "icon128.png"));
      reply.header("Content-Type", "image/png");
      reply.send(data);
    } catch { reply.status(404).send({ error: "not_found" }); }
  });
  app.get("/screenshot-1280x800.png", async (req, reply) => {
    try {
      const data = readFileSync(join(__dirname, "static", "screenshot-1280x800.png"));
      reply.header("Content-Type", "image/png");
      reply.send(data);
    } catch { reply.status(404).send({ error: "not_found" }); }
  });

  // ── Simple in-memory rate limiter for /checkout (max 10/IP/minute) ──
  const checkoutRateMap = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of checkoutRateMap.entries()) {
      if (now >= entry.resetAt) checkoutRateMap.delete(ip);
    }
  }, 60_000);

  function checkoutRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = checkoutRateMap.get(ip);
    if (!entry || now >= entry.resetAt) {
      checkoutRateMap.set(ip, { count: 1, resetAt: now + 60_000 });
      return true; // allowed
    }
    if (entry.count >= 10) return false; // blocked
    entry.count++;
    return true; // allowed
  }

  // ── Stripe: POST /checkout ─────────────────────────────────────────
  // Creates a Stripe Checkout session for the $4.99/mo Pro subscription.
  app.post("/checkout", async (req, reply) => {
    const clientIp = getClientIp(req);
    if (!checkoutRateLimit(clientIp)) {
      return reply.status(429).send({ error: "Too many requests. Please try again later." });
    }
    if (!STRIPE_ENABLED) {
      return reply.status(503).send({
        error: "Stripe payments are not yet configured. Please check back soon.",
        stripe_configured: false,
      });
    }
    try {
      const origin = `${req.protocol}://${req.hostname}`;
      const session = await createCheckoutSession(
        `${origin}/checkout/success`,
        `${origin}/checkout/cancel`
      );
      // Redirect to Stripe Checkout
      reply.redirect(session.url!);
    } catch (err: any) {
      console.error("[stripe] Checkout error:", err.message);
      reply.status(500).send({ error: "Failed to create checkout session" });
    }
  });

  // ── Stripe: GET /checkout — ToS agreement page before payment ────────
  app.get("/checkout", async (req, reply) => {
    if (!STRIPE_ENABLED) {
      return reply.redirect("/pricing");
    }
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subscribe to Pro — anybrowse</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='none' stroke='%231a1a1a' stroke-width='3'/><line x1='50' y1='10' x2='50' y2='80' stroke='%23ff4a00' stroke-width='5'/><polygon points='40,75 50,92 60,75' fill='%23ff4a00'/></svg>">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Helvetica Neue",Helvetica,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f4f0eb;color:#1a1a1a;max-width:480px;margin:0 auto;padding:4rem 1.5rem 2.5rem;line-height:1.7;-webkit-font-smoothing:antialiased}
.header{display:flex;align-items:center;gap:1rem;margin-bottom:3rem}
.logo{width:40px;height:40px;flex-shrink:0}
.wordmark{font-size:1.1rem;font-weight:300;letter-spacing:.04em}
.wordmark b{font-weight:700}
h1{font-size:1.6rem;font-weight:800;letter-spacing:-.02em;margin-bottom:.5rem}
.plan-box{background:#fff;border:1px solid #d94400;border-radius:8px;padding:1.25rem 1.4rem;margin:1.5rem 0}
.plan-name{font-size:.55rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#767676;margin-bottom:.25rem}
.plan-price{font-size:1.8rem;font-weight:800;color:#1a1a1a;line-height:1.2}
.plan-price small{font-size:.7rem;font-weight:400;color:#767676}
.plan-features{font-size:.85rem;color:#555;margin-top:.75rem;padding-left:1.1rem;line-height:1.7}
.plan-features li{margin-bottom:.1rem}
.agree-row{display:flex;align-items:flex-start;gap:.75rem;margin:1.75rem 0 1.5rem;background:#fff;border:1px solid #e0dcd7;border-radius:6px;padding:.9rem 1.1rem}
.agree-row input[type=checkbox]{width:16px;height:16px;margin-top:.2rem;accent-color:#d94400;flex-shrink:0;cursor:pointer}
.agree-label{font-size:.875rem;color:#444;line-height:1.55;cursor:pointer}
.agree-label a{color:#d94400;text-decoration:none}
.agree-label a:hover{text-decoration:underline}
.btn{display:block;width:100%;padding:.8rem 1rem;background:#d94400;color:#fff;border:none;border-radius:6px;font-size:.95rem;font-weight:700;cursor:pointer;text-align:center;transition:background .15s;font-family:inherit;letter-spacing:.01em}
.btn:hover:not(:disabled){background:#c03800}
.btn:disabled{background:#ccc;cursor:not-allowed}
.back{margin-top:1.25rem;text-align:center;font-size:.8rem;color:#767676}
.back a{color:#767676;text-decoration:none}
.back a:hover{color:#1a1a1a;text-decoration:underline}
</style>
</head>
<body>
<div class="header">
  <svg class="logo" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="50" cy="50" r="40" stroke="#1a1a1a" stroke-width="3"/>
    <line x1="50" y1="10" x2="50" y2="80" stroke="#d94400" stroke-width="5"/>
    <polygon points="40,75 50,92 60,75" fill="#d94400"/>
  </svg>
  <div class="wordmark"><b>any</b>browse</div>
</div>

<h1>Subscribe to Pro</h1>
<p style="color:#555;font-size:.9rem">One step away. Review your plan and agree to continue.</p>

<div class="plan-box">
  <div class="plan-name">Pro</div>
  <div class="plan-price">$4.99<small>/month</small></div>
  <ul class="plan-features">
    <li>1,000 scrapes/day</li>
    <li>API key for authenticated access</li>
    <li>Priority rendering</li>
    <li>Cancel anytime</li>
  </ul>
</div>

<form action="/checkout" method="POST" id="checkout-form">
  <div class="agree-row">
    <input type="checkbox" id="tos-agree" name="tos_agree" required>
    <label class="agree-label" for="tos-agree">
      I agree to the <a href="/tos" target="_blank">Terms of Service</a> and <a href="/privacy" target="_blank">Privacy Policy</a>
    </label>
  </div>
  <button type="submit" class="btn" id="submit-btn" disabled>Continue to payment &rarr;</button>
</form>

<div class="back"><a href="/pricing">&larr; Back to pricing</a></div>

<script>
var cb = document.getElementById('tos-agree');
var btn = document.getElementById('submit-btn');
cb.addEventListener('change', function() { btn.disabled = !cb.checked; });
</script>
</body>
</html>`;
    reply.type("text/html").send(html);
  });

  // ── Stripe: GET /checkout/success ──────────────────────────────────
  app.get("/checkout/success", async (req, reply) => {
    const { session_id } = req.query as { session_id?: string };
    let apiKey: string | null = null;
    let email: string | null = null;

    if (session_id && STRIPE_ENABLED) {
      const result = await getCheckoutSession(session_id);
      apiKey = result.apiKey;
      email = result.email;
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to Pro — anybrowse</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Helvetica Neue",Helvetica,system-ui,sans-serif;background:#f4f0eb;color:#1a1a1a;max-width:600px;margin:0 auto;padding:4rem 1.5rem 2.5rem;line-height:1.7}
h1{font-size:2rem;font-weight:800;margin-bottom:.5rem;color:#1a1a1a}
.emoji{font-size:3rem;margin-bottom:1rem;display:block}
p{color:#555;margin-bottom:1.5rem}
.key-box{background:#fff;border:2px solid #d94400;border-radius:8px;padding:1.25rem 1.5rem;margin:1.5rem 0}
.key-box .label{font-size:.65rem;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#767676;margin-bottom:.5rem}
.key-box code{font-family:"SF Mono",monospace;font-size:1rem;color:#1a1a1a;word-break:break-all;font-weight:600}
.copy-btn{display:inline-block;margin-top:.75rem;padding:.4rem 1rem;background:#d94400;color:#fff;border:none;border-radius:4px;font-size:.8rem;font-weight:600;cursor:pointer;letter-spacing:.04em}
.copy-btn:hover{background:#c03800}
.usage{background:#fff;border:1px solid #e0dcd7;border-radius:8px;padding:1.25rem 1.5rem;margin:1.5rem 0;font-size:.875rem}
.usage h3{font-size:.65rem;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#767676;margin-bottom:.75rem}
pre.ex{background:#1a1a1a;color:#f4f0eb;border-radius:6px;padding:1rem 1.25rem;font-family:"SF Mono",monospace;font-size:.78rem;line-height:1.6;margin:.75rem 0;overflow-x:auto}
.orange{color:#d94400}
a{color:#d94400;text-decoration:none}
a:hover{text-decoration:underline}
.back{margin-top:2rem;font-size:.875rem}
</style>
</head>
<body>
<span class="emoji">🎉</span>
<h1>You're on Pro!</h1>
<p>Your subscription is active. You get <strong>10,000 scrapes/month</strong>. Save your API key below — it's your access credential.</p>

${
  apiKey
    ? `<div class="key-box">
  <div class="label">Your API Key</div>
  <code id="apk">${apiKey}</code><br>
  <button class="copy-btn" onclick="navigator.clipboard.writeText('${apiKey}');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy Key',1500)">Copy Key</button>
</div>
<p style="font-size:.8rem;color:#999">⚠️ Store this key safely. It won't be shown again.</p>`
    : `<div class="key-box">
  <div class="label">API Key</div>
  <code>Your key will arrive via webhook confirmation. If you don't see it, check your Stripe receipt email.</code>
</div>`
}

<div class="usage">
  <h3>How to use your key</h3>
  <pre class="ex"><span class="orange">curl</span> -X POST https://anybrowse.dev/scrape \\
  -H <span class="orange">"Authorization: Bearer ${apiKey || "ab_YOUR_KEY_HERE"}"</span> \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com"}'</pre>
  <p>Or use the <code>X-API-Key</code> header:</p>
  <pre class="ex"><span class="orange">curl</span> -X POST https://anybrowse.dev/scrape \\
  -H <span class="orange">"X-API-Key: ${apiKey || "ab_YOUR_KEY_HERE"}"</span> \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com"}'</pre>
</div>

<p class="back"><a href="/">← Back to anybrowse</a> &middot; <a href="/docs">Documentation</a></p>
</body>
</html>`;
    reply.type("text/html").send(html);
  });

  // ── Stripe: GET /checkout/cancel ───────────────────────────────────
  app.get("/checkout/cancel", async (req, reply) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout cancelled — anybrowse</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Helvetica Neue",Helvetica,system-ui,sans-serif;background:#f4f0eb;color:#1a1a1a;max-width:600px;margin:0 auto;padding:4rem 1.5rem 2.5rem;line-height:1.7}
h1{font-size:2rem;font-weight:800;margin-bottom:.5rem}
p{color:#555;margin-bottom:1.5rem}
a{color:#d94400;text-decoration:none}
a:hover{text-decoration:underline}
.emoji{font-size:3rem;margin-bottom:1rem;display:block}
</style>
</head>
<body>
<span class="emoji">↩️</span>
<h1>No problem.</h1>
<p>Checkout was cancelled. You can try again any time.</p>
<p><a href="/pricing">← View pricing</a> &middot; <a href="/">Back to home</a></p>
</body>
</html>`;
    reply.type("text/html").send(html);
  });

  // ── Credit packs: GET /credits ─────────────────────────────────────
  app.get("/credits", async (req, reply) => {
    try {
      const html = readFileSync(join(__dirname, "static", "credits.html"), "utf-8");
      reply.type("text/html").send(html);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load credits page" });
    }
  });

  // ── Free tier email upgrade ────────────────────────────────────────
  // GET /upgrade-free — HTML page for email signup
  app.get("/upgrade-free", async (req, reply) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Get 50 free scrapes per day — anybrowse</title>
<meta name="description" content="Enter your email and get 50 free scrapes per day. No credit card. Resets at midnight UTC.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='none' stroke='%231a1a1a' stroke-width='3'/><line x1='50' y1='10' x2='50' y2='80' stroke='%23ff4a00' stroke-width='5'/><polygon points='40,75 50,92 60,75' fill='%23ff4a00'/></svg>">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Helvetica Neue",Helvetica,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f4f0eb;color:#1a1a1a;max-width:520px;margin:0 auto;padding:4rem 1.5rem 2.5rem;line-height:1.7;-webkit-font-smoothing:antialiased}
.logo{font-size:.85rem;font-weight:300;letter-spacing:.1em;text-transform:lowercase;color:#767676;margin-bottom:3rem;display:block;text-decoration:none}
.logo b{font-weight:700;color:#1a1a1a}
h1{font-size:2.2rem;font-weight:800;letter-spacing:-.03em;line-height:1.1;margin-bottom:.75rem;color:#1a1a1a}
.sub{font-size:1rem;color:#555;margin-bottom:2.5rem}
form{display:flex;flex-direction:column;gap:.75rem}
input[type=email]{padding:.85rem 1rem;border:1px solid #ddd8d2;border-radius:6px;font-size:1rem;background:#fff;color:#1a1a1a;font-family:inherit;outline:none;transition:border-color .15s}
input[type=email]:focus{border-color:#d94400}
button{padding:.85rem 1.5rem;background:#1a1a1a;color:#fff;border:none;border-radius:6px;font-size:.95rem;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s}
button:hover{background:#d94400}
button:disabled{opacity:.5;cursor:not-allowed}
.note{font-size:.8rem;color:#999;margin-top:.5rem}
.success{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:1.25rem;color:#166534;font-size:.95rem;display:none}
.error-msg{background:#fff5f5;border:1px solid #fecaca;border-radius:6px;padding:1rem;color:#991b1b;font-size:.9rem;display:none}
a{color:#d94400;text-decoration:none}
</style>
</head>
<body>
<a class="logo" href="/"><b>any</b>browse</a>
<h1>Get 50 free scrapes per day</h1>
<p class="sub">Enter your email. We send one welcome email. That is it.</p>
<div class="success" id="success">
  You now have 50 free scrapes per day. Resets at midnight UTC. Check your inbox for a welcome note.
</div>
<div class="error-msg" id="error-msg"></div>
<form id="form">
  <input type="email" id="email" placeholder="you@example.com" autocomplete="email" required>
  <button type="submit" id="btn">Get 50 free scrapes per day</button>
  <p class="note">No credit card needed. Free forever. Resets daily at midnight UTC.</p>
</form>
<script>
document.getElementById('form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const btn = document.getElementById('btn');
  const email = document.getElementById('email').value.trim();
  const successEl = document.getElementById('success');
  const errorEl = document.getElementById('error-msg');
  btn.disabled = true;
  btn.textContent = 'One moment...';
  errorEl.style.display = 'none';
  try {
    const res = await fetch('/upgrade-free', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      document.getElementById('form').style.display = 'none';
      successEl.style.display = 'block';
    } else {
      errorEl.textContent = data.error || 'Something went wrong. Please try again.';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Get 50 free scrapes per day';
    }
  } catch (err) {
    errorEl.textContent = 'Network error. Please try again.';
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Get 50 free scrapes per day';
  }
});
</script>
</body>
</html>`;
    reply.type("text/html").send(html);
  });

  // POST /upgrade-free — accept email, add to ConvertKit, upgrade IP tier
  app.post("/upgrade-free", async (req, reply) => {
    const { email, ip: bodyIp } = req.body as any;
    if (!email || typeof email !== "string") {
      return reply.status(400).send({ error: "Missing email" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return reply.status(400).send({ error: "Invalid email format" });
    }

    const clientIp = bodyIp || req.ip || "unknown";
    const ipHash = createHash("sha256").update(clientIp).digest("hex").slice(0, 8);

    // Add to local SQLite email_subscribers for self-hosted drip
    try {
      addEmailSubscriber(email, ipHash);
      console.log(`[upgrade-free] Added subscriber: ${email}`);
    } catch (err: any) {
      console.error(`[upgrade-free] addEmailSubscriber failed: ${err.message}`);
    }

    // Add to ConvertKit
    const convertKitKey = process.env.CONVERTKIT_KEY || "";
    if (convertKitKey) {
      try {
        const ckRes = await fetch("https://api.kit.com/v4/subscribers", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${convertKitKey}`,
          },
          body: JSON.stringify({
            email_address: email,
            tags: ["anybrowse-free-upgrade"],
          }),
        });
        if (!ckRes.ok) {
          const ckBody = await ckRes.text();
          console.error(`[upgrade-free] ConvertKit error ${ckRes.status}: ${ckBody}`);
        } else {
          console.log(`[upgrade-free] ConvertKit subscriber added: ${email}`);
        }
      } catch (err: any) {
        console.error(`[upgrade-free] ConvertKit fetch failed: ${err.message}`);
      }
    } else {
      console.warn("[upgrade-free] CONVERTKIT_KEY not set — skipping ConvertKit sync");
    }

    // Upgrade IP to email-verified tier
    emailVerifiedIps.add(clientIp);
    console.log(`[upgrade-free] IP ${clientIp} upgraded to email tier`);

    trackEvent("email_upgrade", { email: email.replace(/(.{2}).*(@.*)/, "$1***$2"), ip: clientIp });

    return reply.send({
      success: true,
      message: "You now have 50 free scrapes/day. Resets at midnight UTC.",
    });
  });

  // ── Credit packs: POST /credits/checkout ──────────────────────────
  // Body: { pack: 'starter'|'growth'|'scale', email?: string }
  app.post("/credits/checkout", async (req, reply) => {
    if (!CREDITS_STRIPE_ENABLED) {
      return reply.status(503).send({ error: "Credit purchases not yet configured." });
    }
    const { pack, email } = req.body as any;
    if (!pack) return reply.status(400).send({ error: "Missing pack" });
    try {
      const url = await createCreditCheckout(pack, email);
      const packInfo = CREDIT_PACKS.find(p => p.id === pack);
      trackEvent('checkout_started', {
        pack,
        price: packInfo?.price,
        credits: packInfo?.credits,
      }, email || 'anonymous');
      reply.send({ url });
    } catch (err: any) {
      console.error("[credits] Checkout error:", err.message);
      reply.status(400).send({ error: err.message });
    }
  });

  // ── Credit packs: GET /credits/success ────────────────────────────
  // After Stripe payment — retrieve session, show API key
  app.get("/credits/success", async (req, reply) => {
    const { session_id } = req.query as { session_id?: string };
    let apiKey: string | null = null;
    let email: string | null = null;
    let credits: number | null = null;

    if (session_id && CREDITS_STRIPE_ENABLED) {
      const result = await getCreditCheckoutSession(session_id);
      apiKey = result.apiKey;
      email = result.email;
      credits = result.credits;
    }

    // If no API key yet (webhook may be pending), serve a waiting page
    try {
      let html = readFileSync(join(__dirname, "static", "credits-success.html"), "utf-8");
      // Inject API key and credits into the page
      html = html
        .replace("__API_KEY__", apiKey || "")
        .replace("__CREDITS__", credits ? credits.toLocaleString() : "")
        .replace("__SESSION_ID__", session_id || "");
      reply.type("text/html").send(html);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load success page" });
    }
  });

  // ── Credit packs: GET /credits/balance ────────────────────────────
  // Header: Authorization: Bearer <api_key>
  app.get("/credits/balance", async (req, reply) => {
    const authHeader = req.headers["authorization"] as string | undefined;
    const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
    let key: string | undefined;
    if (authHeader?.startsWith("Bearer ")) {
      key = authHeader.slice(7).trim();
    } else if (apiKeyHeader) {
      key = apiKeyHeader.trim();
    }
    if (!key) {
      return reply.status(400).send({ error: "Provide Authorization: Bearer <api_key> or X-API-Key header" });
    }
    const credits = getCredits(key);
    return reply.send({ credits, key: key.slice(0, 12) + "..." });
  });

  // ── Stripe Customer Portal: GET /manage ──────────────────────────
  app.get("/manage", async (req, reply) => {
    try {
      const html = readFileSync(join(__dirname, "static", "manage.html"), "utf-8");
      return reply.type("text/html").send(html);
    } catch (err) {
      return reply.status(500).send({ error: "Failed to load manage page" });
    }
  });

  // ── Stripe Customer Portal: POST /portal ──────────────────────────
  app.post("/portal", async (req, reply) => {
    const { email } = req.body as { email?: string };
    if (!CREDITS_STRIPE_ENABLED || !creditsStripe) {
      return reply.status(503).send({ error: "Payments not configured" });
    }
    if (!email) {
      return reply.status(400).send({ error: "email is required" });
    }
    try {
      const customers = await creditsStripe.customers.list({ email, limit: 1 });
      if (!customers.data.length) {
        return reply.status(404).send({ error: "No subscription found for this email. Contact hello@anybrowse.dev" });
      }
      const session = await creditsStripe.billingPortal.sessions.create({
        customer: customers.data[0].id,
        return_url: "https://anybrowse.dev/dashboard",
      });
      return reply.redirect(session.url);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Dashboard: GET /dashboard ─────────────────────────────────────
  app.get("/dashboard", async (req, reply) => {
    try {
      const html = readFileSync(join(__dirname, "static", "dashboard.html"), "utf-8");
      return reply.type("text/html").send(html);
    } catch (err) {
      return reply.status(500).send({ error: "Failed to load dashboard" });
    }
  });

  // ── Dashboard: GET /dashboard/data ────────────────────────────────
  app.get("/dashboard/data", async (req, reply) => {
    const key = (req.query as any).key as string | undefined;
    if (!key) return reply.status(400).send({ error: "key required" });

    // Look up credits row to determine if key exists and credits remaining
    const row = db.prepare(
      "SELECT credits_remaining, email, created_at, last_used FROM api_credits WHERE api_key = ?"
    ).get(key) as { credits_remaining: number; email: string; created_at: number; last_used: number | null } | undefined;

    const credits = row?.credits_remaining ?? 0;
    const keyType = row ? "credit_pack" : "unknown";

    // Usage counts from purchase history (credits used = purchased - remaining)
    const purchaseRow = db.prepare(
      "SELECT SUM(credits) as total_purchased FROM credit_purchases WHERE api_key = ?"
    ).get(key) as { total_purchased: number | null } | undefined;

    const totalPurchased = purchaseRow?.total_purchased ?? 0;
    const usageTotal = totalPurchased - credits;

    return reply.send({
      credits,
      usageTotal: Math.max(0, usageTotal),
      usageToday: 0,
      keyType,
      email: row?.email ?? null,
      memberSince: row?.created_at ?? null,
      lastUsed: row?.last_used ?? null,
    });
  });

  // ── Stripe: POST /webhook ──────────────────────────────────────────
  // Stripe sends events here. Must be registered with raw body.
  app.post("/webhook", async (req, reply) => {
    const sig = req.headers["stripe-signature"] as string | undefined;
    const rawBody = (req as any).rawBody as Buffer | undefined;

    if (!sig) {
      return reply.status(400).send({ error: "Missing stripe-signature header" });
    }
    if (!rawBody) {
      return reply.status(400).send({ error: "Missing raw body" });
    }

    try {
      // Pass raw body + sig to the subscription webhook handler first
      // Then also handle credit pack payments
      await handleWebhookEvent(rawBody, sig);

      // Credit pack webhook handling — parse event ourselves for credit purchases
      try {
        const { stripe: subsStripe } = await import("./stripe-subscriptions.js");
        if (subsStripe) {
          const event = subsStripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET || "");

          // ── Webhook event deduplication ──────────────────────────────────
          // Prevents double-processing if Stripe retries a webhook event.
          const eventId = event.id;
          db.exec(`CREATE TABLE IF NOT EXISTS processed_webhooks (
            event_id TEXT PRIMARY KEY,
            processed_at INTEGER NOT NULL
          )`);
          const existingEvent = db.prepare('SELECT event_id FROM processed_webhooks WHERE event_id = ?').get(eventId);
          if (existingEvent) {
            console.log('[webhook] Duplicate event ignored:', eventId);
            return reply.status(200).send({ received: true, duplicate: true });
          }
          db.prepare('INSERT INTO processed_webhooks (event_id, processed_at) VALUES (?, ?)').run(eventId, Date.now());
          if (event.type === "checkout.session.completed") {
            const session = event.data.object as any;
            if (session.metadata?.type === "credit_pack" && session.metadata?.pack_id && session.metadata?.credits) {
              const credits = parseInt(session.metadata.credits);
              const email = session.customer_email || "";
              const packId = session.metadata.pack_id;
              const apiKey = generateCreditApiKey();
              addCredits(apiKey, email, credits, packId, session.id);
              console.log(`[credits] Issued API key ${apiKey.slice(0, 14)}... with ${credits} credits to ${email}`);
              trackEvent('payment_completed', {
                pack: packId,
                credits,
                amount: session.amount_total,
              }, email || 'anonymous');

              // Send confirmation email with API key
              if (isMailerEnabled() && email) {
                const pack = CREDIT_PACKS.find(p => p.id === packId);
                const packName = pack?.name || packId;
                sendEmail({
                  to: email,
                  subject: `Your anybrowse API key — ${packName} (${credits.toLocaleString()} credits)`,
                  text: [
                    `Thanks for purchasing the ${packName}!`,
                    ``,
                    `Your API key: ${apiKey}`,
                    `Credits: ${credits.toLocaleString()}`,
                    ``,
                    `Usage:`,
                    `  curl -X POST https://anybrowse.dev/scrape \\`,
                    `    -H "Authorization: Bearer ${apiKey}" \\`,
                    `    -H "Content-Type: application/json" \\`,
                    `    -d '{"url":"https://example.com"}'`,
                    ``,
                    `Check balance: GET https://anybrowse.dev/credits/balance`,
                    `  Authorization: Bearer ${apiKey}`,
                    ``,
                    `Credits never expire. Top up anytime at https://anybrowse.dev/credits`,
                    ``,
                    `— anybrowse team`,
                  ].join("\n"),
                  html: `
<div style="font-family:Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:2rem;background:#f4f0eb;color:#1a1a1a">
<h2 style="color:#d94400;margin-bottom:0.5rem">Your API key is ready!</h2>
<p style="color:#555">Thanks for purchasing the <strong>${packName}</strong>.</p>
<div style="background:#fff;border:2px solid #d94400;border-radius:8px;padding:1.25rem;margin:1.5rem 0">
  <div style="font-size:0.65rem;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#767676;margin-bottom:0.5rem">YOUR API KEY</div>
  <code style="font-family:monospace;font-size:1rem;word-break:break-all;font-weight:600">${apiKey}</code>
</div>
<p style="color:#555"><strong>${credits.toLocaleString()} credits</strong> loaded. 1 credit = 1 scrape. Credits never expire.</p>
<h3 style="margin-top:1.5rem;margin-bottom:0.5rem">Usage</h3>
<pre style="background:#1a1a1a;color:#f4f0eb;border-radius:6px;padding:1rem;font-size:0.78rem;overflow-x:auto">curl -X POST https://anybrowse.dev/scrape \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com"}'</pre>
<p style="margin-top:1.5rem"><a href="https://anybrowse.dev/docs" style="color:#d94400">Docs</a> &middot; <a href="https://anybrowse.dev/credits/balance" style="color:#d94400">Check balance</a> &middot; <a href="https://anybrowse.dev/credits" style="color:#d94400">Top up credits</a></p>
</div>`,
                }).catch((err: any) => {
                  console.error(`[credits] Failed to send confirmation email to ${email}:`, err.message);
                });
              }
            }
          }
        }
      } catch (creditErr: any) {
        // Non-fatal — credit webhook processing failed but subscription webhook succeeded
        console.error("[credits] Credit webhook processing error:", creditErr.message);
      }

      reply.status(200).send({ received: true });
    } catch (err: any) {
      console.error("[stripe] Webhook error:", err.message);
      reply.status(400).send({ error: "Invalid webhook" });
    }
  });

  // ── Stripe: GET /subscription/status ──────────────────────────────
  // Check subscription status for a given API key
  app.get("/subscription/status", async (req, reply) => {
    const authHeader = req.headers["authorization"] as string | undefined;
    const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
    let apiKey: string | undefined;
    if (authHeader?.startsWith("Bearer ab_")) {
      apiKey = authHeader.slice(7).trim();
    } else if (apiKeyHeader?.startsWith("ab_")) {
      apiKey = apiKeyHeader.trim();
    }

    if (!apiKey) {
      return reply.status(400).send({ error: "Provide Authorization: Bearer ab_xxxx or X-API-Key: ab_xxxx" });
    }

    const record = getSubscriptionStatus(apiKey);
    if (!record) {
      return reply.status(404).send({ error: "API key not found" });
    }

    return {
      status: record.status,
      usageThisPeriod: record.usageThisPeriod,
      monthlyLimit: 10000,
      remaining: Math.max(0, 10000 - record.usageThisPeriod),
      currentPeriodEnd: record.currentPeriodEnd,
    };
  });

  // Blog index page (public)
  app.get("/blog", async (req, reply) => {
    try {
      const blogIndexPath = join(__dirname, "static", "blog", "index.html");
      const blogHtml = readFileSync(blogIndexPath, "utf-8");
      reply.type("text/html").send(blogHtml);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load blog index" });
    }
  });

  // Individual blog posts (public) - serve markdown files with HTML wrapper
  app.get("/blog/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const validSlugs = [
      "url-to-markdown-complete-guide",
      "rag-pipeline-web-scraping",
      "anybrowse-vs-firecrawl-comparison",
      "ai-agent-use-cases",
      "scraping-best-practices",
      "perplexity-clone-tutorial",
      "markdown-vs-html-for-llms"
    ];
    
    if (!validSlugs.includes(slug)) {
      return reply.status(404).send({ error: "Blog post not found" });
    }
    
    try {
      // Map slug to file
      const fileMap: Record<string, string> = {
        "url-to-markdown-complete-guide": "01-url-to-markdown-guide.md",
        "rag-pipeline-web-scraping": "02-rag-pipeline-tutorial.md",
        "anybrowse-vs-firecrawl-comparison": "03-firecrawl-comparison.md",
        "ai-agent-use-cases": "04-ai-agent-use-cases.md",
        "scraping-best-practices": "05-scraping-best-practices.md",
        "perplexity-clone-tutorial": "06-perplexity-clone-tutorial.md",
        "markdown-vs-html-for-llms": "07-markdown-vs-html.md"
      };
      
      const mdPath = join(__dirname, "static", "blog", fileMap[slug]);
      const markdown = readFileSync(mdPath, "utf-8");
      
      // Simple HTML wrapper for markdown
      const title = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | anybrowse Blog</title>
    <meta name="description" content="${title} - Read more on the anybrowse blog.">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0a0a0f;
            --surface: #12121a;
            --border: #2a2a3a;
            --text-primary: #ffffff;
            --text-secondary: #a0a0b0;
            --text-muted: #6a6a7a;
            --accent: #0052ff;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Inter', sans-serif;
            background: var(--bg);
            color: var(--text-primary);
            line-height: 1.6;
        }
        .nav {
            position: fixed;
            top: 0; left: 0; right: 0;
            z-index: 100;
            background: rgba(10, 10, 15, 0.9);
            backdrop-filter: blur(20px);
            border-bottom: 1px solid var(--border);
        }
        .nav-container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 1rem 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .logo {
            font-size: 1.5rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--accent), #60a5fa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-decoration: none;
        }
        .nav-links { display: flex; gap: 2rem; align-items: center; }
        .nav-links a {
            color: var(--text-secondary);
            text-decoration: none;
            font-weight: 500;
        }
        .nav-links a:hover { color: var(--text-primary); }
        .content {
            max-width: 800px;
            margin: 0 auto;
            padding: 7rem 2rem 4rem;
        }
        .content h1 { font-size: 2.5rem; margin-bottom: 1.5rem; }
        .content h2 { font-size: 1.5rem; margin: 2rem 0 1rem; color: var(--accent); }
        .content h3 { font-size: 1.25rem; margin: 1.5rem 0 0.75rem; }
        .content p { margin-bottom: 1rem; color: var(--text-secondary); }
        .content pre {
            background: var(--surface);
            padding: 1rem;
            border-radius: 8px;
            overflow-x: auto;
            margin: 1rem 0;
        }
        .content code {
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.875rem;
        }
        .content ul, .content ol {
            margin: 1rem 0 1rem 2rem;
            color: var(--text-secondary);
        }
        .content li { margin-bottom: 0.5rem; }
        .content table {
            width: 100%;
            border-collapse: collapse;
            margin: 1.5rem 0;
        }
        .content th, .content td {
            padding: 0.75rem;
            text-align: left;
            border-bottom: 1px solid var(--border);
        }
        .content th {
            color: var(--text-primary);
            font-weight: 600;
        }
    </style>
</head>
<body>
    <nav class="nav">
        <div class="nav-container">
            <a href="/" class="logo">anybrowse</a>
            <div class="nav-links">
                <a href="/">Home</a>
                <a href="/blog">Blog</a>
                <a href="/docs">Docs</a>
                <a href="/pricing">Pricing</a>
            </div>
        </div>
    </nav>
    <div class="content">
        <pre>${markdown.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
    </div>
</body>
</html>`;
      
      reply.type("text/html").send(html);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load blog post" });
    }
  });

  // Sitemap - inline to ensure always up to date
  app.get("/sitemap.xml", async (req, reply) => {
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://anybrowse.dev/</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/docs</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/pricing</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/blog</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/blog/url-to-markdown-complete-guide</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/blog/rag-pipeline-web-scraping</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/blog/anybrowse-vs-firecrawl-comparison</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/blog/ai-agent-use-cases</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/blog/scraping-best-practices</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/blog/perplexity-clone-tutorial</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/blog/markdown-vs-html-for-llms</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/vault</loc>
    <lastmod>2026-03-06</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/mcp</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>https://anybrowse.dev/stats</loc>
    <lastmod>2026-02-25</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>`;
    reply.type("application/xml").send(sitemap);
  });

  // llms.txt - LLM-friendly documentation
  app.get("/llms.txt", async (req, reply) => {
    const llmsContent = `# anybrowse

> Convert any URL to LLM-ready Markdown via real Chrome browsers. Pay per request with x402 micropayments on Base. No API keys. No subscriptions.

## API Endpoints

- Scrape: POST /scrape - Convert a single URL to clean Markdown ($0.002 USDC)
- Crawl: POST /crawl - Search Google and scrape top results to Markdown ($0.01 USDC)
- Search: POST /serp/search - Multi-engine search results (Google, Bing, DuckDuckGo) as structured JSON ($0.002 USDC)

## MCP Server

Endpoint: https://anybrowse.dev/mcp
Protocol: Streamable HTTP
Tools: scrape, crawl, search

Add to Claude Code, Cursor, or Windsurf:

\`\`\`json
{"mcpServers":{"anybrowse":{"type":"streamable-http","url":"https://anybrowse.dev/mcp"}}}
\`\`\`

## Payment

Protocol: x402 (HTTP 402 Payment Required)
Network: Base (mainnet)
Asset: USDC
Wallet: 0x8D76E8FB38541d70dF74b14660c39b4c5d737088

No API keys or subscriptions needed. Send a request without payment, receive a 402 with payment instructions, sign with your wallet, resend with the X-PAYMENT header.

## Agent Discovery

- A2A Agent Card: https://anybrowse.dev/.well-known/agent-card.json
- MCP Server: https://anybrowse.dev/mcp
- Basename: anybrowse.base.eth

## Free Endpoints

- Health: GET /health
- Stats: GET /stats
- Earnings: GET /earnings
- Autonomy: GET /autonomy

## Links

- Website: https://anybrowse.dev
- GitHub: https://github.com/kc23go/anybrowse
- Extended docs: https://anybrowse.dev/llms-full.txt
`;
    reply.type("text/plain").send(llmsContent);
  });

  // Test endpoint to verify deployment
  app.get("/version", async (req, reply) => {
    reply.send({ version: "1.0.1", deployed: "2026-02-23", pricing: "updated" });
  });

  // Admin endpoint to reload/restart nginx
  // ── Admin: POST /admin/issue-key — manually issue a credit API key ──
  app.post("/admin/issue-key", async (req, reply) => {
    const ownerKey = process.env.OWNER_API_KEY || process.env.ADMIN_SECRET_TOKEN;
    const authHeader = req.headers["authorization"] as string | undefined;
    const providedKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
    if (!ownerKey || !providedKey || providedKey !== ownerKey) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const { email, credits, packId, sessionId, sendRecoveryEmail, resendApiKey, customEmailBody, customEmailSubject } = req.body as any;
    if (!email || !credits || !packId) {
      return reply.status(400).send({ error: "email, credits, packId required" });
    }
    const apiKey = generateCreditApiKey();
    addCredits(apiKey, email, parseInt(credits), packId, sessionId || `admin-issued-${Date.now()}`);

    let emailResult: string | null = null;
    if (sendRecoveryEmail) {
      const emailBody = customEmailBody || `Hi,\n\nHere is your anybrowse API key: ${apiKey}\n\nThis gives you ${parseInt(credits).toLocaleString()} scrapes.\n\ncurl -X POST https://anybrowse.dev/scrape \\\n  -H "Authorization: Bearer ${apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"url": "https://example.com"}'\n\nCheck balance: https://anybrowse.dev/credits/balance?key=${apiKey}\n\nKC\nanybrowse.dev`;
      const emailSubject = customEmailSubject || `Your anybrowse API key is ready`;
      const smtpUser = process.env.SMTP_USER || (req.body as any).smtpUser || "aikingyouknow@gmail.com";
      const smtpPass = process.env.SMTP_PASS || (req.body as any).smtpPass || "";
      if (smtpPass) {
        // Send via nodemailer SMTP
        try {
          const nodemailerMod = await import("nodemailer") as any;
          const nodemailer = nodemailerMod.default || nodemailerMod;
          // Try port 587 (STARTTLS) first, fallback to 465 (SSL)
          const transporter = nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 587,
            secure: false,
            requireTLS: true,
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000,
            auth: { user: smtpUser, pass: smtpPass }
          });
          const info = await transporter.sendMail({
            from: `"anybrowse" <${smtpUser}>`,
            to: email,
            replyTo: "hello@anybrowse.dev",
            subject: emailSubject,
            text: emailBody
          });
          emailResult = `sent:smtp:${info.messageId}`;
        } catch (err: any) {
          emailResult = `failed:smtp:${err.message}`;
        }
      } else if (resendApiKey) {
        try {
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: "hello@anybrowse.dev", to: [email], subject: emailSubject, text: emailBody, reply_to: "hello@anybrowse.dev" })
          });
          const data = await resp.json() as any;
          emailResult = resp.ok ? `sent:resend:${data.id}` : `failed:resend:${JSON.stringify(data)}`;
        } catch (err: any) {
          emailResult = `error:${err.message}`;
        }
      } else {
        const sent = await sendApiKeyEmail(email, apiKey, parseInt(credits));
        emailResult = sent ? "sent:mailer" : "failed:mailer_not_configured";
      }
    }

    return reply.send({ apiKey, email, credits: parseInt(credits), packId, emailResult });
  });

  app.get("/admin/reload-nginx", async (req, reply) => {
    const adminToken = process.env.ADMIN_SECRET_TOKEN;
    if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    try {
      const result = execSync("nginx -s reload 2>&1 || systemctl reload nginx 2>&1 || service nginx reload 2>&1", { encoding: "utf-8" });
      reply.send({ success: true, result, type: "reload" });
    } catch (err) {
      reply.status(500).send({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/admin/restart-nginx", async (req, reply) => {
    const adminToken = process.env.ADMIN_SECRET_TOKEN;
    if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    try {
      const result = execSync("systemctl restart nginx 2>&1 || service nginx restart 2>&1 || nginx -s stop && nginx 2>&1", { encoding: "utf-8" });
      reply.send({ success: true, result, type: "restart" });
    } catch (err) {
      reply.status(500).send({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Admin endpoint to fix llms.txt pricing - tries multiple locations
  // ── Admin: GET/POST /admin/user — look up user by email, adjust credits ──
  app.get("/admin/user", async (req, reply) => {
    const ownerKey = process.env.OWNER_API_KEY || process.env.ADMIN_SECRET_TOKEN;
    const authHeader = req.headers["authorization"] as string | undefined;
    const adminToken = req.headers["x-admin-token"] as string | undefined;
    const providedKey = adminToken || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined);
    if (!ownerKey || !providedKey || providedKey !== ownerKey) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const email = (req.query as any).email as string | undefined;
    if (!email) return reply.status(400).send({ error: "email query param required" });
    const rows = db.prepare(
      "SELECT api_key, email, credits_remaining, credits_purchased, created_at, last_used FROM api_credits WHERE email LIKE ?"
    ).all(`%${email}%`) as any[];
    return reply.send({ users: rows });
  });

  app.post("/admin/adjust-credits", async (req, reply) => {
    const ownerKey = process.env.OWNER_API_KEY || process.env.ADMIN_SECRET_TOKEN;
    const authHeader = req.headers["authorization"] as string | undefined;
    const adminToken = req.headers["x-admin-token"] as string | undefined;
    const providedKey = adminToken || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined);
    if (!ownerKey || !providedKey || providedKey !== ownerKey) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const { email, api_key, amount } = req.body as any;
    if (amount === undefined) return reply.status(400).send({ error: "amount required" });
    let result: any;
    let rows: any[];
    if (api_key) {
      result = db.prepare(
        "UPDATE api_credits SET credits_remaining = credits_remaining + ? WHERE api_key = ?"
      ).run(amount, api_key);
      rows = db.prepare(
        "SELECT api_key, email, credits_remaining FROM api_credits WHERE api_key = ?"
      ).all(api_key) as any[];
    } else if (email) {
      result = db.prepare(
        "UPDATE api_credits SET credits_remaining = credits_remaining + ? WHERE email LIKE ?"
      ).run(amount, `%${email}%`);
      rows = db.prepare(
        "SELECT api_key, email, credits_remaining FROM api_credits WHERE email LIKE ?"
      ).all(`%${email}%`) as any[];
    } else {
      return reply.status(400).send({ error: "email or api_key required" });
    }
    return reply.send({ updated: result.changes, users: rows });
  });

  app.get("/admin/fix-llms", async (req, reply) => {
    const adminToken = process.env.ADMIN_SECRET_TOKEN;
    if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const correctContent = [
      "# anybrowse",
      "",
      "> Convert any URL to LLM-ready Markdown via real Chrome browsers. Pay per request with x402 micropayments on Base. No API keys. No subscriptions.",
      "",
      "## API Endpoints",
      "",
      "- Scrape: POST /scrape - Convert a single URL to clean Markdown ($0.002 USDC)",
      "- Crawl: POST /crawl - Search Google and scrape top results to Markdown ($0.01 USDC)",
      "- Search: POST /serp/search - Multi-engine search results (Google, Bing, DuckDuckGo) as structured JSON ($0.002 USDC)",
      "",
      "## MCP Server",
      "",
      "Endpoint: https://anybrowse.dev/mcp",
      "Protocol: Streamable HTTP",
      "Tools: scrape, crawl, search",
      "",
      "Add to Claude Code, Cursor, or Windsurf:",
      "",
      '```json',
      '{"mcpServers":{"anybrowse":{"type":"streamable-http","url":"https://anybrowse.dev/mcp"}}}',
      '```',
      "",
      "## Payment",
      "",
      "Protocol: x402 (HTTP 402 Payment Required)",
      "Network: Base (mainnet)",
      "Asset: USDC",
      "Wallet: 0x8D76E8FB38541d70dF74b14660c39b4c5d737088",
      "",
      "No API keys or subscriptions needed. Send a request without payment, receive a 402 with payment instructions, sign with your wallet, resend with the X-PAYMENT header.",
      "",
      "## Agent Discovery",
      "",
      "- A2A Agent Card: https://anybrowse.dev/.well-known/agent-card.json",
      "- MCP Server: https://anybrowse.dev/mcp",
      "- Basename: anybrowse.base.eth",
      "",
      "## Free Endpoints",
      "",
      "- Health: GET /health",
      "- Stats: GET /stats",
      "- Earnings: GET /earnings",
      "- Autonomy: GET /autonomy",
      "",
      "## Links",
      "",
      "- Website: https://anybrowse.dev",
      "- GitHub: https://github.com/kc23go/anybrowse",
      "- Extended docs: https://anybrowse.dev/llms-full.txt",
      ""
    ].join("\n");

    const results: any[] = [];
    const paths = [
      join(__dirname, "static", "llms.txt"),
      "/agent/app/dist/static/llms.txt",
      "/var/www/anybrowse/static/llms.txt",
      "/usr/share/nginx/html/llms.txt",
      "/etc/nginx/html/llms.txt"
    ];

    for (const path of paths) {
      try {
        writeFileSync(path, correctContent, "utf-8");
        // Verify write by reading back
        const verifyContent = readFileSync(path, "utf-8").substring(0, 50);
        results.push({ path, success: true, verify: verifyContent });
      } catch (err) {
        results.push({ path, success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    reply.send({ results, contentPreview: correctContent.substring(0, 100) });
  });

  // llms-summary.txt - Short version for LLMs
  app.get("/llms-summary.txt", async (req, reply) => {
    try {
      const llmsPath = join(__dirname, "static", "llms-summary.txt");
      const llmsContent = readFileSync(llmsPath, "utf-8");
      reply.type("text/plain").send(llmsContent);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load llms-summary.txt" });
    }
  });

  // ── /capture-email: lead capture endpoint ─────────────────────────
  // Simple in-memory rate limiter (5 requests/IP/minute)
  const emailCaptureRateMap = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of emailCaptureRateMap.entries()) {
      if (now >= entry.resetAt) emailCaptureRateMap.delete(ip);
    }
  }, 60_000);

  function emailCaptureRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = emailCaptureRateMap.get(ip);
    if (!entry || now >= entry.resetAt) {
      emailCaptureRateMap.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= 5) return false;
    entry.count++;
    return true;
  }

  app.post("/capture-email", async (req, reply) => {
    const clientIp = getClientIp(req);
    if (!emailCaptureRateLimit(clientIp)) {
      return reply.status(429).send({ error: "Too many requests. Please try again later." });
    }

    const body = req.body as { email?: string; source?: string };
    const email = body?.email;
    const source = body?.source;

    if (!email || typeof email !== "string") {
      return reply.status(400).send({ error: "Email is required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return reply.status(400).send({ error: "Invalid email format" });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanSource = (source && typeof source === "string") ? source.slice(0, 50).replace(/,/g, "") : "unknown";
    const timestamp = new Date().toISOString();
    // Include ip_hash so we can cross-reference payment failures later
    const ipHash = createHash("sha256").update(clientIp).digest("hex").slice(0, 8);
    const line = `${timestamp},${cleanEmail},${cleanSource},${ipHash}\n`;

    const leadsDir = "/agent/data";
    const leadsFile = "/agent/data/leads.csv";

    try {
      if (!existsSync(leadsDir)) {
        mkdirSync(leadsDir, { recursive: true });
      }
      if (!existsSync(leadsFile)) {
        // Updated header includes ip_hash for payment recovery cross-reference
        writeFileSync(leadsFile, "timestamp,email,source,ip_hash\n", "utf-8");
      }
      appendFileSync(leadsFile, line, "utf-8");
      console.log(`[capture-email] Saved: ${cleanEmail} (${cleanSource}) ip=${ipHash}`);
      trackEvent('email_captured', { source: cleanSource }, ipHash);
    } catch (err: any) {
      console.error("[capture-email] Failed to save lead:", err.message);
      // Return ok anyway — don't break UX for file write failures
    }

    return { ok: true };
  });

  // ── /vault-data: aggregated scrape log for the vault gallery ─────
  app.get("/vault-data", async (req, reply) => {
    const SCRAPE_LOG = "/agent/data/scrape-log.jsonl";
    const SCREENSHOTS_DIR = "/agent/data/screenshots";

    interface LogEntry {
      url: string;
      domain: string;
      title: string;
      timestamp: string;
      isAgent: boolean;
      count: number;
    }

    interface DomainRecord {
      domain: string;
      url: string;
      title: string;
      firstScraped: string;
      lastScraped: string;
      count: number;
      isAgent: boolean;
      hasScreenshot: boolean;
      screenshotDomain: string;
    }

    function normalizeDomain(domain: string): string {
      return domain.replace(/^www\./, '');
    }

    try {
      let lines: string[] = [];
      if (existsSync(SCRAPE_LOG)) {
        const content = readFileSync(SCRAPE_LOG, "utf-8");
        lines = content.split("\n").filter(l => l.trim());
      }

      const domainMap = new Map<string, DomainRecord>();

      for (const line of lines) {
        try {
          const entry: LogEntry = JSON.parse(line);
          const key = normalizeDomain(entry.domain);
          const existing = domainMap.get(key);
          if (!existing) {
            domainMap.set(key, {
              domain: entry.domain,
              url: entry.url,
              title: entry.title,
              firstScraped: entry.timestamp,
              lastScraped: entry.timestamp,
              count: entry.count,
              isAgent: entry.isAgent,
              hasScreenshot: false,
              screenshotDomain: entry.domain,
            });
          } else {
            // Keep latest timestamp, sum counts
            if (entry.timestamp > existing.lastScraped) {
              existing.lastScraped = entry.timestamp;
              existing.url = entry.url;
              existing.title = entry.title;
              existing.isAgent = entry.isAgent;
              // Prefer www. domain if available (better canonical form)
              if (entry.domain.startsWith('www.') && !existing.domain.startsWith('www.')) {
                existing.domain = entry.domain;
              }
            }
            if (entry.timestamp < existing.firstScraped) {
              existing.firstScraped = entry.timestamp;
            }
            existing.count += entry.count;
          }
        } catch { /* skip malformed lines */ }
      }

      // Check which domains have screenshots (try both www. and non-www variants)
      for (const record of domainMap.values()) {
        const screenshotPath1 = join(SCREENSHOTS_DIR, `${record.domain.replace(/[^a-zA-Z0-9.-]/g, '_')}.jpg`);
        const bareD = normalizeDomain(record.domain);
        const screenshotPath2 = join(SCREENSHOTS_DIR, `www.${bareD.replace(/[^a-zA-Z0-9.-]/g, '_')}.jpg`);
        record.hasScreenshot = existsSync(screenshotPath1) || existsSync(screenshotPath2);
        record.screenshotDomain = existsSync(screenshotPath1) ? record.domain
          : existsSync(screenshotPath2) ? `www.${bareD}`
          : record.domain;
      }

      const results = Array.from(domainMap.values())
        .sort((a, b) => b.lastScraped.localeCompare(a.lastScraped));

      reply.header("Cache-Control", "no-store").send(results);
    } catch (err: any) {
      reply.status(500).send({ error: "Failed to read scrape log", message: err.message });
    }
  });

  // ── /screenshots/:domain: serve screenshot images ──────────────────
  app.get("/screenshots/:domain", async (req, reply) => {
    const { domain } = req.params as { domain: string };
    // Strip .jpg extension if present
    const clean = domain.replace(/\.jpg$/, '').replace(/[^a-zA-Z0-9.-]/g, '_');
    const imgPath = `/agent/data/screenshots/${clean}.jpg`;

    if (existsSync(imgPath)) {
      const img = readFileSync(imgPath);
      reply.header("Content-Type", "image/jpeg").header("Cache-Control", "public, max-age=86400").send(img);
    } else {
      // Return SVG placeholder with domain initial
      const initial = clean.charAt(0).toUpperCase();
      const hue = clean.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="hsl(${hue},35%,88%)"/>
  <text x="640" y="440" font-family="Helvetica Neue,Helvetica,sans-serif" font-size="200" font-weight="800" fill="hsl(${hue},35%,55%)" text-anchor="middle" dominant-baseline="middle">${initial}</text>
  <text x="640" y="620" font-family="Helvetica Neue,Helvetica,sans-serif" font-size="40" fill="hsl(${hue},35%,55%)" text-anchor="middle">${clean}</text>
</svg>`;
      reply.header("Content-Type", "image/svg+xml").header("Cache-Control", "public, max-age=300").send(svg);
    }
  });

  // ── vault mockups ─────────────────────────────────────────────────
  for (const n of [1, 2, 3]) {
    app.get(`/vault-mockup-${n}.html`, async (req, reply) => {
      try {
        const p = join(__dirname, "static", `vault-mockup-${n}.html`);
        reply.type("text/html").send(readFileSync(p, "utf-8"));
      } catch { reply.status(404).send({ error: "not_found" }); }
    });
  }

  // ── /vault: the web scrape gallery page ───────────────────────────
  app.get("/vault", async (req, reply) => {
    try {
      const vaultPath = join(__dirname, "static", "vault.html");
      const vaultHtml = readFileSync(vaultPath, "utf-8");
      reply.type("text/html").send(vaultHtml);
    } catch (err) {
      reply.status(500).send({ error: "Failed to load vault page" });
    }
  });

  // ─── Agent comms endpoints ───────────────────────────────────────────────────

  // ── Simple in-memory rate limiter for /agent/message (max 10/IP/minute) ──
  const agentMessageRateMap = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of agentMessageRateMap.entries()) {
      if (now >= entry.resetAt) agentMessageRateMap.delete(ip);
    }
  }, 60_000);

  function agentMessageRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = agentMessageRateMap.get(ip);
    if (!entry || now >= entry.resetAt) {
      agentMessageRateMap.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= 10) return false;
    entry.count++;
    return true;
  }

  // POST /agent/message — agents post messages here
  app.post("/agent/message", async (req, reply) => {
    const clientIp = getClientIp(req);
    if (!agentMessageRateLimit(clientIp)) {
      return reply.status(429).send({ error: "rate_limit_exceeded" });
    }
    const { from, message, secret } = req.body as { from?: string; message?: string; secret?: string };
    if (secret !== (process.env.AGENT_COMMS_SECRET || "relay-agent-2026")) {
      return reply.status(403).send({ error: "forbidden" });
    }
    if (!from || !message) {
      return reply.status(400).send({ error: "from and message required" });
    }
    db.prepare("INSERT INTO agent_messages (from_agent, message) VALUES (?, ?)").run(from, message);
    return reply.send({ ok: true });
  });

  // GET /agent/messages — CIPHER polls for new messages
  app.get("/agent/messages", async (req, reply) => {
    const auth = (req.headers as Record<string, string>)["authorization"] || "";
    if (auth !== "Bearer ab_owner_018b73cd5702ade0f97e5855e7c80661feae22822639752e") {
      return reply.status(401).send({ error: "unauthorized" });
    }
    const messages = db.prepare("SELECT * FROM agent_messages WHERE read = 0 ORDER BY created_at ASC").all();
    if (messages.length > 0) {
      const ids = (messages as { id: number }[]).map((m) => m.id);
      db.prepare(`UPDATE agent_messages SET read = 1 WHERE id IN (${ids.map(() => "?").join(",")})`)
        .run(...ids);
    }
    return reply.send({ messages });
  });

  // 404 handler
  app.setNotFoundHandler((req, reply) => {
    return reply.status(404).send({ error: "not_found" });
  });

  return app;
}

async function main() {
  const PORT = loadEnvNumber("PORT", 8085);
  const HOST = loadEnvString("HOST", "0.0.0.0");
  const POOL_SIZE = loadEnvNumber("POOL_SIZE", 1);

  // Pre-warm browser session pool
  console.log("[anybrowse] Pre-warming session pool (size=" + POOL_SIZE + ")");
  await initPool(POOL_SIZE);

  // Start autonomy modules
  startHealer();
  startOptimizer();
  startPromoter();
  startAdvertiser();
  startWatchPoller();
  startWarmer();

  // Seed scrape-log.jsonl with known historical data (idempotent -- only writes if empty)
  try {
    const scrapeLog = "/agent/data/scrape-log.jsonl";
    const screenshotsDir = "/agent/data/screenshots";
    if (!existsSync("/agent/data")) mkdirSync("/agent/data", { recursive: true });
    if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true });
    if (!existsSync(scrapeLog)) {
      const seedEntries = [
        // youngcapital.nl — 14 scrapes
        ...Array.from({ length: 14 }, (_, i) => ({
          url: "https://www.youngcapital.nl",
          domain: "youngcapital.nl",
          title: "Young Capital | Vacatures & Tijdelijk werk",
          timestamp: new Date(Date.UTC(2026, 1, 28) + i * 3600000 * 6).toISOString(),
          isAgent: true,
          count: 1,
        })),
        // space.bilibili.com — 20 scrapes
        ...Array.from({ length: 20 }, (_, i) => ({
          url: "https://space.bilibili.com",
          domain: "space.bilibili.com",
          title: "Bilibili Space",
          timestamp: new Date(Date.UTC(2026, 1, 28) + i * 3600000 * 4).toISOString(),
          isAgent: true,
          count: 1,
        })),
        // httpbin.org
        {
          url: "https://httpbin.org",
          domain: "httpbin.org",
          title: "httpbin(1): HTTP Client Testing Service",
          timestamp: new Date(Date.UTC(2026, 1, 28)).toISOString(),
          isAgent: true,
          count: 1,
        },
        // bilibili.com
        {
          url: "https://www.bilibili.com",
          domain: "bilibili.com",
          title: "Bilibili - Anime & Manga",
          timestamp: new Date(Date.UTC(2026, 1, 28)).toISOString(),
          isAgent: true,
          count: 1,
        },
        // google.com
        {
          url: "https://www.google.com",
          domain: "google.com",
          title: "Google",
          timestamp: new Date(Date.UTC(2026, 1, 28)).toISOString(),
          isAgent: true,
          count: 1,
        },
        // goodyear.com
        {
          url: "https://www.goodyear.com",
          domain: "goodyear.com",
          title: "Goodyear Tires",
          timestamp: new Date(Date.UTC(2026, 1, 28)).toISOString(),
          isAgent: true,
          count: 1,
        },
      ];
      const lines = seedEntries.map(e => JSON.stringify(e)).join("\n") + "\n";
      writeFileSync(scrapeLog, lines, "utf-8");
      console.log("[anybrowse] Seeded scrape-log.jsonl with historical data (" + seedEntries.length + " entries)");
    }
  } catch (seedErr) {
    console.warn("[anybrowse] Failed to seed scrape-log:", seedErr instanceof Error ? seedErr.message : seedErr);
  }

  // Update static llms.txt with correct pricing
  try {
    const llmsStaticPath = join(__dirname, "static", "llms.txt");
    const correctContent = [
      "# anybrowse",
      "",
      "> Convert any URL to LLM-ready Markdown via real Chrome browsers. Pay per request with x402 micropayments on Base. No API keys. No subscriptions.",
      "",
      "## API Endpoints",
      "",
      "- Scrape: POST /scrape - Convert a single URL to clean Markdown ($0.002 USDC)",
      "- Crawl: POST /crawl - Search Google and scrape top results to Markdown ($0.01 USDC)",
      "- Search: POST /serp/search - Multi-engine search results (Google, Bing, DuckDuckGo) as structured JSON ($0.002 USDC)",
      "",
      "## MCP Server",
      "",
      "Endpoint: https://anybrowse.dev/mcp",
      "Protocol: Streamable HTTP",
      "Tools: scrape, crawl, search",
      "",
      "Add to Claude Code, Cursor, or Windsurf:",
      "",
      '```json',
      '{"mcpServers":{"anybrowse":{"type":"streamable-http","url":"https://anybrowse.dev/mcp"}}}',
      '```',
      "",
      "## Payment",
      "",
      "Protocol: x402 (HTTP 402 Payment Required)",
      "Network: Base (mainnet)",
      "Asset: USDC",
      "Wallet: 0x8D76E8FB38541d70dF74b14660c39b4c5d737088",
      "",
      "No API keys or subscriptions needed. Send a request without payment, receive a 402 with payment instructions, sign with your wallet, resend with the X-PAYMENT header.",
      "",
      "## Agent Discovery",
      "",
      "- A2A Agent Card: https://anybrowse.dev/.well-known/agent-card.json",
      "- MCP Server: https://anybrowse.dev/mcp",
      "- Basename: anybrowse.base.eth",
      "",
      "## Free Endpoints",
      "",
      "- Health: GET /health",
      "- Stats: GET /stats",
      "- Earnings: GET /earnings",
      "- Autonomy: GET /autonomy",
      "",
      "## Links",
      "",
      "- Website: https://anybrowse.dev",
      "- GitHub: https://github.com/kc23go/anybrowse",
      "- Extended docs: https://anybrowse.dev/llms-full.txt",
      ""
    ].join("\n");
    writeFileSync(llmsStaticPath, correctContent, "utf-8");
    console.log("[anybrowse] Updated static llms.txt with correct pricing");
  } catch (err) {
    console.warn("[anybrowse] Failed to update static llms.txt:", err instanceof Error ? err.message : err);
  }

  // Start server
  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  const relayMod2 = await loadRelay();
  if (relayMod2) {
    try { relayMod2.attachRelayWebSocket(app.server); } catch (err) { console.error('[relay] WebSocket attach failed:', err); }
  }
  console.log(`[anybrowse] Agent listening on http://${HOST}:${PORT}`);
  console.log("[anybrowse] Agent card: https://anybrowse.dev/.well-known/agent-card.json");
  console.log("[anybrowse] MCP server: https://anybrowse.dev/mcp");

  // Run email drip every hour
  setInterval(() => {
    runDrip().catch(err => console.error('[drip] error:', err));
  }, 60 * 60 * 1000);
  // Also run on startup (after 10s to let server settle)
  setTimeout(() => runDrip().catch(console.error), 10_000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[anybrowse] Shutting down...");
    stopHealer();
    stopOptimizer();
    stopPromoter();
    stopAdvertiser();
    stopWarmer();
    intelligence.shutdown();
    stats.shutdown();
    await app.close();
    await shutdownPool();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Global safety net — prevent unhandled rejections/exceptions from crashing pm2
process.on('unhandledRejection', (reason, _promise) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error('[anybrowse] [unhandledRejection] caught and suppressed:', msg);
  // Do NOT exit — just log. pm2 restart loop is worse than a logged error.
});

process.on('uncaughtException', (err, origin) => {
  console.error(`[anybrowse] [uncaughtException] origin=${origin}:`, err.stack || err.message);
  // Only exit on truly unrecoverable situations (e.g. not EADDRINUSE at startup)
  // For now: log and continue to prevent crash loops.
});

main().catch((err) => {
  console.error("[anybrowse] Fatal error in main():", err instanceof Error ? err.stack : err);
  process.exit(1);
});
// Deployed: Sun Mar  8 2026 — added global unhandledRejection/uncaughtException handlers
