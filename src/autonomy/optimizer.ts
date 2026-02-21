import { readFileSync, writeFileSync, existsSync } from "fs";
import { stats } from "../stats.js";

const CONFIG_FILE = "/agent/data/config.json";
const OPTIMIZER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export interface AgentConfig {
  pricing: {
    scrape: number;   // micro-USDC (e.g., 3000 = $0.003)
    crawl: number;
    search: number;
  };
  poolSize: number;
  slowScrapeFirstDomains: string[];
  blockedDomains: string[];
  lastOptimized: string;
  optimizerLog: string[];
}

const DEFAULT_CONFIG: AgentConfig = {
  pricing: {
    scrape: 3000,
    crawl: 5000,
    search: 2000,
  },
  poolSize: 1,
  slowScrapeFirstDomains: [],
  blockedDomains: [],
  lastOptimized: new Date().toISOString(),
  optimizerLog: [],
};

let optimizerTimer: ReturnType<typeof setInterval> | null = null;
let currentConfig: AgentConfig = { ...DEFAULT_CONFIG };

export function loadConfig(): AgentConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      currentConfig = { ...DEFAULT_CONFIG, ...data };
      console.log("[optimizer] Loaded config from", CONFIG_FILE);
    }
  } catch (err) {
    console.warn("[optimizer] Failed to load config:", err instanceof Error ? err.message : err);
  }
  return currentConfig;
}

function saveConfig(): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2));
  } catch (err) {
    console.warn("[optimizer] Failed to save config:", err instanceof Error ? err.message : err);
  }
}

function addLog(message: string): void {
  const entry = `[${new Date().toISOString()}] ${message}`;
  currentConfig.optimizerLog.push(entry);
  // Keep last 100 entries
  if (currentConfig.optimizerLog.length > 100) {
    currentConfig.optimizerLog = currentConfig.optimizerLog.slice(-100);
  }
  console.log("[optimizer]", message);
}

function optimize(): void {
  const snapshot = stats.getSnapshot();
  let changed = false;

  // Check success rate across paid endpoints
  for (const [path, ep] of Object.entries(snapshot.endpoints)) {
    if (ep.total < 10) continue; // not enough data

    const successRate = ep.success / ep.total;

    // If success rate drops below 70%, log it
    if (successRate < 0.7) {
      addLog(`Low success rate on ${path}: ${(successRate * 100).toFixed(1)}% (${ep.success}/${ep.total})`);
    }
  }

  // Check domain failure rates
  for (const [domain, record] of Object.entries(snapshot.topDomains)) {
    if (record.total < 5) continue;

    const failRate = record.failed / record.total;
    if (failRate > 0.6 && !currentConfig.slowScrapeFirstDomains.includes(domain)) {
      currentConfig.slowScrapeFirstDomains.push(domain);
      addLog(`Added ${domain} to slow-scrape-first list (fail rate: ${(failRate * 100).toFixed(1)}%)`);
      changed = true;
    }
  }

  // Check hourly request volume for demand signals
  const recentHours = snapshot.hourly.slice(-4);
  const avgRequestsPerHour = recentHours.length > 0
    ? recentHours.reduce((sum, h) => sum + h.requests, 0) / recentHours.length
    : 0;

  if (avgRequestsPerHour > 100) {
    addLog(`High demand detected: ${avgRequestsPerHour.toFixed(0)} req/hr avg`);
  }

  currentConfig.lastOptimized = new Date().toISOString();
  if (changed) {
    saveConfig();
  }
}

export function startOptimizer(): void {
  if (optimizerTimer) return;
  loadConfig();
  console.log("[optimizer] Starting self-optimizer (interval: 15m)");
  optimizerTimer = setInterval(optimize, OPTIMIZER_INTERVAL_MS);
}

export function stopOptimizer(): void {
  if (optimizerTimer) {
    clearInterval(optimizerTimer);
    optimizerTimer = null;
  }
  saveConfig();
}

export function getConfig(): AgentConfig {
  return { ...currentConfig };
}
