New-Item -ItemType Directory -Force -Path C:\anybrowse-relay | Out-Null
$sshDir = "$env:USERPROFILE\.ssh"
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
$key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOY/gkNP+d7Gl+Q67aQie7JrVjCEdJ0YzirS7iwC5kJC cipher-openclaw"
Add-Content -Path "$sshDir\authorized_keys" -Value $key
icacls "$sshDir\authorized_keys" /inheritance:r /grant:r "${env:USERNAME}:F" | Out-Null
$sshdConfig = "C:\ProgramData\ssh\sshd_config"
if (Test-Path $sshdConfig) {
    $c = Get-Content $sshdConfig
    $c = $c -replace "#ClientAliveInterval.*","ClientAliveInterval 60"
    $c = $c -replace "#ClientAliveCountMax.*","ClientAliveCountMax 10"
    $c | Set-Content $sshdConfig
    Restart-Service sshd -ErrorAction SilentlyContinue
}
@'
{"name":"anybrowse-relay","version":"1.0.0","main":"agent.js","dependencies":{"playwright":"^1.40.0","ws":"^8.0.0"}}
'@ | Set-Content C:\anybrowse-relay\package.json
$agent = @'
const { chromium } = require("playwright");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const WS_URL = "wss://anybrowse.dev/relay-ws";
const RELAY_ID = "relay_la_windows_primary";
const MAX_WORKERS = 50;
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
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0,12);
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${hash} ${status}\n`);
}
let requestsThisHour = 0;
setInterval(() => { requestsThisHour = 0; }, 3600000);
const workers = new Map();
const requestQueue = [];
async function createWorker(id) {
  const proxy = parseProxy(getNextProxy());
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: proxy.server },
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-blink-features=AutomationControlled","--disable-dev-shm-usage"]
  });
  workers.set(id, { browser, busy: false, proxy });
  console.log(`[relay] Worker ${id} ready`);
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
  const limit = (hour >= 0 && hour < 6) ? 100 : 500;
  if (requestsThisHour >= limit) {
    ws.send(JSON.stringify({ type:"result", requestId, html:"", status:0, error:"rate_limited" }));
    return;
  }
  if (!isSafe(url)) {
    ws.send(JSON.stringify({ type:"result", requestId, html:"", status:403, error:"blocked" }));
    log(url, "blocked"); return;
  }
  const workerInfo = getWorker();
  if (!workerInfo) {
    if (requestQueue.length < 200) { requestQueue.push({ ws, requestId, url }); return; }
    ws.send(JSON.stringify({ type:"result", requestId, html:"", status:0, error:"queue_full" }));
    return;
  }
  requestsThisHour++;
  try {
    const ctx = await workerInfo.browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width:1920, height:1080 },
      httpCredentials: { username:workerInfo.proxy.username, password:workerInfo.proxy.password }
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator,"webdriver",{get:()=>undefined}); });
    await page.goto(url, { waitUntil:"domcontentloaded", timeout:20000 });
    await page.waitForTimeout(800 + Math.random()*1200);
    const html = await page.content();
    await ctx.close();
    ws.send(JSON.stringify({ type:"result", requestId, html, status:200 }));
    log(url, "ok");
    console.log(`[relay] OK ${url.slice(0,60)}`);
  } catch(e) {
    ws.send(JSON.stringify({ type:"result", requestId, html:"", status:0, error:e.message }));
    log(url, "error");
  } finally {
    const w = workers.get(workerInfo.id);
    if (w) w.busy = false;
    processQueue();
  }
}
async function connect() {
  console.log(`[relay] Starting ${MAX_WORKERS} workers...`);
  for (let i = 0; i < MAX_WORKERS; i++) await createWorker(i);
  console.log("[relay] Connecting to anybrowse.dev...");
  const ws = new WebSocket(WS_URL);
  ws.on("open", () => { ws.send(JSON.stringify({ type:"register", relayId:RELAY_ID })); console.log("[relay] Connected"); });
  ws.on("message", d => { const m = JSON.parse(d.toString()); if (m.type==="fetch") handleFetch(ws,m.requestId,m.url); });
  ws.on("close", () => { console.log("[relay] Disconnected. Reconnecting in 30s..."); setTimeout(connect,30000); });
  ws.on("error", e => console.error("[relay] Error:",e.message));
}
connect().catch(console.error);
'@
$agent | Set-Content C:\anybrowse-relay\agent.js
Set-Location C:\anybrowse-relay
npm install
npx playwright install chromium
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "C:\anybrowse-relay\agent.js" -WorkingDirectory "C:\anybrowse-relay"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)
Register-ScheduledTask -TaskName "AnybrowseRelay" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force
Start-ScheduledTask -TaskName "AnybrowseRelay"
Write-Host "DONE. Relay running with 50 Chrome workers."
