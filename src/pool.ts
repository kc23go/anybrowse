import { chromium as chromiumBase } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { SessionPool, type PooledSession } from '@browsercash/pool';
import { loadEnvString, loadEnvNumber } from './env.js';
import { randomUUID } from 'crypto';

// ── rebrowser-patches: Runtime.enable CDP mode control ───────────────────────
// 'addBinding' = suppress Runtime.enable CDP command (applied via postinstall patch)
//   → hides automation from bot detectors that check for Runtime.enable
// '0' = use original Runtime.enable (fallback if patches not applied)
// Patches are applied to playwright-core via postinstall (dist/patch-playwright.js)
// 'addBinding' — suppresses Runtime.enable CDP command using Runtime.addBinding approach.
// Patches are applied to playwright-core at postinstall time (dist/patch-playwright.js).
// This is the stealth mode that hides CDP automation signals from bot detectors.
process.env['REBROWSER_PATCHES_RUNTIME_FIX_MODE'] = 'addBinding';

// Apply stealth plugin to evade bot detection
chromiumBase.use(StealthPlugin());
const chromium = chromiumBase;

const BROWSER_API_KEY = loadEnvString('BROWSER_API_KEY', '');
const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

// Pool configuration
const SESSION_MAX_USES = loadEnvNumber('SESSION_MAX_USES', 50);
const SESSION_MAX_AGE_MS = loadEnvNumber('SESSION_MAX_AGE_MS', 5 * 60 * 1000);
const HEALTH_CHECK_INTERVAL_MS = loadEnvNumber('HEALTH_CHECK_INTERVAL_MS', 10_000);

// Idle timeout: shut down pool after 10 minutes of no requests
const IDLE_SHUTDOWN_MS = loadEnvNumber('IDLE_SHUTDOWN_MS', 10 * 60 * 1000);

// Proxy pool — rotate through all available proxies
// Note: 161.77.10.249 (general residential) removed — proxy auth expired (407)
// Note: 95.134.167.203 removed — proxy auth expired (407)
const PROXY_POOL = [
  'http://14a3696c76e38:a7b82257a0@95.134.166.82:12323',    // ISP DE
  'http://14a3696c76e38:a7b82257a0@95.134.166.221:12323',   // ISP DE
  'http://14a3696c76e38:a7b82257a0@95.134.166.36:12323',    // ISP DE
  'http://14a3696c76e38:a7b82257a0@95.134.166.225:12323',   // ISP DE
  'http://14a3696c76e38:a7b82257a0@95.134.167.6:12323',     // ISP DE
];
let proxyIndex = 0;
function getNextProxy(): string {
  const proxy = PROXY_POOL[proxyIndex % PROXY_POOL.length];
  proxyIndex++;
  return proxy;
}
const RESIDENTIAL_PROXY = process.env.RESIDENTIAL_PROXY || PROXY_POOL[0];

export type { PooledSession };

// ── Local Playwright pool (PRIMARY) ─────────────────────────────────────────
// Residential-proxy-backed Playwright — always-on, no external API dependency.
// BrowserCash is secondary and used only if BROWSER_API_KEY is set AND it's healthy.

interface LocalSession {
  sessionId: string;
  cdpUrl: string;
  browser: import('playwright-core').Browser;
  createdAt: number;
  useCount: number;
}

let localSession: LocalSession | null = null;
let localSessionLock = false;
let localSessionWaiters: Array<{ resolve: (s: LocalSession) => void; reject: (e: Error) => void }> = [];

async function acquireLocalSession(): Promise<LocalSession> {
  // If there's an available session, return it
  if (localSession && localSession.browser.isConnected() && !localSessionLock) {
    localSessionLock = true;
    localSession.useCount++;
    return localSession;
  }

  // If no session yet, create one (or wait if being created)
  if (!localSession || !localSession.browser.isConnected()) {
    // Queue up if someone else is already creating
    if (localSessionLock) {
      return new Promise((resolve, reject) => {
        localSessionWaiters.push({ resolve, reject });
      });
    }

    localSessionLock = true;
    try {
      console.log('[pool:local] Launching local Playwright browser (residential proxy)...');
      const browser = await (chromium as any).launch({
        headless: true,
        proxy: { server: getNextProxy() },
        args: [
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
        ],
      });

      localSession = {
        sessionId: randomUUID(),
        cdpUrl: '',
        browser,
        createdAt: Date.now(),
        useCount: 1,
      };

      console.log('[pool:local] Local browser ready (residential proxy), sessionId=' + localSession.sessionId);

      // Resolve any waiters
      const waiters = localSessionWaiters.splice(0);
      for (const w of waiters) {
        localSession.useCount++;
        w.resolve(localSession);
      }

      localSessionSet.add(localSession);
      return localSession;
    } catch (err) {
      localSessionLock = false;
      const waiters = localSessionWaiters.splice(0);
      for (const w of waiters) w.reject(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  // Session exists but locked — wait
  return new Promise((resolve, reject) => {
    localSessionWaiters.push({ resolve, reject });
  });
}

function releaseLocalSession(session: LocalSession, hadError: boolean): void {
  if (hadError || session.useCount >= SESSION_MAX_USES ||
      Date.now() - session.createdAt > SESSION_MAX_AGE_MS) {
    // Close and reset for fresh session next time
    session.browser.close().catch(() => {});
    if (localSession === session) localSession = null;
  }

  localSessionLock = false;

  // Wake up next waiter
  const waiter = localSessionWaiters.shift();
  if (waiter) {
    if (localSession && localSession.browser.isConnected()) {
      localSessionLock = true;
      localSession.useCount++;
      waiter.resolve(localSession);
    } else {
      // Session was closed, create new one for the waiter
      acquireLocalSession().then(waiter.resolve).catch(waiter.reject);
    }
  }
}

function getLocalPoolStats(): { available: number; inUse: number; maxSize: number } {
  const hasSession = localSession !== null && localSession.browser.isConnected();
  return {
    available: hasSession && !localSessionLock ? 1 : 0,
    inUse: localSessionLock ? 1 : 0,
    maxSize: 1,
  };
}

// Track which acquired sessions came from local pool (for proper release routing)
const localSessionSet = new WeakSet<object>();

// ── Remote browser.cash pool (SECONDARY) ────────────────────────────────────
// Only used when BROWSER_API_KEY is configured. Falls back to local on failure,
// with exponential backoff + automatic retry (no permanent downgrade).

// Singleton pool instance
let pool: SessionPool | null = null;
let poolSize = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivity = 0;

// BrowserCash reliability tracking
let remoteSuccessCount = 0;
let remoteFailureCount = 0;
let remoteConsecutiveFailures = 0;
let remoteNextRetryMs = 0;

// Mode: 'remote' (browser.cash) or 'local' (residential-proxy playwright)
// Local is now the default — BrowserCash is opt-in via BROWSER_API_KEY and health.
const USE_REMOTE = Boolean(BROWSER_API_KEY);
let remoteHealthy = USE_REMOTE; // Assume healthy until proven otherwise

// Maximum consecutive failures before entering backoff
const REMOTE_MAX_CONSECUTIVE_FAILURES = 3;
// Backoff: 30s → 60s → 2min → 5min → 10min (capped)
const REMOTE_MAX_BACKOFF_MS = 10 * 60 * 1000;

/**
 * Calculate next backoff duration with exponential backoff
 */
function getBackoffMs(failureCount: number): number {
  return Math.min(30_000 * Math.pow(2, failureCount - 1), REMOTE_MAX_BACKOFF_MS);
}

/**
 * Record a successful remote acquire — reset failure tracking
 */
function recordRemoteSuccess(): void {
  remoteSuccessCount++;
  remoteConsecutiveFailures = 0;
  remoteHealthy = true;
  if (DEBUG_LOG) {
    console.log(`[pool:remote] Success #${remoteSuccessCount} (failures: ${remoteFailureCount})`);
  }
}

/**
 * Record a failed remote acquire — apply backoff if threshold exceeded
 */
function recordRemoteFailure(reason: string): void {
  remoteFailureCount++;
  remoteConsecutiveFailures++;
  const totalAttempts = remoteSuccessCount + remoteFailureCount;
  const successRate = totalAttempts > 0 ? (remoteSuccessCount / totalAttempts * 100).toFixed(1) : '0';
  console.warn(`[pool:remote] Failure #${remoteFailureCount} (consecutive: ${remoteConsecutiveFailures}, success rate: ${successRate}%): ${reason}`);

  if (remoteConsecutiveFailures >= REMOTE_MAX_CONSECUTIVE_FAILURES) {
    const backoffMs = getBackoffMs(remoteConsecutiveFailures);
    remoteNextRetryMs = Date.now() + backoffMs;
    remoteHealthy = false;
    console.warn(`[pool:remote] ${REMOTE_MAX_CONSECUTIVE_FAILURES} consecutive failures — backoff ${backoffMs / 1000}s until ${new Date(remoteNextRetryMs).toISOString()}`);
    // Shut down failed pool instance
    if (pool) {
      pool.shutdown().catch(() => {});
      pool = null;
    }
  }
}

/**
 * Check if remote pool is in backoff period, and auto-recover if backoff has expired
 */
function checkRemoteBackoff(): boolean {
  if (remoteHealthy) return false; // Not in backoff
  if (Date.now() >= remoteNextRetryMs) {
    // Backoff expired — try to recover
    console.log('[pool:remote] Backoff expired — attempting recovery');
    remoteHealthy = true;
    remoteConsecutiveFailures = 0;
    pool = null; // Force re-init on next attempt
    return false;
  }
  const remaining = Math.ceil((remoteNextRetryMs - Date.now()) / 1000);
  if (DEBUG_LOG) {
    console.log(`[pool:remote] In backoff — ${remaining}s remaining, using local`);
  }
  return true;
}

/**
 * Reset the idle shutdown timer
 */
function resetIdleTimer(): void {
  lastActivity = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (Date.now() - lastActivity >= IDLE_SHUTDOWN_MS) {
      console.log('[pool] Idle for ' + (IDLE_SHUTDOWN_MS / 60000) + ' minutes — shutting down to save costs');
      await shutdownPool();
    }
  }, IDLE_SHUTDOWN_MS);
}

/**
 * Ensure remote pool is initialized (lazy — only spins up when needed)
 */
async function ensurePool(): Promise<SessionPool> {
  if (pool) {
    resetIdleTimer();
    return pool;
  }

  console.log('[pool:remote] Lazy init — creating BrowserCash session pool on demand');
  pool = new SessionPool({
    apiKey: BROWSER_API_KEY,
    chromium,
    size: poolSize,
    maxUses: SESSION_MAX_USES,
    maxAgeMs: SESSION_MAX_AGE_MS,
    enableHealthCheck: true,
    healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
    enableWaitQueue: true,
    enableDisconnectHandling: true,
    debug: DEBUG_LOG,
  });

  await pool.init();
  resetIdleTimer();
  return pool;
}

/**
 * Get the pool instance — initializes lazily if needed
 * For synchronous access (healer health checks), returns null if not initialized
 */
export function getPool(): SessionPool {
  if (!pool) {
    throw new Error('Pool not initialized — use getPoolLazy() for on-demand access');
  }
  return pool;
}

/**
 * Check if pool is currently active (for health checks)
 */
export function isPoolActive(): boolean {
  if (!USE_REMOTE) return localSession !== null;
  return pool !== null || localSession !== null;
}

/**
 * Get pool stats safely (returns idle stats if pool is shut down)
 */
export function getPoolStats(): { available: number; inUse: number; maxSize: number } {
  if (!USE_REMOTE || !remoteHealthy) {
    return getLocalPoolStats();
  }
  if (!pool) {
    return { available: 0, inUse: 0, maxSize: poolSize };
  }
  return pool.stats();
}

/**
 * Get reliability stats for health endpoint
 */
export function getRemoteStats(): { successRate: string; successes: number; failures: number; healthy: boolean; inBackoff: boolean } {
  const total = remoteSuccessCount + remoteFailureCount;
  const successRate = total > 0 ? (remoteSuccessCount / total * 100).toFixed(1) + '%' : 'N/A';
  return {
    successRate,
    successes: remoteSuccessCount,
    failures: remoteFailureCount,
    healthy: remoteHealthy,
    inBackoff: !remoteHealthy && Date.now() < remoteNextRetryMs,
  };
}

// Timeout (ms) for remote browser.cash session acquisition before falling back to local
const REMOTE_ACQUIRE_TIMEOUT_MS = loadEnvNumber('REMOTE_ACQUIRE_TIMEOUT_MS', 30_000);

/**
 * Acquire a session — PRIMARY is local Playwright with residential proxy.
 * If BROWSER_API_KEY is set AND BrowserCash is healthy, uses BrowserCash instead.
 * Falls back to local on failure, with exponential backoff + auto-recovery.
 */
export async function acquireSession(): Promise<PooledSession> {
  resetIdleTimer();

  // PRIMARY: local Playwright with residential proxy (no external dependency)
  // Use BrowserCash only if: API key configured, not in backoff, and healthy
  const useRemote = USE_REMOTE && !checkRemoteBackoff();

  if (!useRemote) {
    if (DEBUG_LOG && USE_REMOTE) {
      console.log('[pool] BrowserCash unavailable/backoff — using local Playwright (residential proxy)');
    } else if (!USE_REMOTE) {
      console.log('[pool] Using local Playwright (residential proxy) — no BROWSER_API_KEY');
    }
    return acquireLocalSession() as unknown as PooledSession;
  }

  // Try BrowserCash
  try {
    const p = await ensurePool();

    // Race between remote acquire and a fallback timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Remote session acquire timed out after ' + REMOTE_ACQUIRE_TIMEOUT_MS + 'ms')), REMOTE_ACQUIRE_TIMEOUT_MS)
    );

    const session = await Promise.race([p.acquire(), timeoutPromise]);
    recordRemoteSuccess();
    return session;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordRemoteFailure(msg);
    console.warn('[pool] BrowserCash failed — falling back to local Playwright (residential proxy)');
    return acquireLocalSession() as unknown as PooledSession;
  }
}

/**
 * Release a session back to the pool
 */
export function releaseSession(session: PooledSession, hadError: boolean): void {
  // Use WeakSet to reliably distinguish local vs remote sessions
  if (localSessionSet.has(session as unknown as object)) {
    releaseLocalSession(session as unknown as LocalSession, hadError);
    resetIdleTimer();
    return;
  }
  if (pool) {
    pool.release(session, hadError);
    resetIdleTimer();
    return;
  }
  // Fallback: treat as local if pool is gone
  releaseLocalSession(session as unknown as LocalSession, hadError);
  resetIdleTimer();
}

/**
 * Initialize pool config (does NOT create sessions — that happens on first request)
 */
export async function initPool(size: number): Promise<void> {
  poolSize = size;
  const mode = USE_REMOTE
    ? 'local (residential proxy) PRIMARY + BrowserCash SECONDARY'
    : 'local (residential proxy) only';
  console.log('[pool] Lazy pool configured (size=' + size + ', mode=' + mode + ', idle shutdown=' + (IDLE_SHUTDOWN_MS / 60000) + 'min)');
  console.log('[pool] Sessions will be created on first request — $0 cost while idle');
  if (USE_REMOTE) {
    console.log('[pool] BrowserCash will be tried first; falls back to residential proxy on failure with backoff');
  }
}

/**
 * Shutdown the pool and close all sessions
 */
export async function shutdownPool(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (pool) {
    await pool.shutdown();
    pool = null;
    console.log('[pool] Remote pool shutdown complete');
  }
  if (localSession) {
    await localSession.browser.close().catch(() => {});
    localSession = null;
    console.log('[pool] Local pool shutdown complete');
  }
}
