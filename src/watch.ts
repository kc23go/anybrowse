/**
 * watch.ts — Change monitoring endpoints
 *
 * POST /watch     - register a URL to watch
 * GET  /watches   - list active watches for this IP
 * DELETE /watch/:id - deactivate a watch
 * GET  /watch/:id/history - last 10 changes for a watch
 *
 * Background poller: every 5 minutes, check due watches.
 * On change: POST to webhook_url with content_changed event.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Browser } from 'playwright-core';
import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { db } from './db.js';
import { acquireSession, releaseSession } from './pool.js';
import { scrapeUrlWithFallback } from './scraper.js';
import { isOwnerKey } from './payment-gate.js';
import { checkSubscription } from './stripe-subscriptions.js';

// Free tier: max 3 watches; Pro: max 50; Owner: unlimited
const FREE_WATCH_LIMIT = 3;
const PRO_WATCH_LIMIT = 50;

// Prepared statements
const insertWatch = db.prepare(`
  INSERT INTO watches (id, url, webhook_url, interval_minutes, ip_hash, created_at, active)
  VALUES (@id, @url, @webhook_url, @interval_minutes, @ip_hash, @created_at, 1)
`);

const getActiveWatches = db.prepare(`
  SELECT id, url, webhook_url, interval_minutes, created_at, last_checked, last_changed, check_count, change_count
  FROM watches WHERE ip_hash = ? AND active = 1
`);

const getWatchById = db.prepare(`
  SELECT * FROM watches WHERE id = ?
`);

const deactivateWatch = db.prepare(`
  UPDATE watches SET active = 0 WHERE id = ? AND ip_hash = ?
`);

const deactivateWatchOwner = db.prepare(`
  UPDATE watches SET active = 0 WHERE id = ?
`);

const getWatchHistory = db.prepare(`
  SELECT id, watch_id, detected_at, previous_hash, current_hash
  FROM watch_history WHERE watch_id = ? ORDER BY detected_at DESC LIMIT 10
`);

const countWatchesByIp = db.prepare(`
  SELECT COUNT(*) as cnt FROM watches WHERE ip_hash = ? AND active = 1
`);

const updateWatchCheck = db.prepare(`
  UPDATE watches SET
    last_checked = @now,
    last_hash = @hash,
    check_count = check_count + 1
  WHERE id = @id
`);

const updateWatchChange = db.prepare(`
  UPDATE watches SET
    last_checked = @now,
    last_hash = @hash,
    last_changed = @now,
    check_count = check_count + 1,
    change_count = change_count + 1
  WHERE id = @id
`);

const insertWatchHistory = db.prepare(`
  INSERT INTO watch_history (watch_id, detected_at, previous_hash, current_hash, markdown)
  VALUES (@watch_id, @detected_at, @previous_hash, @current_hash, @markdown)
`);

const getDueWatches = db.prepare(`
  SELECT * FROM watches WHERE active = 1 AND (
    last_checked IS NULL OR last_checked < ?
  )
`);

function hashContent(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

function getOwnerKeyFromReq(req: FastifyRequest): string | undefined {
  const authHeader = req.headers['authorization'] as string | undefined;
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  return bearer || apiKeyHeader;
}

function isProUser(req: FastifyRequest): boolean {
  const authHeader = req.headers['authorization'] as string | undefined;
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
  let apiKey: string | undefined;
  if (authHeader?.startsWith('Bearer ab_')) {
    apiKey = authHeader.slice(7).trim();
  } else if (apiKeyHeader?.startsWith('ab_')) {
    apiKey = apiKeyHeader.trim();
  }
  if (!apiKey) return false;
  const check = checkSubscription(apiKey);
  return check.valid;
}

/**
 * Send a webhook notification to the given URL
 */
async function sendWebhook(webhookUrl: string, payload: object): Promise<void> {
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'anybrowse-watch/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`[watch] Webhook returned ${resp.status} for ${webhookUrl}`);
    }
  } catch (err: any) {
    console.error(`[watch] Webhook delivery failed to ${webhookUrl}:`, err.message);
  }
}

/**
 * Run the poller: check all due watches, scrape, compare, fire webhooks on change.
 */
async function runWatchPoller(): Promise<void> {
  const now = Date.now();

  // Find watches due for a check: last_checked < now - interval_minutes * 60000
  // We query all active watches and filter in JS because interval_minutes varies per watch
  const allActive = db.prepare(`SELECT * FROM watches WHERE active = 1`).all() as any[];
  const due = allActive.filter((w) => {
    if (!w.last_checked) return true; // never checked
    const intervalMs = (w.interval_minutes || 60) * 60 * 1000;
    return (now - w.last_checked) >= intervalMs;
  });

  if (due.length === 0) return;

  console.log(`[watch] Poller tick: ${due.length} watch(es) due`);

  let session: Awaited<ReturnType<typeof acquireSession>> | null = null;
  let hadError = false;

  try {
    session = await acquireSession();
    const browser = session.browser as Browser;

    for (const watch of due) {
      try {
        const result = await scrapeUrlWithFallback(browser, watch.url, true);
        if (result.status !== 'success') {
          // Still update last_checked even on failure
          updateWatchCheck.run({ now, hash: watch.last_hash, id: watch.id });
          continue;
        }

        const currentHash = hashContent(result.markdown);
        const previousHash = watch.last_hash;

        if (previousHash && currentHash !== previousHash) {
          // Content changed!
          console.log(`[watch] Change detected for ${watch.url} (watch ${watch.id})`);
          updateWatchChange.run({ now, hash: currentHash, id: watch.id });
          insertWatchHistory.run({
            watch_id: watch.id,
            detected_at: now,
            previous_hash: previousHash,
            current_hash: currentHash,
            markdown: result.markdown,
          });

          // Fire webhook (async, don't await blocking)
          const payload = {
            event: 'content_changed',
            watch_id: watch.id,
            url: watch.url,
            changed_at: new Date(now).toISOString(),
            previous_hash: previousHash,
            current_hash: currentHash,
            markdown: result.markdown,
          };
          sendWebhook(watch.webhook_url, payload).catch(() => {});
        } else {
          // No change, just update check time and hash (stores hash on first check)
          updateWatchCheck.run({ now, hash: currentHash, id: watch.id });
        }
      } catch (err: any) {
        hadError = true;
        console.error(`[watch] Error checking watch ${watch.id} (${watch.url}):`, err.message);
        // Still update last_checked to avoid hammering failing URLs
        try { updateWatchCheck.run({ now, hash: watch.last_hash, id: watch.id }); } catch { /* ignore */ }
      }
    }
  } catch (err: any) {
    hadError = true;
    console.error('[watch] Poller failed to acquire browser session:', err.message);
  } finally {
    if (session) releaseSession(session, hadError);
  }
}

/**
 * Start the background poller (5-minute interval)
 */
export function startWatchPoller(): void {
  setInterval(async () => {
    try {
      await runWatchPoller();
    } catch (err: any) {
      console.error('[watch] Poller uncaught error:', err.message);
    }
  }, 5 * 60 * 1000);
  console.log('[watch] Background poller started (5-min interval)');
}

export async function registerWatchRoutes(app: FastifyInstance): Promise<void> {
  // POST /watch — register a new watch
  app.post('/watch', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const url = body?.url;
    const webhookUrl = body?.webhook_url;
    let intervalMinutes = Number(body?.interval_minutes ?? 60);

    if (!url || typeof url !== 'string') {
      return reply.status(400).send({ error: 'url is required' });
    }
    if (!webhookUrl || typeof webhookUrl !== 'string') {
      return reply.status(400).send({ error: 'webhook_url is required' });
    }

    // Validate URL
    try { new URL(url as string); } catch {
      return reply.status(400).send({ error: 'invalid url' });
    }
    try { new URL(webhookUrl as string); } catch {
      return reply.status(400).send({ error: 'invalid webhook_url' });
    }

    // Clamp interval
    intervalMinutes = Math.max(15, Math.min(1440, isNaN(intervalMinutes) ? 60 : intervalMinutes));

    const clientIp = req.ip || 'unknown';
    const ipHash = hashIp(clientIp);
    const ownerKey = getOwnerKeyFromReq(req);
    const isOwner = isOwnerKey(ownerKey);
    const isPro = !isOwner && isProUser(req);
    const isFree = !isOwner && !isPro;

    // Enforce watch limits
    if (isFree || isPro) {
      const row = countWatchesByIp.get(ipHash) as { cnt: number } | undefined;
      const current = row?.cnt || 0;
      const limit = isPro ? PRO_WATCH_LIMIT : FREE_WATCH_LIMIT;
      if (current >= limit) {
        return reply.status(429).send({
          error: `Watch limit reached (${limit} active watches for ${isPro ? 'Pro' : 'free'} tier).`,
          current,
          limit,
          upgrade: isPro ? undefined : 'https://anybrowse.dev/checkout',
        });
      }
    }

    const id = randomUUID();
    const createdAt = Date.now();

    insertWatch.run({ id, url, webhook_url: webhookUrl, interval_minutes: intervalMinutes, ip_hash: ipHash, created_at: createdAt });

    return reply.status(201).send({
      id,
      url,
      webhook_url: webhookUrl,
      interval_minutes: intervalMinutes,
      created_at: createdAt,
    });
  });

  // GET /watches — list active watches for this IP
  app.get('/watches', async (req: FastifyRequest, reply: FastifyReply) => {
    const clientIp = req.ip || 'unknown';
    const ipHash = hashIp(clientIp);
    const ownerKey = getOwnerKeyFromReq(req);
    const isOwner = isOwnerKey(ownerKey);

    let watches: unknown[];
    if (isOwner) {
      watches = db.prepare(`SELECT id, url, webhook_url, interval_minutes, created_at, last_checked, last_changed, check_count, change_count FROM watches WHERE active = 1 ORDER BY created_at DESC`).all();
    } else {
      watches = getActiveWatches.all(ipHash);
    }

    return reply.send({ watches });
  });

  // DELETE /watch/:id — deactivate a watch
  app.delete('/watch/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const clientIp = req.ip || 'unknown';
    const ipHash = hashIp(clientIp);
    const ownerKey = getOwnerKeyFromReq(req);
    const isOwner = isOwnerKey(ownerKey);

    const watch = getWatchById.get(id) as any;
    if (!watch || !watch.active) {
      return reply.status(404).send({ error: 'Watch not found or already inactive' });
    }

    if (isOwner) {
      deactivateWatchOwner.run(id);
    } else {
      if (watch.ip_hash !== ipHash) {
        return reply.status(403).send({ error: 'Not authorized to delete this watch' });
      }
      deactivateWatch.run(id, ipHash);
    }

    return reply.send({ ok: true, id });
  });

  // GET /watch/:id/history — last 10 changes
  app.get('/watch/:id/history', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const clientIp = req.ip || 'unknown';
    const ipHash = hashIp(clientIp);
    const ownerKey = getOwnerKeyFromReq(req);
    const isOwner = isOwnerKey(ownerKey);

    const watch = getWatchById.get(id) as any;
    if (!watch) {
      return reply.status(404).send({ error: 'Watch not found' });
    }
    if (!isOwner && watch.ip_hash !== ipHash) {
      return reply.status(403).send({ error: 'Not authorized to view this watch' });
    }

    const history = getWatchHistory.all(id);
    return reply.send({ watch_id: id, url: watch.url, history });
  });

  console.log('[watch] Routes registered: POST /watch, GET /watches, DELETE /watch/:id, GET /watch/:id/history');
}
