/**
 * warmer.ts — Browser pre-warming service
 *
 * Maintains a pool of browser contexts that casually browse real sites
 * so they accumulate cookies, history, and trust signals before being
 * handed to hard-scrape targets (Amazon, etc.).
 *
 * Architecture:
 *   - One shared Playwright Browser (same launch args as pool.ts)
 *   - WARM_POOL_SIZE independent BrowserContexts (isolated cookies/storage)
 *   - Each context has one Page that loops through WARM_SITES with human-like behavior
 *   - warmthScore 0–10: increases with pages visited and cookie count
 *   - getWarmSession() returns the highest-score ready session (score ≥ WARM_MIN_SCORE)
 *   - Sessions are retired after SESSION_MAX_AGE_MS and replaced with fresh ones
 *
 * This module is safe to disable: if WARM_POOL_SIZE=0 or the browser fails
 * to launch, all functions degrade gracefully without affecting the main pool.
 */

import { chromium as chromiumBase } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { randomUUID } from 'crypto';

// Stealth is idempotent — playwright-extra deduplicates plugin registration
(chromiumBase as any).use(StealthPlugin());
const chromium = chromiumBase as any;

// ── Config ────────────────────────────────────────────────────────────────────

const WARM_POOL_SIZE    = parseInt(process.env.WARM_POOL_SIZE   ?? '3');
const WARM_MIN_SCORE    = parseInt(process.env.WARM_MIN_SCORE   ?? '3');
const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;  // 4 hours
const BROWSE_INTERVAL_MS = 3 * 60 * 1000;        // browse new site every 3 min
const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;

// DE ISP proxies — same pool used by pool.ts
const WARM_PROXIES = [
  'http://14a3696c76e38:a7b82257a0@95.134.166.82:12323',
  'http://14a3696c76e38:a7b82257a0@95.134.166.221:12323',
  'http://14a3696c76e38:a7b82257a0@95.134.166.36:12323',
  'http://14a3696c76e38:a7b82257a0@95.134.166.225:12323',
  'http://14a3696c76e38:a7b82257a0@95.134.167.6:12323',
];

const WARM_SITES = [
  'https://www.google.com',
  'https://www.reddit.com',
  'https://news.ycombinator.com',
  'https://www.nytimes.com',
  'https://www.bbc.com/news',
  'https://www.amazon.com',
  'https://www.youtube.com',
  'https://www.weather.com',
  'https://www.cnn.com',
  'https://www.espn.com',
  'https://www.wikipedia.org',
  'https://www.instagram.com',
];

const BROWSER_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--flag-switches-begin',
  '--disable-site-isolation-trials',
  '--flag-switches-end',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-extensions',
  '--disable-background-networking',
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WarmSession {
  id: string;
  context: BrowserContext;
  page: Page;
  warmthScore: number;      // 0–10
  pagesVisited: number;
  createdAt: number;
  lastUsedAt: number;       // timestamp when last given to a real scrape
  lastBrowsedAt: number;    // timestamp of last warm browse
  inUse: boolean;           // true while given to a real scrape
  proxy?: string;           // which proxy server this session uses
}

// ── Module state ──────────────────────────────────────────────────────────────

let warmerStarted   = false;
let warmerStopped   = false;
let sharedBrowser: Browser | null = null;
const sessions     = new Map<string, WarmSession>();
const siteUseCount = new Map<string, number>(); // concurrent per-site limit

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickProxy(slot: number): string {
  return WARM_PROXIES[slot % WARM_PROXIES.length];
}

/**
 * Pick a warm site, respecting the rule: ≤2 sessions on the same site at once.
 */
function pickWarmSite(): string {
  const available = WARM_SITES.filter(s => (siteUseCount.get(s) ?? 0) < 2);
  const pool = available.length > 0 ? available : WARM_SITES;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Simulate human reading behavior on a page:
 *   - random scroll depth (30–80% of page height)
 *   - pause 2–8 seconds
 *   - occasionally scroll back up slightly
 */
async function simulateHumanBehavior(page: Page): Promise<void> {
  try {
    const scrollDepthPct = randomInt(30, 80) / 100;
    await page.evaluate((depthPct) => {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      if (maxScroll > 0) {
        window.scrollTo({ top: Math.floor(maxScroll * depthPct), behavior: 'smooth' });
      }
    }, scrollDepthPct);

    await sleep(randomInt(2_000, 8_000));

    // Occasionally scroll back a bit
    if (Math.random() < 0.4) {
      await page.evaluate(() => {
        window.scrollBy({ top: -200 - Math.floor(Math.random() * 300), behavior: 'smooth' });
      });
      await sleep(randomInt(500, 1_500));
    }
  } catch { /* page may have navigated away — ignore */ }
}

/**
 * Compute warmth score from session state.
 * Score 0–10:
 *   - +1 per 2 pages visited (max +5)
 *   - +1 per 5 minutes of session age (max +3)
 *   - +1 if has cookies (approximated by pagesVisited >= 1)
 *   - +1 if has visited Amazon (tracked via pagesVisited and lastBrowsedAt)
 */
function computeWarmthScore(session: WarmSession): number {
  const pageScore  = Math.min(5, Math.floor(session.pagesVisited / 2));
  const ageScore   = Math.min(3, Math.floor((Date.now() - session.createdAt) / (5 * 60 * 1000)));
  const baseScore  = session.pagesVisited >= 1 ? 1 : 0;
  return Math.min(10, pageScore + ageScore + baseScore);
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

async function createSession(slot: number): Promise<WarmSession | null> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) return null;
  try {
    const proxy = pickProxy(slot);
    const context = await sharedBrowser.newContext({
      proxy: { server: proxy },
      viewport: { width: 1280 + randomInt(0, 400), height: 720 + randomInt(0, 280) },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const page = await context.newPage();

    const session: WarmSession = {
      id: randomUUID(),
      context,
      page,
      warmthScore: 0,
      pagesVisited: 0,
      createdAt: Date.now(),
      lastUsedAt: 0,
      lastBrowsedAt: 0,
      inUse: false,
      proxy,
    };

    sessions.set(session.id, session);
    console.log(`[warmer] Session ${session.id.slice(0, 8)} created (slot ${slot})`);
    return session;
  } catch (err: any) {
    console.error(`[warmer] Failed to create session for slot ${slot}: ${err.message}`);
    return null;
  }
}

async function retireSession(session: WarmSession): Promise<void> {
  sessions.delete(session.id);
  try {
    await session.page.close().catch(() => {});
    await session.context.close().catch(() => {});
  } catch { /* ignore close errors */ }
  console.log(`[warmer] Session ${session.id.slice(0, 8)} retired (age=${Math.round((Date.now() - session.createdAt) / 60_000)}m, pages=${session.pagesVisited})`);
}

// ── Warm browse loop ──────────────────────────────────────────────────────────

async function warmLoop(session: WarmSession, slot: number): Promise<void> {
  // Initial conditioning — visit 3–5 sites over first 2 minutes
  const initialVisits = randomInt(3, 5);
  for (let i = 0; i < initialVisits && !warmerStopped; i++) {
    if (session.inUse) break;
    await visitWarmSite(session);
    if (i < initialVisits - 1) await sleep(randomInt(15_000, 30_000));
  }

  // Steady-state loop — one site every BROWSE_INTERVAL_MS
  while (!warmerStopped) {
    const ageMs = Date.now() - session.createdAt;

    // Retire and replace after SESSION_MAX_AGE_MS
    if (ageMs >= SESSION_MAX_AGE_MS) {
      await retireSession(session);
      // Spin up a replacement
      if (!warmerStopped) {
        const replacement = await createSession(slot);
        if (replacement) warmLoop(replacement, slot).catch(() => {});
      }
      return;
    }

    // Wait for next browse cycle (skip if in use)
    await sleep(BROWSE_INTERVAL_MS);

    if (warmerStopped) break;
    if (!session.inUse) {
      await visitWarmSite(session);
    }
  }
}

async function visitWarmSite(session: WarmSession): Promise<void> {
  const site = pickWarmSite();

  // Track concurrent usage per site
  siteUseCount.set(site, (siteUseCount.get(site) ?? 0) + 1);

  try {
    await session.page.goto(site, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });

    await simulateHumanBehavior(session.page);

    session.pagesVisited++;
    session.lastBrowsedAt = Date.now();
    session.warmthScore = computeWarmthScore(session);
  } catch { /* navigation errors are expected — site may block or redirect */ }
  finally {
    siteUseCount.set(site, Math.max(0, (siteUseCount.get(site) ?? 1) - 1));
  }
}

// ── Browser lifecycle ─────────────────────────────────────────────────────────

async function launchBrowser(): Promise<Browser | null> {
  try {
    const browser = await Promise.race([
      chromium.launch({
        headless: true,
        proxy: { server: WARM_PROXIES[0] }, // default proxy; overridden per-context
        args: BROWSER_LAUNCH_ARGS,
      }) as Promise<Browser>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('warmer browser launch timeout')), BROWSER_LAUNCH_TIMEOUT_MS)
      ),
    ]);
    console.log('[warmer] Shared browser launched');
    return browser;
  } catch (err: any) {
    console.error(`[warmer] Browser launch failed: ${err.message}`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the background warming service.
 * No-op if WARM_POOL_SIZE is 0 or already started.
 */
export function startWarmer(): void {
  if (WARM_POOL_SIZE === 0) {
    console.log('[warmer] Disabled (WARM_POOL_SIZE=0)');
    return;
  }
  if (warmerStarted) return;
  warmerStarted = true;
  warmerStopped = false;

  // Launch async — does not block server startup
  (async () => {
    try {
      sharedBrowser = await launchBrowser();
      if (!sharedBrowser) {
        console.error('[warmer] Could not launch browser — warmer disabled');
        return;
      }

      // Wire up browser disconnect handler
      sharedBrowser.on('disconnected', () => {
        if (!warmerStopped) {
          console.warn('[warmer] Browser disconnected — clearing sessions');
          sessions.clear();
          sharedBrowser = null;
          // Attempt re-launch after 30s
          setTimeout(async () => {
            if (!warmerStopped) {
              sharedBrowser = await launchBrowser();
              if (sharedBrowser) {
                for (let i = 0; i < WARM_POOL_SIZE; i++) {
                  const s = await createSession(i);
                  if (s) warmLoop(s, i).catch(() => {});
                }
              }
            }
          }, 30_000);
        }
      });

      // Spin up all warm session slots
      for (let i = 0; i < WARM_POOL_SIZE; i++) {
        const session = await createSession(i);
        if (session) {
          warmLoop(session, i).catch((err) => {
            console.error(`[warmer] warmLoop slot ${i} crashed: ${err?.message}`);
          });
          // Stagger startup to avoid all sessions hitting the same sites
          if (i < WARM_POOL_SIZE - 1) await sleep(randomInt(5_000, 15_000));
        }
      }

      console.log(`[warmer] Started — ${WARM_POOL_SIZE} warm session slots`);
    } catch (err: any) {
      console.error(`[warmer] Startup error: ${err.message}`);
    }
  })();
}

/**
 * Gracefully shut down the warming service.
 * Closes all contexts and the shared browser.
 */
export function stopWarmer(): void {
  warmerStopped = true;
  // Close all session contexts
  for (const session of sessions.values()) {
    session.page.close().catch(() => {});
    session.context.close().catch(() => {});
  }
  sessions.clear();
  // Close browser
  if (sharedBrowser) {
    sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
  console.log('[warmer] Stopped');
}

/**
 * Get the best available warm session.
 *
 * Returns the highest-scoring session with warmthScore >= WARM_MIN_SCORE
 * that is not currently in use. Returns null if none qualify.
 *
 * @param preferProxy 'us' | 'de' — currently all sessions use DE proxies;
 *                    param accepted for future US proxy support
 */
export async function getWarmSession(
  _preferProxy?: 'us' | 'de',
): Promise<WarmSession | null> {
  if (!warmerStarted || warmerStopped || sessions.size === 0) return null;

  // Find all ready sessions (not in use, score meets threshold)
  const ready = Array.from(sessions.values()).filter(
    s => !s.inUse && s.warmthScore >= WARM_MIN_SCORE
  );

  if (ready.length === 0) return null;

  // Pick highest score
  ready.sort((a, b) => b.warmthScore - a.warmthScore);
  const best = ready[0];

  best.inUse = true;
  best.lastUsedAt = Date.now();
  return best;
}

/**
 * Return a warm session to the pool after use.
 * The session continues its warm-browse loop from where it left off.
 */
export function releaseWarmSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.inUse = false;
  // Score may have degraded after the real scrape; recompute
  session.warmthScore = computeWarmthScore(session);
}

/**
 * Return the warmer's shared browser if it is currently connected.
 * Used by pool.ts as a fallback when the pool's own browser launch fails —
 * avoids spawning a second Chromium process when one is already running.
 */
export function getWarmerBrowser(): import('playwright-core').Browser | null {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  return null;
}

/**
 * Warmer status — included in /health response.
 */
export function getWarmerStatus(): object {
  if (!warmerStarted) {
    return { enabled: false, reason: 'not started' };
  }
  if (WARM_POOL_SIZE === 0) {
    return { enabled: false, reason: 'WARM_POOL_SIZE=0' };
  }

  const all = Array.from(sessions.values());
  const ready = all.filter(s => !s.inUse && s.warmthScore >= WARM_MIN_SCORE);
  const inUse = all.filter(s => s.inUse);

  return {
    enabled: true,
    browserConnected: sharedBrowser?.isConnected() ?? false,
    poolSize: WARM_POOL_SIZE,
    totalSessions: all.length,
    readySessions: ready.length,
    inUseSessions: inUse.length,
    minScore: WARM_MIN_SCORE,
    sessions: all.map(s => ({
      id: s.id.slice(0, 8),
      warmthScore: s.warmthScore,
      pagesVisited: s.pagesVisited,
      inUse: s.inUse,
      ageMin: Math.round((Date.now() - s.createdAt) / 60_000),
    })),
  };
}
