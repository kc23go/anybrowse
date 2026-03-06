import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadEnvNumber, loadEnvString } from "./env.js";
import { registerSerpRoutes } from "./serp.js";
import { registerCrawlRoutes } from "./crawl.js";
import { initPool, shutdownPool } from "./pool.js";
import paymentGate from "./payment-gate.js";
import { stats } from "./stats.js";
import { startHealer, stopHealer, getHealthStatus } from "./autonomy/healer.js";
import { startOptimizer, stopOptimizer, getConfig } from "./autonomy/optimizer.js";
import { intelligence } from "./autonomy/intelligence.js";
import { startPromoter, stopPromoter, getPromotionStatus } from "./autonomy/promoter.js";
import { startAdvertiser, stopAdvertiser, getAdvertiseStatus } from "./autonomy/advertise.js";
import { registerMcpRoute } from "./mcp-transport.js";
import {
  createCheckoutSession,
  getCheckoutSession,
  handleWebhookEvent,
  getSubscriptionStatus,
  STRIPE_ENABLED,
} from "./stripe-subscriptions.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEBUG_LOG =
  process.env.DEBUG_LOG === "1" || process.env.DEBUG_LOG === "true";

// Known API paths — used to filter attack probes from public stats
const KNOWN_PATHS = new Set([
  "/", "/scrape", "/crawl", "/serp/search", "/mcp",
  "/health", "/stats", "/earnings", "/autonomy", "/gaps",
  "/.well-known/agent-card.json",
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
    { endpoint: "POST /serp/search", description: "Google search results", price: "$0.002 USDC" },
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

async function buildServer() {
  const app = Fastify({ logger: true, trustProxy: "127.0.0.1" });
  await app.register(cors, { origin: true });

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

  // Stats tracking hook \u2014 record every response
  app.addHook("onResponse", (req, reply, done) => {
    const path = req.url.split("?")[0];
    const responseTime = reply.elapsedTime;
    const hadPayment = !!req.headers["x-payment"];
    stats.recordRequest(path, reply.statusCode, responseTime, hadPayment);
    done();
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
    };
  });

  // Stats endpoint (free) — filtered to hide attack probe paths
  app.get("/stats", async () => {
    const snapshot = stats.getSnapshot();
    const filteredEndpoints: Record<string, any> = {};
    for (const [path, data] of Object.entries(snapshot.endpoints)) {
      if (KNOWN_PATHS.has(path)) {
        filteredEndpoints[path] = data;
      }
    }
    return {
      ...snapshot,
      endpoints: filteredEndpoints,
    };
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
  await registerMcpRoute(app);

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
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
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

  // ── Stripe: GET /checkout — redirect shortcut ──────────────────────
  app.get("/checkout", async (req, reply) => {
    if (!STRIPE_ENABLED) {
      return reply.redirect("/pricing");
    }
    try {
      const origin = `https://anybrowse.dev`;
      const session = await createCheckoutSession(
        `${origin}/checkout/success`,
        `${origin}/checkout/cancel`
      );
      reply.redirect(session.url!);
    } catch (err: any) {
      console.error("[stripe] Checkout error:", err.message);
      reply.redirect("/pricing");
    }
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
      await handleWebhookEvent(rawBody, sig);
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
- Search: POST /serp/search - Google SERP results as structured JSON ($0.002 USDC)

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
      "- Search: POST /serp/search - Google SERP results as structured JSON ($0.002 USDC)",
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
      "- Search: POST /serp/search - Google SERP results as structured JSON ($0.002 USDC)",
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
  console.log(`[anybrowse] Agent listening on http://${HOST}:${PORT}`);
  console.log("[anybrowse] Agent card: https://anybrowse.dev/.well-known/agent-card.json");
  console.log("[anybrowse] MCP server: https://anybrowse.dev/mcp");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[anybrowse] Shutting down...");
    stopHealer();
    stopOptimizer();
    stopPromoter();
    stopAdvertiser();
    intelligence.shutdown();
    stats.shutdown();
    await app.close();
    await shutdownPool();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[anybrowse] Fatal error:", err);
  process.exit(1);
});
// Deployed: Mon Feb 23 22:41:45 UTC 2026
