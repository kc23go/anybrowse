import { totalmem } from "os";
import { isPoolActive, getPoolStats } from "../pool.js";
import { stats } from "../stats.js";
import { loadEnvString } from "../env.js";

const HEALER_INTERVAL_MS = 30_000;
const MEMORY_THRESHOLD = 0.80;
const ERROR_RATE_THRESHOLD = 0.5;
const MEMORY_CRITICAL_THRESHOLD = 0.95;
const ZOMBIE_AGE_MS = 6 * 60 * 1000; // 6 minutes — slightly longer than pool maxAgeMs (5 min)

const BROWSER_API_KEY = loadEnvString("BROWSER_API_KEY");
const BROWSER_API_BASE = "https://api.browser.cash/v1/browser";

// Only count these paths for error rate — ignore bot scanner noise
const REAL_ENDPOINTS = new Set(["/", "/scrape", "/crawl", "/serp/search", "/mcp", "/health", "/stats", "/earnings", "/autonomy", "/gaps"]);

let healerTimer: ReturnType<typeof setInterval> | null = null;
let consecutivePoolFailures = 0;
let poolDegradedSince: string | null = null;
let lastZombieCleanup = 0;

interface HealthCheck {
  ok: boolean;
  rssPercent?: number;
  details?: string;
  rate?: number;
}

export interface HealthStatus {
  healthy: boolean;
  checks: {
    memory: HealthCheck;
    pool: HealthCheck;
    errorRate: HealthCheck;
  };
  lastCheck: string;
  actions: string[];
  poolDegradedSince: string | null;
}

let lastStatus: HealthStatus | null = null;

function checkMemory(): HealthCheck {
  const used = process.memoryUsage();
  const total = totalmem();
  const rssPercent = used.rss / total;
  return { ok: rssPercent < MEMORY_THRESHOLD, rssPercent };
}

function checkPool(): HealthCheck {
  // Pool is lazy — being inactive is normal (saves costs when idle)
  if (!isPoolActive()) {
    return { ok: true, details: "Pool idle (lazy mode — starts on first request)" };
  }
  try {
    const poolStats = getPoolStats();
    const ok = poolStats.available > 0 || poolStats.inUse > 0;
    return {
      ok,
      details: "available=" + poolStats.available + " inUse=" + poolStats.inUse + " total=" + poolStats.maxSize,
    };
  } catch {
    return { ok: false, details: "Pool error" };
  }
}

function checkErrorRate(): HealthCheck {
  const snapshot = stats.getSnapshot();
  let totalRecent = 0;
  let failedRecent = 0;

  for (const [path, ep] of Object.entries(snapshot.endpoints)) {
    // Only count real endpoints, not bot scanner probes
    if (!REAL_ENDPOINTS.has(path)) continue;
    totalRecent += ep.total;
    failedRecent += ep.failed;
  }

  const rate = totalRecent > 0 ? failedRecent / totalRecent : 0;
  return { ok: rate < ERROR_RATE_THRESHOLD, rate };
}

async function cleanupZombieSessions(): Promise<string[]> {
  const actions: string[] = [];
  const now = Date.now();

  // Only run cleanup every 2 minutes to avoid API spam
  if (now - lastZombieCleanup < 120_000) return actions;
  lastZombieCleanup = now;

  try {
    const listRes = await fetch(BROWSER_API_BASE + "/sessions?pageSize=100", {
      headers: { Authorization: "Bearer " + BROWSER_API_KEY },
    });
    if (!listRes.ok) return actions;

    const data = await listRes.json() as { sessions?: Array<{ sessionId: string; status: string; createdAt: string }> };
    const sessions = data.sessions || [];
    const zombies = sessions.filter((s) => {
      if (s.status !== "active") return false;
      const age = now - new Date(s.createdAt).getTime();
      return age > ZOMBIE_AGE_MS;
    });

    if (zombies.length === 0) return actions;

    let stopped = 0;
    for (const z of zombies) {
      try {
        const stopRes = await fetch(
          BROWSER_API_BASE + "/session?sessionId=" + encodeURIComponent(z.sessionId),
          {
            method: "DELETE",
            headers: { Authorization: "Bearer " + BROWSER_API_KEY },
          }
        );
        if (stopRes.ok) stopped++;
      } catch {
        // ignore individual stop failures
      }
    }

    if (stopped > 0) {
      console.log("[healer] Cleaned up " + stopped + " zombie browser sessions");
      actions.push("Cleaned " + stopped + " zombie sessions");
    }
  } catch {
    // ignore cleanup errors — non-critical
  }

  return actions;
}

function handlePoolDegraded(): string[] {
  const actions: string[] = [];
  consecutivePoolFailures++;

  if (!poolDegradedSince) {
    poolDegradedSince = new Date().toISOString();
  }

  if (consecutivePoolFailures === 1) {
    console.warn("[healer] Browser pool is empty — upstream may be down");
    actions.push("Pool degraded — monitoring");
  } else if (consecutivePoolFailures % 20 === 0) {
    console.warn("[healer] Pool still degraded (" + consecutivePoolFailures + " consecutive failures, since " + poolDegradedSince + ")");
    actions.push("Pool degraded for " + consecutivePoolFailures + " checks");
  }

  return actions;
}

async function runHealthCheck(): Promise<void> {
  const actions: string[] = [];

  const memory = checkMemory();
  const pool = checkPool();
  const errorRate = checkErrorRate();

  if (!memory.ok) {
    const pct = ((memory.rssPercent || 0) * 100).toFixed(1);
    if ((memory.rssPercent || 0) >= MEMORY_CRITICAL_THRESHOLD) {
      console.error("[healer] CRITICAL memory usage: " + pct + "% — restarting");
      actions.push("Critical memory (" + pct + "%) — restart");
      process.exit(1);
    } else {
      console.warn("[healer] High memory usage: " + pct + "%");
      if (global.gc) {
        global.gc();
        actions.push("Forced GC due to memory pressure");
      }
    }
  }

  // Clean up zombie sessions when pool is degraded
  if (!pool.ok) {
    const zombieActions = await cleanupZombieSessions();
    actions.push(...zombieActions);

    const poolActions = handlePoolDegraded();
    actions.push(...poolActions);
  } else {
    if (consecutivePoolFailures > 0) {
      console.log("[healer] Pool recovered after " + consecutivePoolFailures + " failures");
      actions.push("Pool recovered");
    }
    consecutivePoolFailures = 0;
    poolDegradedSince = null;
  }

  if (!errorRate.ok) {
    if (consecutivePoolFailures % 20 === 0 || consecutivePoolFailures === 0) {
      console.warn("[healer] High error rate: " + ((errorRate.rate || 0) * 100).toFixed(1) + "%");
    }
  }

  const healthy = memory.ok && pool.ok && errorRate.ok;
  lastStatus = {
    healthy,
    checks: { memory, pool, errorRate },
    lastCheck: new Date().toISOString(),
    actions,
    poolDegradedSince,
  };
}

export function startHealer(): void {
  if (healerTimer) return;
  console.log("[healer] Starting self-healing monitor (interval: 30s)");
  runHealthCheck();
  healerTimer = setInterval(runHealthCheck, HEALER_INTERVAL_MS);
}

export function stopHealer(): void {
  if (healerTimer) {
    clearInterval(healerTimer);
    healerTimer = null;
  }
}

export function getHealthStatus(): HealthStatus | null {
  return lastStatus;
}
