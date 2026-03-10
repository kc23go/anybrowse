/**
 * batch.ts — POST /batch endpoint
 *
 * Accepts up to 10 URLs, scrapes them in parallel, returns all results.
 * Free tier: up to 10 URLs per batch, max 5 batches/day.
 * Pro/Owner: unlimited batches.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Browser } from 'playwright-core';
import { acquireSession, releaseSession } from './pool.js';
import { scrapeUrlWithFallback, scrapeUrlTier0 } from './scraper.js';
import { isOwnerKey } from './payment-gate.js';
import { checkSubscription } from './stripe-subscriptions.js';

// Free tier: max 5 batches/day per IP
const BATCH_FREE_TIER_DAILY = 5;
const batchFreeMap = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of batchFreeMap) {
    if (now >= entry.resetAt) batchFreeMap.delete(ip);
  }
}, 60_000);

function nextMidnightUtc(): number {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return midnight.getTime();
}

function checkBatchFreeTier(ip: string): { allowed: boolean } {
  const now = Date.now();
  let entry = batchFreeMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: nextMidnightUtc() };
    batchFreeMap.set(ip, entry);
  }
  if (entry.count >= BATCH_FREE_TIER_DAILY) {
    return { allowed: false };
  }
  entry.count++;
  return { allowed: true };
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

function getOwnerKey(req: FastifyRequest): string | undefined {
  const authHeader = req.headers['authorization'] as string | undefined;
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  return bearer || apiKeyHeader;
}

interface BatchRequestBody {
  urls?: unknown;
  context?: string;
}

export async function registerBatchRoutes(app: FastifyInstance): Promise<void> {
  app.post('/batch', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as BatchRequestBody;
    const urls = body?.urls;
    const context = body?.context;

    if (!Array.isArray(urls) || urls.length === 0) {
      return reply.status(400).send({ error: 'urls array required' });
    }
    if (urls.length > 10) {
      return reply.status(400).send({ error: 'max 10 URLs per batch' });
    }

    // Validate all are strings
    const urlStrings: string[] = [];
    for (const u of urls) {
      if (typeof u !== 'string') {
        return reply.status(400).send({ error: 'all urls must be strings' });
      }
      urlStrings.push(u);
    }

    // Auth check — owner has no limits
    const ownerKey = getOwnerKey(req);
    const isOwner = isOwnerKey(ownerKey);
    const isPro = !isOwner && isProUser(req);
    const isFree = !isOwner && !isPro;

    const clientIp = req.ip || 'unknown';

    // Internal token bypass (from MCP)
    const internalToken = req.headers['x-internal-token'] as string | undefined;
    // (payment gate already validated internal tokens before this handler runs,
    //  but /batch is not in DEFAULT_PRICES so we check here)

    if (isFree) {
      const ok = checkBatchFreeTier(clientIp);
      if (!ok.allowed) {
        return reply.status(429).send({
          error: 'Free tier batch limit reached (5 batches/day). Upgrade to Pro for unlimited batches.',
          upgrade: 'https://anybrowse.dev/checkout',
          reset: 'Resets at midnight UTC',
        });
      }
    }

    // ── Tier 0: try plain HTTP fetch for each URL (no browser pool needed) ──
    type BatchResult = { url: string; success: boolean; markdown: string | null; title: string | null; error?: string };
    const tier0Results = await Promise.allSettled(
      urlStrings.map(async (url): Promise<BatchResult> => {
        try {
          const r = await scrapeUrlTier0(url);
          if (r && r.status === 'success' && r.markdown) {
            return { url, success: true, markdown: r.markdown, title: r.title ?? null };
          }
        } catch { /* fall through */ }
        return { url, success: false, markdown: null, title: null, error: 'tier0_miss' };
      })
    );

    // Separate tier0 hits from misses
    const results: BatchResult[] = new Array(urlStrings.length);
    const browserQueue: Array<{ idx: number; url: string }> = [];

    tier0Results.forEach((r, i) => {
      const val = r.status === 'fulfilled' ? r.value : { url: urlStrings[i], success: false, markdown: null, title: null, error: 'tier0_error' };
      if (val.success) {
        results[i] = val;
      } else {
        browserQueue.push({ idx: i, url: urlStrings[i] });
      }
    });

    // ── Browser pool: handle URLs that tier0 couldn't serve ──────────────
    let session: Awaited<ReturnType<typeof acquireSession>> | null = null;
    let hadError = false;

    if (browserQueue.length > 0) {
      try {
        session = await acquireSession();
        const browser = session.browser as Browser;

        const PER_URL_TIMEOUT_MS = 15_000; // hard cap — tier0 already failed for these URLs
        const settled = await Promise.allSettled(
          browserQueue.map(({ url }) =>
            Promise.race([
              scrapeUrlWithFallback(browser, url, true, { skipTier0: true }),
              new Promise<never>((_, rej) =>
                setTimeout(() => rej(new Error('per-url browser timeout')), PER_URL_TIMEOUT_MS)
              ),
            ])
          )
        );

        settled.forEach((r, qi) => {
          const { idx, url } = browserQueue[qi];
          if (r.status === 'fulfilled') {
            const val = r.value;
            if (val.status === 'success') {
              results[idx] = { url, success: true, markdown: val.markdown, title: val.title ?? null };
            } else {
              hadError = true;
              results[idx] = { url, success: false, markdown: null, title: null, error: val.error || val.status };
            }
          } else {
            hadError = true;
            results[idx] = { url, success: false, markdown: null, title: null, error: r.reason?.message || String(r.reason) };
          }
        });
      } catch (err: any) {
        hadError = true;
        // Fill remaining slots with error
        browserQueue.forEach(({ idx, url }) => {
          if (!results[idx]) {
            results[idx] = { url, success: false, markdown: null, title: null, error: err.message || 'Browser scrape failed' };
          }
        });
      } finally {
        if (session) releaseSession(session, hadError);
      }
    }

    const successCount = results.filter((r) => r?.success).length;
    return reply.send({
      results,
      summary: { total: results.length, success: successCount, failed: results.length - successCount },
    });
  });

  console.log('[batch] POST /batch registered (max 10 URLs, free: 5/day, pro: unlimited)');
}
