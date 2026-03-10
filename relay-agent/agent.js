const { chromium } = require("playwright");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");

const WS_URL = "wss://anybrowse.dev/relay-ws";
const WORKER_NUM = process.env.WORKER_ID || "0";
const RELAY_ID = `relay_la_windows_primary_${WORKER_NUM}`;
const MAX_WORKERS = 5;
const LOG_FILE = "C:\\anybrowse-relay\\relay.log";

const PROXY_POOL = [
  "http://14aaa55fdc22e:5cc5f8b080@161.77.10.249:12323",
  "http://14a3696c76e38:a7b82257a0@95.134.166.82:12323",
  "http://14a3696c76e38:a7b82257a0@95.134.166.221:12323",
  "http://14a3696c76e38:a7b82257a0@95.134.166.36:12323",
  "http://14a3696c76e38:a7b82257a0@95.134.166.225:12323",
  "http://14a3696c76e38:a7b82257a0@95.134.167.6:12323",
];
let proxyIndex = 0;
function getNextProxy() { return PROXY_POOL[proxyIndex++ % PROXY_POOL.length]; }
function parseProxy(p) { const m = p.match(/http:\/\/([^:]+):([^@]+)@(.+)/); return { server:"http://"+m[3], username:m[1], password:m[2] }; }

// �"?�"? Realistic Chrome user-agents (rotate to avoid fingerprint linkage) �"?�"?
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
];
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

// �"?�"? Realistic viewports �"?�"?
const VIEWPORTS = [
  { width: 1920, height: 1080 }, { width: 1536, height: 864 },
  { width: 1440, height: 900 },  { width: 1366, height: 768 },
  { width: 2560, height: 1440 }, { width: 1680, height: 1050 },
];
function randomViewport() { return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)]; }

// �"?�"? Comprehensive stealth init script �"?�"?
const STEALTH_SCRIPT = `
  // 1. Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  delete navigator.__proto__.webdriver;

  // 2. Fix chrome runtime (Cloudflare checks this)
  window.chrome = {
    runtime: { onConnect: { addListener: function(){} }, connect: function(){}, id: undefined },
    loadTimes: function(){ return {} },
    csi: function(){ return {} },
    app: { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, getDetails: function(){}, getIsInstalled: function(){ return false }, runningState: function(){ return "cannot_run" } }
  };

  // 3. Fix permissions API (Cloudflare/DataDome check notification permission)
  const origQuery = window.Permissions.prototype.query;
  window.Permissions.prototype.query = function(params) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission });
    }
    return origQuery.call(this, params);
  };

  // 4. Fix plugins array (headless has 0 plugins)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "" },
        { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "" },
        { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "" },
        { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "" },
      ];
      plugins.length = 5;
      return plugins;
    }
  });

  // 5. Fix languages (headless often has empty)
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'language', { get: () => 'en-US' });

  // 6. Fix platform consistency
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // 7. Fix WebGL vendor/renderer (headless gives "Google Inc. (Google)" which is a dead giveaway)
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Google Inc. (NVIDIA)';
    if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    return getParameter.call(this, param);
  };
  const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Google Inc. (NVIDIA)';
    if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    return getParameter2.call(this, param);
  };

  // 8. Fix connection API (headless reports different values)
  Object.defineProperty(navigator, 'connection', {
    get: () => ({
      effectiveType: '4g', rtt: 50, downlink: 10, saveData: false,
      addEventListener: function(){}, removeEventListener: function(){}
    })
  });

  // 9. Prevent iframe contentWindow detection
  const origGet = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get;
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get: function() {
      const result = origGet.call(this);
      if (this.src && this.src.startsWith('about:')) return result;
      return result;
    }
  });

  // 10. Fix toString for overridden functions (anti-detection checks Function.toString)
  const nativeToString = Function.prototype.toString;
  const overrides = new Map();
  function makeNative(fn, name) {
    overrides.set(fn, \`function \${name || fn.name || ''}() { [native code] }\`);
  }
  Function.prototype.toString = function() {
    if (overrides.has(this)) return overrides.get(this);
    return nativeToString.call(this);
  };
  makeNative(Function.prototype.toString, 'toString');
`;

const BLOCKED = new Set(["pornhub.com","xvideos.com","xnxx.com","thepiratebay.org","1337x.to"]);
const BAD_KW = ["porn","xxx","warez","torrent","crack","keygen"];
function isSafe(url) {
  try {
    const u = new URL(url);
    if (!["http:","https:"].includes(u.protocol)) return false;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost)/.test(u.hostname)) return false;
    if (BLOCKED.has(u.hostname.replace("www.",""))) return false;
    if (BAD_KW.some(k => url.toLowerCase().includes(k))) return false;
    return true;
  } catch { return false; }
}

function log(url, status) {
  try {
    const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0,12);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} W${WORKER_NUM} ${hash} ${status}\n`);
  } catch(e) { /* ignore log errors */ }
}

// �"?�"? Log rotation: keep last 5000 lines �"?�"?
function rotateLog() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) { // 5MB
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      fs.writeFileSync(LOG_FILE, lines.slice(-2000).join('\n'));
    }
  } catch(e) {}
}
setInterval(rotateLog, 600000); // every 10 min

let requestsThisHour = 0;
setInterval(() => { requestsThisHour = 0; }, 3600000);
const workers = new Map();
const requestQueue = [];

// �"?�"? Per-domain rate limiting (prevent hammering single targets) �"?�"?
const domainHits = new Map();
setInterval(() => domainHits.clear(), 60000); // reset every minute
function checkDomainRate(url) {
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    const count = domainHits.get(domain) || 0;
    if (count >= 15) return false; // max 15 req/min per domain
    domainHits.set(domain, count + 1);
    return true;
  } catch { return true; }
}

// �"?�"? Resilience �"?�"?
process.on("uncaughtException", (err) => {
  console.error("[relay] uncaughtException:", err.message);
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} UNCAUGHT ${err.message}\n`);
  scheduleReconnect(30000);
});
process.on("unhandledRejection", (reason) => {
  console.error("[relay] unhandledRejection:", reason);
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} UNHANDLED_REJECTION ${reason}\n`);
});

let reconnectScheduled = false;
function scheduleReconnect(delayMs) {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  console.log(`[relay] Reconnecting in ${delayMs/1000}s...`);
  setTimeout(() => { reconnectScheduled = false; connect(); }, delayMs);
}

// �"?�"? Worker health: recycle browsers every 100 requests to prevent memory leaks + fingerprint linkage �"?�"?
const workerRequestCount = new Map();
const RECYCLE_AFTER = 100;

async function createWorker(id) {
  const proxy = parseProxy(getNextProxy());
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: proxy.server },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--window-size=1920,1080",
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--disable-default-apps",
      "--disable-features=TranslateUI",
      "--disable-hang-monitor",
      "--disable-ipc-flooding-protection",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--metrics-recording-only",
      "--no-first-run",
      "--password-store=basic",
      "--use-mock-keychain",
      "--lang=en-US",
    ]
  });
  workers.set(id, { browser, busy: false, proxy });
  workerRequestCount.set(id, 0);
  console.log(`[relay] Worker ${id} ready (proxy: ${proxy.server})`);
}

async function recycleWorker(id) {
  try {
    const w = workers.get(id);
    if (w && w.browser) await w.browser.close().catch(() => {});
    workers.delete(id);
    await createWorker(id);
    console.log(`[relay] Worker ${id} recycled`);
  } catch(e) {
    console.error(`[relay] Worker ${id} recycle failed: ${e.message}`);
  }
}

function getWorker() {
  for (const [id, w] of workers) {
    if (!w.busy && w.browser.isConnected()) { w.busy = true; return { id, ...w }; }
  }
  return null;
}

function processQueue() {
  if (requestQueue.length > 0) {
    const next = requestQueue.shift();
    handleFetch(next.ws, next.requestId, next.url);
  }
}

async function handleFetch(ws, requestId, url) {
  const hour = new Date().getHours();
  const limit = (hour >= 0 && hour < 6) ? 200 : 800;
  if (requestsThisHour >= limit) {
    ws.send(JSON.stringify({ type:"result", requestId, html:"", status:0, error:"rate_limited" }));
    return;
  }
  if (!isSafe(url)) {
    ws.send(JSON.stringify({ type:"result", requestId, html:"", status:403, error:"blocked" }));
    log(url, "blocked"); return;
  }
  if (!checkDomainRate(url)) {
    ws.send(JSON.stringify({ type:"result", requestId, html:"", status:0, error:"domain_rate_limited" }));
    log(url, "domain_limited"); return;
  }
  const workerInfo = getWorker();
  if (!workerInfo) {
    if (requestQueue.length < 200) { requestQueue.push({ ws, requestId, url }); return; }
    ws.send(JSON.stringify({ type:"result", requestId, html:"", status:0, error:"queue_full" }));
    return;
  }
  requestsThisHour++;
  const workerId = workerInfo.id;
  try {
    const ua = randomUA();
    const vp = randomViewport();
    const ctx = await workerInfo.browser.newContext({
      userAgent: ua,
      viewport: vp,
      screen: { width: vp.width, height: vp.height },
      locale: "en-US",
      timezoneId: "America/New_York",
      httpCredentials: { username: workerInfo.proxy.username, password: workerInfo.proxy.password },
      extraHTTPHeaders: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Ch-Ua": '"Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": ua.includes("Macintosh") ? '"macOS"' : '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      javaScriptEnabled: true,
      bypassCSP: false,
      ignoreHTTPSErrors: true,
    });

    const page = await ctx.newPage();
    await page.addInitScript(STEALTH_SCRIPT);

    // Navigate with realistic timeout
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const status = resp ? resp.status() : 0;

    // Human-like wait: 1-3 seconds
    await page.waitForTimeout(1000 + Math.random() * 2000);

    // Wait a bit more for JS-rendered content
    await page.waitForLoadState("networkidle").catch(() => {});

    const html = await page.content();
    await ctx.close();

    ws.send(JSON.stringify({ type:"result", requestId, html, status }));
    log(url, `ok:${status}`);
    console.log(`[relay] OK ${status} ${url.slice(0,60)}`);
  } catch(e) {
    ws.send(JSON.stringify({ type:"result", requestId, html:"", status:0, error:e.message }));
    log(url, "error");
  } finally {
    const w = workers.get(workerId);
    if (w) w.busy = false;

    // Recycle worker after N requests
    const count = (workerRequestCount.get(workerId) || 0) + 1;
    workerRequestCount.set(workerId, count);
    if (count >= RECYCLE_AFTER) {
      workerRequestCount.set(workerId, 0);
      recycleWorker(workerId).catch(() => {});
    }

    processQueue();
  }
}

// �"?�"? Worker health check: restart dead browsers every 60s �"?�"?
setInterval(async () => {
  for (const [id, w] of workers) {
    if (!w.busy && !w.browser.isConnected()) {
      console.log(`[relay] Worker ${id} browser died, restarting...`);
      await recycleWorker(id).catch(() => {});
    }
  }
}, 60000);

async function connect() {
  try {
    if (workers.size === 0) {
      console.log(`[relay] Starting ${MAX_WORKERS} workers...`);
      for (let i = 0; i < MAX_WORKERS; i++) {
        try { await createWorker(i); }
        catch(e) { console.error(`[relay] Worker ${i} failed to start:`, e.message); }
      }
    }
    console.log("[relay] Connecting to anybrowse.dev...");
    const ws = new WebSocket(WS_URL);

    // Keepalive ping every 25s
    let pingInterval;
    ws.on("open", () => {
      ws.send(JSON.stringify({ type:"register", relayId:RELAY_ID }));
      console.log("[relay] Connected and registered");
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 25000);
    });
    ws.on("message", d => {
      try {
        const m = JSON.parse(d.toString());
        if (m.type === "fetch") handleFetch(ws, m.requestId, m.url);
      } catch(e) { /* ignore parse errors */ }
    });
    ws.on("pong", () => { /* connection alive */ });
    ws.on("close", (code, reason) => {
      console.log(`[relay] Disconnected (code=${code}). Reconnecting in 30s...`);
      clearInterval(pingInterval);
      scheduleReconnect(30000);
    });
    ws.on("error", (e) => {
      console.error("[relay] WS error:", e.message);
      clearInterval(pingInterval);
      scheduleReconnect(30000);
    });
  } catch(e) {
    console.error("[relay] connect() failed:", e.message);
    scheduleReconnect(60000);
  }
}

connect();
