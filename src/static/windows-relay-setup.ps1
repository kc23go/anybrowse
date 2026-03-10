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
{"name":"anybrowse-relay","version":"1.0.0","main":"launcher.js","dependencies":{"playwright":"^1.40.0","ws":"^8.0.0"}}
'@ | Set-Content C:\anybrowse-relay\package.json
$agent = @'
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
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${hash} ${status}\n`);
  } catch(e) { /* ignore log errors */ }
}
let requestsThisHour = 0;
setInterval(() => { requestsThisHour = 0; }, 3600000);
const workers = new Map();
const requestQueue = [];

// ── Resilience: catch unhandled errors so process never dies ──
process.on("uncaughtException", (err) => {
  console.error("[relay] uncaughtException:", err.message);
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} UNCAUGHT ${err.message}\n`);
  scheduleReconnect(30000);
});
process.on("unhandledRejection", (reason) => {
  console.error("[relay] unhandledRejection:", reason);
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} UNHANDLED_REJECTION ${reason}\n`);
});

// ── Reconnect guard: prevent double-reconnect when error+close both fire ──
let reconnectScheduled = false;
function scheduleReconnect(delayMs) {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  console.log(`[relay] Reconnecting in ${delayMs/1000}s...`);
  setTimeout(() => { reconnectScheduled = false; connect(); }, delayMs);
}

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
  try {
    // Only launch workers once; reuse on reconnect
    if (workers.size === 0) {
      console.log(`[relay] Starting ${MAX_WORKERS} workers...`);
      for (let i = 0; i < MAX_WORKERS; i++) {
        try { await createWorker(i); }
        catch(e) { console.error(`[relay] Worker ${i} failed to start:`, e.message); }
      }
    }
    console.log("[relay] Connecting to anybrowse.dev...");
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type:"register", relayId:RELAY_ID }));
      console.log("[relay] Connected and registered");
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
      scheduleReconnect(30000);
    });
    ws.on("error", (e) => {
      console.error("[relay] WS error:", e.message);
      // close event will fire after error; scheduleReconnect guards against double-fire
      scheduleReconnect(30000);
    });
  } catch(e) {
    console.error("[relay] connect() failed:", e.message);
    scheduleReconnect(60000);
  }
}

connect();
'@
$agent | Set-Content C:\anybrowse-relay\agent.js

# ── Launcher script: spawns 10 agent.js workers with staggered startup ──
$launcher = @'
const { spawn } = require("child_process");
const path = require("path");
const NUM_WORKERS = 10;
const WORK_DIR = "C:\\anybrowse-relay";

function spawnWorker(i) {
  const env = { ...process.env, WORKER_ID: String(i) };
  const child = spawn("node", [path.join(WORK_DIR, "agent.js")], {
    env,
    cwd: WORK_DIR,
    stdio: "inherit",
    detached: false,
    windowsHide: true
  });
  child.on("exit", (code) => {
    console.log(`[launcher] Worker ${i} exited (code=${code}), restarting in 5s...`);
    setTimeout(() => spawnWorker(i), 5000);
  });
  child.on("error", (err) => {
    console.error(`[launcher] Worker ${i} error: ${err.message}, restarting in 10s...`);
    setTimeout(() => spawnWorker(i), 10000);
  });
  console.log(`[launcher] Started worker ${i} (relay_la_windows_primary_${i})`);
}

// Stagger startup: 1 second apart so Chrome launches don't collide
for (let i = 0; i < NUM_WORKERS; i++) {
  setTimeout(() => spawnWorker(i), i * 1000);
}

console.log(`[launcher] Launching ${NUM_WORKERS} relay workers (relay_la_windows_primary_0 .. _${NUM_WORKERS - 1})`);
'@
$launcher | Set-Content C:\anybrowse-relay\launcher.js

# ── Watchdog script: restarts relay if not running ──
$watchdog = @'
$logFile = "C:\anybrowse-relay\watchdog.log"
function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

# Check if the launcher node process is running
$relayRunning = $false
try {
    $procs = Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        if ($p.CommandLine -like "*launcher.js*") {
            $relayRunning = $true
            break
        }
    }
} catch {
    Write-Log "Error checking processes: $_"
}

if (-not $relayRunning) {
    Write-Log "Relay launcher not running — starting AnybrowseRelay task..."
    try {
        Start-ScheduledTask -TaskName "AnybrowseRelay" -ErrorAction Stop
        Write-Log "AnybrowseRelay task started OK"
    } catch {
        Write-Log "Failed to start via task, launching directly: $_"
        Start-Process "node.exe" -ArgumentList "C:\anybrowse-relay\launcher.js" -WorkingDirectory "C:\anybrowse-relay" -WindowStyle Hidden
    }
} else {
    Write-Log "Relay launcher is running — OK"
}
'@
$watchdog | Set-Content C:\anybrowse-relay\watchdog.ps1

Set-Location C:\anybrowse-relay
npm install
npx playwright install chromium

# ── Main relay scheduled task (at startup, unlimited restarts) ──
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "C:\anybrowse-relay\launcher.js" -WorkingDirectory "C:\anybrowse-relay"
$triggers = @(
    $(New-ScheduledTaskTrigger -AtStartup),
    $(New-ScheduledTaskTrigger -AtLogOn)
)
# RestartCount 99 = effectively unlimited; RestartInterval 1 minute
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 99 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -StartWhenAvailable
Register-ScheduledTask -TaskName "AnybrowseRelay" -Action $action -Trigger $triggers -Settings $settings -RunLevel Highest -Force

# ── Watchdog scheduled task (every 5 minutes) ──
$wdAction = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File C:\anybrowse-relay\watchdog.ps1"
$wdTrigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 5) -Once -At (Get-Date)
$wdSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable
Register-ScheduledTask -TaskName "AnybrowseRelayWatchdog" -Action $wdAction -Trigger $wdTrigger -Settings $wdSettings -RunLevel Highest -Force

Start-ScheduledTask -TaskName "AnybrowseRelay"
Write-Host "DONE. Relay launcher running — 10 workers x 5 Chrome instances = 50 total Chrome workers. Watchdog every 5 minutes."
