import { chromium as chromiumBase } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { SessionPool, type PooledSession } from '@browsercash/pool';
import { loadEnvString, loadEnvNumber } from './env.js';

// Apply stealth plugin to evade bot detection
chromiumBase.use(StealthPlugin());
const chromium = chromiumBase;

const BROWSER_API_KEY = loadEnvString('BROWSER_API_KEY');
const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

// Pool configuration
const SESSION_MAX_USES = loadEnvNumber('SESSION_MAX_USES', 50);
const SESSION_MAX_AGE_MS = loadEnvNumber('SESSION_MAX_AGE_MS', 5 * 60 * 1000);
const HEALTH_CHECK_INTERVAL_MS = loadEnvNumber('HEALTH_CHECK_INTERVAL_MS', 10_000);

// Idle timeout: shut down pool after 10 minutes of no requests
const IDLE_SHUTDOWN_MS = loadEnvNumber('IDLE_SHUTDOWN_MS', 10 * 60 * 1000);

export type { PooledSession };

// Singleton pool instance
let pool: SessionPool | null = null;
let poolSize = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivity = 0;

/**
 * Reset the idle shutdown timer
 */
function resetIdleTimer(): void {
  lastActivity = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (pool && Date.now() - lastActivity >= IDLE_SHUTDOWN_MS) {
      console.log('[pool] Idle for ' + (IDLE_SHUTDOWN_MS / 60000) + ' minutes — shutting down to save costs');
      await shutdownPool();
    }
  }, IDLE_SHUTDOWN_MS);
}

/**
 * Ensure pool is initialized (lazy — only spins up when needed)
 */
async function ensurePool(): Promise<SessionPool> {
  if (pool) {
    resetIdleTimer();
    return pool;
  }

  console.log('[pool] Lazy init — creating session pool on demand');
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
  return pool !== null;
}

/**
 * Get pool stats safely (returns idle stats if pool is shut down)
 */
export function getPoolStats(): { available: number; inUse: number; maxSize: number } {
  if (!pool) {
    return { available: 0, inUse: 0, maxSize: poolSize };
  }
  return pool.stats();
}

/**
 * Acquire a session — lazily initializes pool if needed
 */
export async function acquireSession(): Promise<PooledSession> {
  const p = await ensurePool();
  resetIdleTimer();
  return p.acquire();
}

/**
 * Release a session back to the pool
 */
export function releaseSession(session: PooledSession, hadError: boolean): void {
  if (!pool) return;
  pool.release(session, hadError);
  resetIdleTimer();
}

/**
 * Initialize pool config (does NOT create sessions — that happens on first request)
 */
export async function initPool(size: number): Promise<void> {
  poolSize = size;
  console.log('[pool] Lazy pool configured (size=' + size + ', idle shutdown=' + (IDLE_SHUTDOWN_MS / 60000) + 'min)');
  console.log('[pool] Sessions will be created on first request — $0 cost while idle');
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
    console.log('[pool] Shutdown complete — no active sessions');
  }
}
