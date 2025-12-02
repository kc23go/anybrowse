import { chromium } from 'playwright-core';
import { SessionPool, type PooledSession } from '@browsercash/pool';
import { loadEnvString, loadEnvNumber } from './env.js';

const BROWSER_API_KEY = loadEnvString('BROWSER_API_KEY');
const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

// Pool configuration
const SESSION_MAX_USES = loadEnvNumber('SESSION_MAX_USES', 50);
const SESSION_MAX_AGE_MS = loadEnvNumber('SESSION_MAX_AGE_MS', 5 * 60 * 1000);
const HEALTH_CHECK_INTERVAL_MS = loadEnvNumber('HEALTH_CHECK_INTERVAL_MS', 10_000);

export type { PooledSession };

// Singleton pool instance
let pool: SessionPool | null = null;

/**
 * Get the initialized pool instance
 * @throws Error if pool not initialized
 */
export function getPool(): SessionPool {
  if (!pool) {
    throw new Error('Pool not initialized - call initPool() first');
  }
  return pool;
}

/**
 * Initialize the browser session pool
 */
export async function initPool(size: number): Promise<SessionPool> {
  if (pool) {
    return pool;
  }

  pool = new SessionPool({
    apiKey: BROWSER_API_KEY,
    chromium,
    size,
    maxUses: SESSION_MAX_USES,
    maxAgeMs: SESSION_MAX_AGE_MS,
    enableHealthCheck: true,
    healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
    enableWaitQueue: true,
    enableDisconnectHandling: true,
    debug: DEBUG_LOG,
  });

  await pool.init();
  return pool;
}

/**
 * Shutdown the pool and close all sessions
 */
export async function shutdownPool(): Promise<void> {
  if (pool) {
    await pool.shutdown();
    pool = null;
  }
}
