/**
 * relay.ts — Browser Relay system for anybrowse
 *
 * Routes scrape requests through real Chrome browsers when blocked by Cloudflare/LinkedIn/Twitter.
 * Human volunteers install the Chrome extension, earn API credits for each successful relay.
 *
 * Architecture:
 *   AI Agent → /scrape → anybrowse detects block → relayFetch() → WebSocket → Chrome extension
 *              Chrome does the fetch in real browser → HTML back via WebSocket → markdown returned
 */

import WebSocket from 'ws';
import { createRequire } from 'module';
// Use CJS require to get WebSocketServer — ESM default import of 'ws' loses .Server in wrapper.mjs
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebSocketServer: typeof WebSocket.Server = _require('ws').Server;
import type { IncomingMessage, Server } from 'http';
import type { Socket } from 'net';
import { db, extractDomain, classifyDomain } from './db.js';
import { detectCaptchaType } from './capsolver.js';
import crypto from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RelayClient {
  ws: WebSocket;
  relayId: string;
  connectedAt: number;
  relayCount: number;
  errorStreak: number;       // consecutive errors for deprioritization
  ip: string;                // IP for self-relay detection
  deprioritized: boolean;    // flagged after 3 consecutive errors
}

// ─── State ───────────────────────────────────────────────────────────────────

export const relayPool = new Map<string, RelayClient>(); // relayId → client

/**
 * Returns the count of currently connected relay workers (open WebSocket connections).
 * Use this to check availability before routing through the Windows relay.
 */
export function getRelayWorkerCount(): number {
  return Array.from(relayPool.values()).filter(
    c => c.ws.readyState === WebSocket.OPEN
  ).length;
}

// Track daily relays per relayId: relayId → { date, count }
const dailyRelayCount = new Map<string, { date: string; count: number }>();

// Global blocked request counter (resets on restart)
let requestsBlocked = 0;

// ─── DB schema (relay_clients + relay_request_logs tables) ───────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS relay_request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    relay_id TEXT,
    url_hash TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_relay_log_ts ON relay_request_logs(ts);
  CREATE INDEX IF NOT EXISTS idx_relay_log_relay ON relay_request_logs(relay_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS relay_clients (
    relay_id TEXT PRIMARY KEY,
    email TEXT,
    created_at INTEGER NOT NULL,
    total_relays INTEGER DEFAULT 0,
    credits_earned INTEGER DEFAULT 0,
    last_seen INTEGER,
    active INTEGER DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_relay_last_seen ON relay_clients(last_seen);
  CREATE INDEX IF NOT EXISTS idx_relay_credits ON relay_clients(credits_earned DESC);
`);

// ─── Prepared statements ─────────────────────────────────────────────────────

const stmtCreateRelay = db.prepare(`
  INSERT INTO relay_clients (relay_id, email, created_at, last_seen, active)
  VALUES (@relay_id, @email, @now, @now, 1)
  ON CONFLICT(relay_id) DO NOTHING
`);

const stmtCreditRelay = db.prepare(`
  UPDATE relay_clients SET
    total_relays = total_relays + 1,
    credits_earned = credits_earned + 1,
    last_seen = @now
  WHERE relay_id = @relay_id
`);

const stmtGetStatus = db.prepare(`
  SELECT relay_id, total_relays, credits_earned, last_seen, active
  FROM relay_clients WHERE relay_id = @relay_id
`);

const stmtLeaderboard = db.prepare(`
  SELECT relay_id, total_relays, credits_earned
  FROM relay_clients
  WHERE active = 1
  ORDER BY total_relays DESC
  LIMIT 10
`);

const stmtUpdateLastSeen = db.prepare(`
  UPDATE relay_clients SET last_seen = @now WHERE relay_id = @relay_id
`);

const stmtLogRelayRequest = db.prepare(`
  INSERT INTO relay_request_logs (ts, relay_id, url_hash, status)
  VALUES (@ts, @relay_id, @url_hash, @status)
`);

// ─── UA rotation for relay messages ──────────────────────────────────────────
// Sent to Chrome extension workers so each relay request can present a different UA.
// (Extension must read data.userAgent and apply via chrome.debugger or fetch init.)
const RELAY_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function getRelayUA(): string {
  return RELAY_USER_AGENTS[Math.floor(Math.random() * RELAY_USER_AGENTS.length)];
}

// ─── URL Safety ──────────────────────────────────────────────────────────────

const RELAY_BLOCKLIST = new Set([
  'pornhub.com', 'xvideos.com', 'xhamster.com', 'redtube.com', 'youporn.com',
  'xnxx.com', 'spankbang.com', 'tube8.com', 'hardsextube.com', 'beeg.com',
  'betway.com', 'bet365.com', 'draftkings.com', 'fanduel.com', 'pokerstars.com',
  'mgm.com', '888casino.com', 'partypoker.com',
]);

export function isSafeForRelay(url: string): boolean {
  try {
    const u = new URL(url);
    const domain = u.hostname.replace(/^www\./, '');

    // Must be http/https
    if (!['http:', 'https:'].includes(u.protocol)) return false;

    // Blocklist check
    for (const blocked of RELAY_BLOCKLIST) {
      if (domain.endsWith(blocked) || domain === blocked) return false;
    }

    // No auth tokens in URL
    if (u.search.includes('token=') || u.search.includes('api_key=') || u.search.includes('access_token=')) return false;

    // Classify and block adult/gambling categories
    const category = classifyDomain(domain);
    if (['adult', 'gambling'].includes(category)) return false;

    return true;
  } catch {
    return false;
  }
}

function logRelayRequest(relayId: string | null, url: string, status: string): void {
  try {
    const urlHash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
    stmtLogRelayRequest.run({ ts: Date.now(), relay_id: relayId, url_hash: urlHash, status });
  } catch (err) {
    console.error('[relay] Failed to log relay request:', err);
  }
}

// ─── Daily limit tracking ─────────────────────────────────────────────────────

function checkAndIncrementDailyLimit(relayId: string, limit = 500): boolean {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const entry = dailyRelayCount.get(relayId);

  if (!entry || entry.date !== today) {
    dailyRelayCount.set(relayId, { date: today, count: 1 });
    return true;
  }

  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// ─── Credit award ─────────────────────────────────────────────────────────────

function creditRelay(relayId: string): void {
  try {
    stmtCreditRelay.run({ relay_id: relayId, now: Date.now() });
    console.log(`[relay] Credited relay_id=${relayId}`);
  } catch (err) {
    console.error('[relay] Failed to credit relay_id:', relayId, err);
  }
}

// ─── Relay selection ──────────────────────────────────────────────────────────

function getAvailableRelay(excludeIp?: string): RelayClient | null {
  const clients = Array.from(relayPool.values()).filter(c => {
    // Must be connected (ws open)
    if (c.ws.readyState !== WebSocket.OPEN) return false;
    // Skip deprioritized clients
    if (c.deprioritized) return false;
    // Minimum 10 minutes connected before earning
    const connectedMs = Date.now() - c.connectedAt;
    if (connectedMs < 2 * 60 * 1000) return false;
    // Self-relay detection
    if (excludeIp && c.ip === excludeIp) return false;
    return true;
  });

  if (clients.length === 0) {
    // Try deprioritized clients as last resort (no credits awarded)
    const fallback = Array.from(relayPool.values()).filter(c =>
      c.ws.readyState === WebSocket.OPEN && (!excludeIp || c.ip !== excludeIp)
    );
    if (fallback.length === 0) return null;
    return fallback[Math.floor(Math.random() * fallback.length)];
  }

  return clients[Math.floor(Math.random() * clients.length)];
}

// ─── Core relay fetch ─────────────────────────────────────────────────────────

export async function relayFetch(url: string, requesterIp?: string): Promise<string | null> {
  if (!isSafeForRelay(url)) {
    requestsBlocked++;
    console.log(`[relay] URL blocked by safety filter: ${url}`);
    logRelayRequest(null, url, 'blocked');
    return null;
  }

  const client = getAvailableRelay(requesterIp);
  if (!client) {
    console.log(`[relay] No available relay clients for: ${url}`);
    return null;
  }

  // Check daily limit
  if (!checkAndIncrementDailyLimit(client.relayId)) {
    console.log(`[relay] Daily limit reached for relay_id=${client.relayId}`);
    return null;
  }

  const requestId = crypto.randomUUID();
  const connectedLongEnough = (Date.now() - client.connectedAt) >= 2 * 60 * 1000;

  return new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => {
      client.ws.off('message', handler);
      client.errorStreak++;
      if (client.errorStreak >= 3) {
        client.deprioritized = true;
        console.log(`[relay] Deprioritized relay_id=${client.relayId} after 3 errors`);
      }
      console.log(`[relay] Timeout for requestId=${requestId}`);
      resolve(null);
    }, 45000); // 45s — Windows relay has WebSocket round-trip overhead

    client.ws.send(JSON.stringify({ type: 'fetch', requestId, url, userAgent: getRelayUA() }));

    const handler = (msg: Buffer | string) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'result' && data.requestId === requestId) {
          clearTimeout(timeout);
          client.ws.off('message', handler);

          if (!data.html || data.status === 0) {
            client.errorStreak++;
            if (client.errorStreak >= 3) {
              client.deprioritized = true;
              console.log(`[relay] Deprioritized relay_id=${client.relayId} after 3 errors`);
            }
            logRelayRequest(client.relayId, url, 'failed');
            resolve(null);
            return;
          }

          // Reset error streak on success
          client.errorStreak = 0;
          client.relayCount++;

          // Check if relay returned a CAPTCHA page — if so, treat as failure
          // so the scraper can fall through to VPS tiers where CapSolver can solve it
          const captchaType = detectCaptchaType(data.html as string);
          if (captchaType) {
            console.log(`[relay] CAPTCHA page detected (${captchaType}) from relay for ${url} — falling through to VPS`);
            logRelayRequest(client.relayId, url, `captcha:${captchaType}`);
            resolve(null);
            return;
          }

          // Only award credits if connected long enough and not self-relaying
          const isSelfRelay = requesterIp && client.ip === requesterIp;
          if (connectedLongEnough && !isSelfRelay && !client.deprioritized) {
            creditRelay(client.relayId);
          }

          logRelayRequest(client.relayId, url, 'success');
          resolve(data.html as string);
        }
      } catch (e) {
        // ignore parse errors
      }
    };

    client.ws.on('message', handler);
  });
}

// ─── WebSocket server setup ────────────────────────────────────────────────────

export function attachRelayWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade for /relay-ws path
  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (request.url !== '/relay-ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Extract client IP
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';

    let relayId: string | null = null;

    console.log(`[relay] New WebSocket connection from ${ip}`);

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('message', (msg: Buffer | string) => {
      try {
        const data = JSON.parse(msg.toString());

        if (data.type === 'register') {
          relayId = data.relayId as string;
          if (!relayId || typeof relayId !== 'string') {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid relayId' }));
            return;
          }

          // Validate relayId exists in DB — or auto-register trusted internal Windows relay workers
          const existing = stmtGetStatus.get({ relay_id: relayId }) as any;
          if (!existing) {
            if (relayId.startsWith('relay_la_windows_primary')) {
              // Auto-register internal Windows relay workers (relay_la_windows_primary_0 .. _N)
              try {
                stmtCreateRelay.run({ relay_id: relayId, email: 'internal@anybrowse.dev', now: Date.now() });
                console.log(`[relay] Auto-registered internal worker: ${relayId}`);
              } catch (err) {
                // Race condition: already exists — that's fine
              }
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Unknown relayId. Register at anybrowse.dev/relay' }));
              return;
            }
          }

          // Remove any previous connection for this relayId
          const prev = relayPool.get(relayId);
          if (prev && prev.ws !== ws) {
            prev.ws.close(1000, 'Replaced by new connection');
          }

          const client: RelayClient = {
            ws,
            relayId,
            connectedAt: Date.now(),
            relayCount: 0,
            errorStreak: 0,
            ip,
            deprioritized: false,
          };

          relayPool.set(relayId, client);
          stmtUpdateLastSeen.run({ relay_id: relayId, now: Date.now() });

          ws.send(JSON.stringify({ type: 'registered', ok: true, relayId }));
          console.log(`[relay] Registered relay_id=${relayId} from ${ip}. Pool size: ${relayPool.size}`);
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      if (relayId && relayPool.get(relayId)?.ws === ws) {
        relayPool.delete(relayId);
        console.log(`[relay] Disconnected relay_id=${relayId}. Pool size: ${relayPool.size}`);
      }
    });

    ws.on('error', (err: Error) => {
      console.error(`[relay] WebSocket error for relay_id=${relayId}:`, err.message);
    });
  });

  console.log('[relay] WebSocket relay server attached at /relay-ws');
}

// ─── HTTP route handlers ───────────────────────────────────────────────────────

export function registerRelayRoutes(app: any): void {
  // POST /relay/register — create a new relay account
  app.post('/relay/register', async (req: any, reply: any) => {
    const body = req.body as any;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : null;

    if (!email || !email.includes('@')) {
      return reply.status(400).send({ error: 'Valid email required' });
    }

    const relayId = 'relay_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();

    try {
      stmtCreateRelay.run({ relay_id: relayId, email, now });
      console.log(`[relay] Registered new relay account: ${relayId} for ${email}`);
      return reply.send({ relayId, email, message: 'Save your relay ID — you will need it to connect the extension.' });
    } catch (err) {
      console.error('[relay] Registration error:', err);
      return reply.status(500).send({ error: 'Registration failed' });
    }
  });

  // GET /relay/status?relayId=xxx — check relay account status
  app.get('/relay/status', async (req: any, reply: any) => {
    const relayId = (req.query as any)?.relayId as string;
    if (!relayId) return reply.status(400).send({ error: 'relayId required' });

    const row = stmtGetStatus.get({ relay_id: relayId }) as any;
    if (!row) return reply.status(404).send({ error: 'Unknown relay ID' });

    const connected = relayPool.has(relayId) && relayPool.get(relayId)!.ws.readyState === WebSocket.OPEN;
    const sessionRelays = relayPool.get(relayId)?.relayCount ?? 0;

    return reply.send({
      relayId: row.relay_id,
      relays: row.total_relays,
      credits: row.credits_earned,
      sessionRelays,
      connected,
      lastSeen: row.last_seen,
      active: row.active === 1,
    });
  });

  // GET /relay/leaderboard — top 10 anonymous contributors
  app.get('/relay/leaderboard', async (_req: any, reply: any) => {
    const rows = stmtLeaderboard.all() as any[];
    const leaderboard = rows.map((row, i) => ({
      rank: i + 1,
      relayId: row.relay_id.slice(0, 12) + '...',  // anonymize
      totalRelays: row.total_relays,
      creditsEarned: row.credits_earned,
    }));

    return reply.send({
      leaderboard,
      poolSize: relayPool.size,
      activeConnections: Array.from(relayPool.values()).filter(c => c.ws.readyState === WebSocket.OPEN).length,
    });
  });

  // GET /relay/pool — internal pool status (admin)
  app.get('/relay/pool', async (_req: any, reply: any) => {
    const pool = Array.from(relayPool.entries()).map(([id, c]) => ({
      relayId: id,
      connectedAt: c.connectedAt,
      connectedMs: Date.now() - c.connectedAt,
      relayCount: c.relayCount,
      errorStreak: c.errorStreak,
      deprioritized: c.deprioritized,
      ip: c.ip.slice(0, -3) + '***',  // partial IP
      readyState: c.ws.readyState,
    }));
    return reply.send({ pool, size: pool.length });
  });

  // GET /relay/stats — health/stats endpoint
  app.get('/relay/stats', async (_req: any, reply: any) => {
    const activeClients = Array.from(relayPool.values()).filter(
      c => c.ws.readyState === WebSocket.OPEN
    );
    const connected = activeClients.length;

    // Build workers map
    const workers: Record<string, { connected: boolean; relayCount: number }> = {};
    for (const [id, c] of relayPool.entries()) {
      workers[id] = {
        connected: c.ws.readyState === WebSocket.OPEN,
        relayCount: c.relayCount,
      };
    }

    // Estimate "workers" as connected clients (each extension = 1 worker in this model)
    const workerCount = connected;
    const message = `${connected} relay browser${connected !== 1 ? 's' : ''} connected (${workerCount} worker${workerCount !== 1 ? 's' : ''})`;

    return reply.send({
      connected,
      workers,
      requestsBlocked,
      message,
    });
  });

  // GET /relay — onboarding page
  app.get('/relay', async (_req: any, reply: any) => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const { fileURLToPath } = await import('url');
    const { dirname } = await import('path');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    try {
      const html = readFileSync(join(__dirname, 'static', 'relay.html'), 'utf-8');
      return reply.type('text/html').send(html);
    } catch {
      return reply.status(404).send({ error: 'relay page not found' });
    }
  });
}
