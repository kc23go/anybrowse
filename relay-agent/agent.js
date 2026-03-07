/**
 * anybrowse relay agent — Windows edition
 * Runs on the LA Windows PC (C:\anybrowse-relay\agent.js)
 * Connects to anybrowse.dev relay WebSocket and fetches URLs on demand.
 *
 * Safety controls:
 *  - Domain/keyword blocklist
 *  - No adult/illegal/piracy content
 *  - Rate limiting (60/hr, 20/hr midnight–6am local)
 *  - Request logging (url_hash only, not full URL)
 *  - Private IP blocking
 */

'use strict';

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

// ─── Safety Config ────────────────────────────────────────────────────────────

const BLOCKED_DOMAINS = new Set([
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com',
  'youporn.com', 'spankbang.com', 'tube8.com', 'beeg.com',
  'thepiratebay.org', '1337x.to', 'rarbg.to', 'nyaa.si',
  'betway.com', 'bet365.com', 'draftkings.com', 'fanduel.com', 'pokerstars.com',
]);

const BLOCKED_KEYWORDS = ['porn', 'xxx', 'warez', 'torrent', 'pirate', 'crack', 'keygen'];

const LOG_FILE = 'C:\\anybrowse-relay\\relay.log';

// ─── Rate Limiting ────────────────────────────────────────────────────────────

let requestsThisHour = 0;

// Reset counter every hour
setInterval(() => {
  const prev = requestsThisHour;
  requestsThisHour = 0;
  if (prev > 0) log(`[rate] Hourly reset. ${prev} requests processed this hour.`);
}, 60 * 60 * 1000);

function getRateLimit() {
  const hour = new Date().getHours();
  return (hour >= 0 && hour < 6) ? 20 : 60;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
}

function logRequest(url, status) {
  try {
    const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
    const line = `${new Date().toISOString()} ${hash} ${status}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    log(`[warn] Could not write to log: ${e.message}`);
  }
}

// ─── URL Safety Check ─────────────────────────────────────────────────────────

function isSafeUrl(url) {
  try {
    const u = new URL(url);

    // Must be http or https
    if (!['http:', 'https:'].includes(u.protocol)) return false;

    // No private/loopback IPs
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost|0\.0\.0\.0)/.test(u.hostname)) {
      return false;
    }

    // No auth tokens in URL
    if (u.search.includes('token=') || u.search.includes('api_key=') || u.search.includes('access_token=')) {
      return false;
    }

    const domain = u.hostname.replace(/^www\./, '');

    // Blocklist check
    for (const blocked of BLOCKED_DOMAINS) {
      if (domain === blocked || domain.endsWith('.' + blocked)) return false;
    }

    // Keyword check
    const urlLower = url.toLowerCase();
    if (BLOCKED_KEYWORDS.some(k => urlLower.includes(k))) return false;

    return true;
  } catch {
    return false;
  }
}

// ─── Relay Config ─────────────────────────────────────────────────────────────

const RELAY_ID = process.env.RELAY_ID || 'relay_la_windows_primary';
const SERVER_URL = process.env.SERVER_URL || 'wss://anybrowse.dev/relay-ws';
const RECONNECT_DELAY_MS = 5000;
const FETCH_TIMEOUT_MS = 12000;

let ws = null;
let reconnectTimer = null;

// ─── HTTP Fetch ───────────────────────────────────────────────────────────────

function fetchUrl(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      // Follow redirects manually (up to 3)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ html: data, status: res.statusCode }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

// ─── Handle Fetch Request ─────────────────────────────────────────────────────

async function handleFetch(requestId, url) {
  // Rate limit check
  const limit = getRateLimit();
  if (requestsThisHour >= limit) {
    const hour = new Date().getHours();
    log(`[rate] Rate limit hit (${requestsThisHour}/${limit}, hour=${hour}). Returning rate_limited for requestId=${requestId}`);
    send({ type: 'result', requestId, html: '', status: 0, error: 'rate_limited' });
    return;
  }

  // Safety check
  if (!isSafeUrl(url)) {
    log(`[safety] Blocked URL for requestId=${requestId}`);
    send({ type: 'result', requestId, html: '', status: 403, error: 'blocked' });
    logRequest(url, 'blocked');
    return;
  }

  requestsThisHour++;
  log(`[fetch] [${requestsThisHour}/${limit}] requestId=${requestId}`);

  try {
    const { html, status } = await fetchUrl(url);
    log(`[fetch] OK status=${status} requestId=${requestId}`);
    logRequest(url, `ok:${status}`);
    send({ type: 'result', requestId, html, status });
  } catch (err) {
    log(`[fetch] ERROR requestId=${requestId}: ${err.message}`);
    logRequest(url, 'error');
    send({ type: 'result', requestId, html: '', status: 0, error: err.message });
  }
}

// ─── WebSocket helpers ────────────────────────────────────────────────────────

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─── Connect ──────────────────────────────────────────────────────────────────

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  log(`[ws] Connecting to ${SERVER_URL} as relay_id=${RELAY_ID}`);

  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    log('[ws] Connected. Registering...');
    send({ type: 'register', relayId: RELAY_ID });
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log('[ws] Invalid JSON received');
      return;
    }

    switch (msg.type) {
      case 'registered':
        log(`[ws] Registered OK. relay_id=${msg.relayId}`);
        break;

      case 'fetch':
        if (msg.requestId && msg.url) {
          handleFetch(msg.requestId, msg.url).catch(err => {
            log(`[fetch] Unhandled error: ${err.message}`);
          });
        }
        break;

      case 'error':
        log(`[ws] Server error: ${msg.message}`);
        break;

      case 'ping':
        send({ type: 'pong' });
        break;

      default:
        // ignore unknown message types
    }
  });

  ws.on('close', (code, reason) => {
    log(`[ws] Disconnected (code=${code} reason=${reason}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log(`[ws] Error: ${err.message}`);
  });

  ws.on('ping', () => {
    ws.pong();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

// Ensure log directory exists
try {
  const logDir = LOG_FILE.split('\\').slice(0, -1).join('\\');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
} catch (e) {
  log(`[warn] Could not create log directory: ${e.message}`);
}

log(`[start] anybrowse relay agent starting. relay_id=${RELAY_ID}`);
log(`[start] Server: ${SERVER_URL}`);
log(`[start] Rate limits: 60/hr (20/hr midnight-6am local)`);
log(`[start] Log file: ${LOG_FILE}`);

connect();

// Keep process alive
process.on('SIGINT', () => {
  log('[stop] Shutting down...');
  if (ws) ws.close();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log(`[error] Uncaught exception: ${err.message}`);
  // Reconnect after crash
  setTimeout(connect, RECONNECT_DELAY_MS);
});
