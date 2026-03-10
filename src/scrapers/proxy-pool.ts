/**
 * proxy-pool.ts — Country-targeted proxy pool for Scout scrapers
 *
 * Reads config/proxies.json (relative to the anybrowse project root).
 * Exposes getProxy(country) → Playwright-compatible ProxyConfig.
 *
 * Proxy config format (proxies.json):
 *   { "us": [{ host, port, user, pass, country }], "de": [...] }
 *
 * Why not just use the pool.ts proxy pool?
 *   pool.ts runs German ISP proxies for general scraping.
 *   Scout's retail scrapers need US IPs so Walmart/BestBuy/Amazon
 *   serve US prices and US inventory — not German storefronts.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve config/proxies.json from anybrowse project root
// src/scrapers/ → ../../ → anybrowse/
const CONFIG_PATH = join(__dirname, '../../config/proxies.json');

// ── Types ─────────────────────────────────────────────────────────────────────

/** Playwright-compatible proxy config */
export interface ProxyConfig {
  server: string;       // "http://host:port"
  username: string;
  password: string;
}

interface RawProxyEntry {
  host: string;
  port: number;
  user: string;
  pass: string;
  country?: string;
}

interface ProxiesFile {
  us?: RawProxyEntry[];
  de?: RawProxyEntry[];
}

// ── Load & parse config ───────────────────────────────────────────────────────

let _config: ProxiesFile | null = null;

function loadConfig(): ProxiesFile {
  if (_config) return _config;

  if (!existsSync(CONFIG_PATH)) {
    console.warn(`[proxy-pool] Config not found at ${CONFIG_PATH} — proxy pool disabled`);
    return {};
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    _config = JSON.parse(raw) as ProxiesFile;
    const usCnt = _config.us?.length ?? 0;
    const deCnt = _config.de?.length ?? 0;
    console.log(`[proxy-pool] Loaded ${usCnt} US + ${deCnt} DE proxies from ${CONFIG_PATH}`);
    return _config;
  } catch (err: any) {
    console.error(`[proxy-pool] Failed to parse proxies.json: ${err.message}`);
    return {};
  }
}

function rawToPlaywright(entry: RawProxyEntry): ProxyConfig {
  return {
    server: `http://${entry.host}:${entry.port}`,
    username: entry.user,
    password: entry.pass,
  };
}

// ── Per-country round-robin counters ──────────────────────────────────────────
const counters: Record<string, number> = { us: 0, de: 0 };

/**
 * Get a proxy for the given country pool using round-robin rotation.
 * Returns null if no proxies are configured for that country.
 */
export function getProxy(country: 'us' | 'de'): ProxyConfig | null {
  const config = loadConfig();
  const pool = config[country];

  if (!pool || pool.length === 0) {
    console.warn(`[proxy-pool] No proxies configured for country="${country}"`);
    return null;
  }

  const idx = counters[country] % pool.length;
  counters[country]++;
  return rawToPlaywright(pool[idx]);
}

/**
 * Get all proxies for a country (for debugging / health checks).
 */
export function getAllProxies(country: 'us' | 'de'): ProxyConfig[] {
  const config = loadConfig();
  return (config[country] ?? []).map(rawToPlaywright);
}

/**
 * Check whether a country pool has proxies available.
 */
export function hasProxies(country: 'us' | 'de'): boolean {
  const config = loadConfig();
  return (config[country]?.length ?? 0) > 0;
}
