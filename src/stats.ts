import { readFileSync, writeFileSync, existsSync } from "fs";

const STATS_FILE = "/agent/data/stats.json";
const PERSIST_INTERVAL_MS = 60_000; // save every 60s

interface EndpointStats {
  total: number;
  success: number;
  failed: number;
  empty: number;
  totalResponseTimeMs: number;
  x402Payments: number;
}

interface HourlyBucket {
  hour: string; // ISO date-hour "2026-02-19T14"
  requests: number;
  revenue: number; // estimated USDC micro-units
}

interface DomainRecord {
  total: number;
  success: number;
  failed: number;
}

export interface StatsSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  endpoints: Record<string, EndpointStats>;
  hourly: HourlyBucket[];
  topDomains: Record<string, DomainRecord>;
  totalRequests: number;
  totalPayments: number;
  estimatedEarningsUSDC: string;
}

class StatsTracker {
  private startedAt = new Date();
  private endpoints: Record<string, EndpointStats> = {};
  private hourly: HourlyBucket[] = [];
  private topDomains: Record<string, DomainRecord> = {};
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.load();
    this.persistTimer = setInterval(() => this.save(), PERSIST_INTERVAL_MS);
  }

  private getOrCreateEndpoint(path: string): EndpointStats {
    if (!this.endpoints[path]) {
      this.endpoints[path] = {
        total: 0,
        success: 0,
        failed: 0,
        empty: 0,
        totalResponseTimeMs: 0,
        x402Payments: 0,
      };
    }
    return this.endpoints[path];
  }

  private getCurrentHourBucket(): HourlyBucket {
    const hour = new Date().toISOString().slice(0, 13);
    let bucket = this.hourly.find((b) => b.hour === hour);
    if (!bucket) {
      bucket = { hour, requests: 0, revenue: 0 };
      this.hourly.push(bucket);
      // Keep last 168 hours (7 days)
      if (this.hourly.length > 168) {
        this.hourly = this.hourly.slice(-168);
      }
    }
    return bucket;
  }

  recordRequest(path: string, statusCode: number, responseTimeMs: number, hadPayment: boolean): void {
    const ep = this.getOrCreateEndpoint(path);
    ep.total++;
    ep.totalResponseTimeMs += responseTimeMs;

    if (statusCode >= 200 && statusCode < 300) {
      ep.success++;
    } else if (statusCode === 402) {
      // Payment required — not a failure, just unpaid
    } else {
      ep.failed++;
    }

    if (hadPayment) {
      ep.x402Payments++;
    }

    const bucket = this.getCurrentHourBucket();
    bucket.requests++;
    if (hadPayment) {
      const prices: Record<string, number> = {
        "/scrape": 3000,
        "/crawl": 5000,
        "/serp/search": 2000,
      };
      bucket.revenue += prices[path] || 0;
    }
  }

  recordDomain(domain: string, success: boolean): void {
    if (!this.topDomains[domain]) {
      this.topDomains[domain] = { total: 0, success: 0, failed: 0 };
    }
    this.topDomains[domain].total++;
    if (success) {
      this.topDomains[domain].success++;
    } else {
      this.topDomains[domain].failed++;
    }
  }

  getSnapshot(): StatsSnapshot {
    const now = new Date();
    const uptimeSeconds = Math.floor((now.getTime() - this.startedAt.getTime()) / 1000);

    let totalRequests = 0;
    let totalPayments = 0;
    let estimatedMicro = 0;

    const prices: Record<string, number> = {
      "/scrape": 3000,
      "/crawl": 5000,
      "/serp/search": 2000,
    };

    for (const [path, ep] of Object.entries(this.endpoints)) {
      totalRequests += ep.total;
      totalPayments += ep.x402Payments;
      estimatedMicro += ep.x402Payments * (prices[path] || 0);
    }

    // Sort domains by total, keep top 50
    const sortedDomains = Object.entries(this.topDomains)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 50);

    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds,
      endpoints: { ...this.endpoints },
      hourly: this.hourly.slice(-24), // Last 24 hours
      topDomains: Object.fromEntries(sortedDomains),
      totalRequests,
      totalPayments,
      estimatedEarningsUSDC: (estimatedMicro / 1_000_000).toFixed(6),
    };
  }

  private load(): void {
    try {
      if (existsSync(STATS_FILE)) {
        const data = JSON.parse(readFileSync(STATS_FILE, "utf-8"));
        this.endpoints = data.endpoints || {};
        this.hourly = data.hourly || [];
        this.topDomains = data.topDomains || {};
        if (data.startedAt) {
          this.startedAt = new Date(data.startedAt);
        }
        console.log("[stats] Loaded persisted stats from", STATS_FILE);
      }
    } catch (err) {
      console.warn("[stats] Failed to load stats:", err instanceof Error ? err.message : err);
    }
  }

  save(): void {
    try {
      const data = {
        startedAt: this.startedAt.toISOString(),
        endpoints: this.endpoints,
        hourly: this.hourly,
        topDomains: this.topDomains,
      };
      writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn("[stats] Failed to save stats:", err instanceof Error ? err.message : err);
    }
  }

  shutdown(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    this.save();
  }
}

// Singleton
export const stats = new StatsTracker();
