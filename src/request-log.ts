/**
 * request-log.ts — Privacy-safe per-request logging for anybrowse
 *
 * Primary storage: SQLite (anybrowse.db via db.ts)
 * Backup storage: JSONL (request-log.jsonl)
 *
 * Logs who is calling anybrowse (which AI assistants, which tools, what they scrape)
 * WITHOUT storing raw IPs. ip_hash = first 8 chars of sha256(ip).
 */

import { createHash } from "crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  renameSync,
  mkdirSync,
} from "fs";
import { db, insertRequest, upsertSession, upsertDomain, classifyDomain, extractDomain, finalizeSession } from "./db.js";

const LOG_FILE = "/agent/data/request-log.jsonl";
const DATA_DIR = "/agent/data";
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

// Endpoints where the URL is meaningful to log
const LOG_URL_ENDPOINTS = new Set(["/scrape", "/crawl"]);

// ─── Stats Exclusion Logic ────────────────────────────────────────────────────

const EXCLUDED_IPS_FILE = "/agent/data/excluded-ips.json";

/** Hard-coded excluded IP hashes (first 8 chars of sha256) */
const EXCLUDED_IP_HASHES_STATIC = new Set([
  '5c2a3f8f',  // KC's own IP (owner/internal testing)
]);

/** Registry bots, health probers, and scanner UAs — case-insensitive match */
const EXCLUDED_UA_PATTERNS = [
  'mcpdd',
  'glama',
  'mcpscoringengine',
  'mcp-verify',
  'mcp-gateway',
  'mcp-probe',
  'registry-health-checker',
  'smithery',
  'libredtail',
  'python-httpx/0',  // generic httpx without custom UA — often bots
];

/** Endpoints that should never count toward user-facing stats */
const EXCLUDED_STAT_ENDPOINTS = new Set([
  '/health',
  '/stats',
  '/earnings',
  '/relay/stats',
]);

/** Dynamic exclusion list (persisted JSON), reloaded every 30s */
let _dynamicExcludedIps = new Map<string, string>(); // ip_hash_prefix -> reason
let _dynamicLoadedAt = 0;
const DYNAMIC_RELOAD_MS = 30_000;

function loadDynamicExclusions(): void {
  try {
    if (existsSync(EXCLUDED_IPS_FILE)) {
      const data = JSON.parse(readFileSync(EXCLUDED_IPS_FILE, 'utf-8'));
      _dynamicExcludedIps = new Map(Object.entries(data as Record<string, string>));
    }
  } catch {
    // ignore parse errors
  }
  _dynamicLoadedAt = Date.now();
}

function maybeReloadDynamic(): void {
  if (Date.now() - _dynamicLoadedAt > DYNAMIC_RELOAD_MS) loadDynamicExclusions();
}

// Load on module startup
loadDynamicExclusions();

/**
 * Add an IP hash to the dynamic exclusion list and persist it.
 * Returns true on success.
 */
export function addExcludedIp(ipHash: string, reason: string): boolean {
  try {
    let data: Record<string, string> = {};
    if (existsSync(EXCLUDED_IPS_FILE)) {
      data = JSON.parse(readFileSync(EXCLUDED_IPS_FILE, 'utf-8'));
    }
    const prefix = ipHash.slice(0, 8);
    data[prefix] = reason;
    writeFileSync(EXCLUDED_IPS_FILE, JSON.stringify(data, null, 2));
    _dynamicExcludedIps.set(prefix, reason);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the full dynamic exclusion map (prefix -> reason).
 */
export function getDynamicExclusions(): Record<string, string> {
  maybeReloadDynamic();
  return Object.fromEntries(_dynamicExcludedIps);
}

/**
 * Determine whether a request should be excluded from all stats/analytics.
 * Called before writing to SQLite, JSONL, or the in-memory stats counter.
 * @param ipHash     - 8+ char hex hash of the IP
 * @param userAgent  - raw User-Agent header value
 * @param endpoint   - request path (e.g. "/scrape")
 * @param clientName - optional parsed client name (from MCP clientInfo.name or UA)
 */
export function shouldExcludeFromStats(ipHash: string, userAgent: string, endpoint: string, clientName?: string): boolean {
  maybeReloadDynamic();

  const prefix = ipHash.slice(0, 8);
  if (EXCLUDED_IP_HASHES_STATIC.has(prefix)) return true;
  if (_dynamicExcludedIps.has(prefix)) return true;
  if (EXCLUDED_STAT_ENDPOINTS.has(endpoint)) return true;
  // WP-admin / WordPress vulnerability scanners
  if (endpoint.includes('wp-admin') || endpoint.includes('wordpress') || endpoint.startsWith('/wp-')) return true;

  // Check UA patterns
  const uaLower = (userAgent || '').toLowerCase();
  if (EXCLUDED_UA_PATTERNS.some(p => uaLower.includes(p))) return true;

  // Also check client name (from MCP clientInfo.name — registry bots identify themselves here)
  if (clientName) {
    const clientLower = clientName.toLowerCase();
    if (EXCLUDED_UA_PATTERNS.some(p => clientLower.includes(p))) return true;
  }

  return false;
}

/**
 * SQL WHERE fragment to filter bot/internal requests at read time.
 * Used by computeInsightsFromSQLite so historical data is also cleaned.
 * Checks both ua (HTTP User-Agent) AND client/mcp_client_name (from MCP clientInfo).
 */
const BOT_FILTER_SQL = `
  AND ip_hash NOT LIKE '5c2a3f8f%'
  AND endpoint NOT IN ('/health', '/stats', '/earnings', '/relay/stats')
  AND endpoint NOT LIKE '/wp-%'
  AND endpoint NOT LIKE '%wordpress%'
  AND (ua IS NULL OR (
    ua NOT LIKE '%mcpdd%'
    AND ua NOT LIKE '%glama%'
    AND ua NOT LIKE '%MCPScoringEngine%'
    AND ua NOT LIKE '%mcp-verify%'
    AND ua NOT LIKE '%mcp-gateway%'
    AND ua NOT LIKE '%mcp-probe%'
    AND ua NOT LIKE '%registry-health-checker%'
    AND ua NOT LIKE '%Smithery%'
    AND ua NOT LIKE '%smithery%'
    AND ua NOT LIKE '%libredtail%'
    AND ua NOT LIKE '%python-httpx/0%'
  ))
  AND (client IS NULL OR (
    client NOT LIKE '%mcpdd%'
    AND client NOT LIKE '%glama%'
    AND client NOT LIKE '%MCPScoringEngine%'
    AND client NOT LIKE '%mcp-verify%'
    AND client NOT LIKE '%mcp-gateway%'
    AND client NOT LIKE '%mcp-probe%'
    AND client NOT LIKE '%registry-health-checker%'
    AND client NOT LIKE '%Smithery%'
    AND client NOT LIKE '%smithery%'
    AND client NOT LIKE '%libredtail%'
    AND client NOT LIKE '%smithery-probe%'
    AND client NOT LIKE '%mcp-introspector%'
  ))
  AND (mcp_client_name IS NULL OR (
    mcp_client_name NOT LIKE '%mcpdd%'
    AND mcp_client_name NOT LIKE '%glama%'
    AND mcp_client_name NOT LIKE '%Smithery%'
    AND mcp_client_name NOT LIKE '%smithery%'
    AND mcp_client_name NOT LIKE '%mcp-verify%'
    AND mcp_client_name NOT LIKE '%mcp-gateway%'
    AND mcp_client_name NOT LIKE '%mcp-probe%'
    AND mcp_client_name NOT LIKE '%registry-health-checker%'
    AND mcp_client_name NOT LIKE '%libredtail%'
    AND mcp_client_name NOT LIKE '%mcp-introspector%'
  ))
`;

export type RequestStatus = "success" | "failed" | "payment" | "ratelimited";

export interface RequestLogEntry {
  ts: string;
  endpoint: string;
  ua: string;
  client: string;
  ip_hash: string;
  country?: string;
  countryCode?: string;
  city?: string;
  org?: string;
  mcpTool?: string;
  url?: string;
  status: RequestStatus;
  ms: number;
  sessionId?: string;
  // New intelligence fields
  mcpClientName?: string;    // exact clientInfo.name from MCP initialize
  contextValue?: string;     // optional agent intent context
  wordCount?: number;        // word count of returned markdown
  topKeywords?: string[];    // top 3 keywords extracted
}

// ─── IP Geolocation ────────────────────────────────────────────────────────────

interface GeoData {
  country: string;
  countryCode: string;
  city: string;
  org: string;
  cachedAt: number;
}

const geoCache = new Map<string, GeoData>();
const GEO_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Returns true for private/loopback IPs that should not be geolocated.
 */
function isPrivateIp(ip: string): boolean {
  if (!ip || ip === "unknown" || ip === "::1" || ip === "127.0.0.1") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  // 172.16.0.0 – 172.31.255.255
  const m = ip.match(/^172\.(\d+)\./);
  if (m && parseInt(m[1], 10) >= 16 && parseInt(m[1], 10) <= 31) return true;
  return false;
}

/**
 * Look up geolocation for an IP using ip-api.com (free, no key needed).
 * Results are cached in-memory for 1 hour.
 * Timeout: 500ms — returns null if slow or unavailable.
 * Skips private/loopback IPs.
 */
async function lookupGeo(ip: string): Promise<GeoData | null> {
  if (isPrivateIp(ip)) return null;

  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.cachedAt < GEO_CACHE_TTL) {
    return cached;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);

    const response = await fetch(
      `http://ip-api.com/json/${ip}?fields=country,countryCode,city,org`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json() as {
      country?: string;
      countryCode?: string;
      city?: string;
      org?: string;
    };

    const geo: GeoData = {
      country: data.country || "",
      countryCode: data.countryCode || "",
      city: data.city || "",
      org: data.org || "",
      cachedAt: Date.now(),
    };

    geoCache.set(ip, geo);
    return geo;
  } catch {
    // Timeout or network error — fire and forget
    return null;
  }
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Parse client type from User-Agent string.
 * Detects: claude-code, cursor, windsurf, copilot, python, node, browser, unknown
 */
export function parseClient(ua: string): string {
  if (!ua) return "unknown";
  const lower = ua.toLowerCase();
  if (lower.includes("claude")) return "claude-code";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("windsurf")) return "windsurf";
  if (lower.includes("copilot")) return "copilot";
  if (lower.includes("python")) return "python";
  if (lower.includes("node")) return "node";
  // Standard browser UA signatures
  if (
    lower.includes("mozilla") ||
    lower.includes("webkit") ||
    lower.includes("gecko")
  ) {
    return "browser";
  }
  return "unknown";
}

/**
 * Hash an IP address to a short, irreversible token.
 * ip_hash = first 8 hex chars of sha256(ip) — not reversible, but trackable.
 */
export function hashIp(ip: string): string {
  return createHash("sha256")
    .update(ip || "unknown")
    .digest("hex")
    .slice(0, 8);
}

/**
 * Rotate the log file if > 50MB.
 * Renames to request-log.YYYY-MM-DD.jsonl and starts fresh.
 */
function maybeRotate(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const stat = statSync(LOG_FILE);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      const dateStr = new Date().toISOString().slice(0, 10);
      const rotated = LOG_FILE.replace(".jsonl", `.${dateStr}.jsonl`);
      renameSync(LOG_FILE, rotated);
      console.log(`[request-log] Rotated log → ${rotated}`);
    }
  } catch (err) {
    console.warn(
      "[request-log] Rotation check failed:",
      err instanceof Error ? err.message : err
    );
  }
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ─── Write path ───────────────────────────────────────────────────────────────

/**
 * Build a RequestLogEntry from request/response fields.
 * Performs async geo lookup (with 500ms timeout, cached 1h) before hashing the IP.
 */
export async function buildLogEntry(opts: {
  endpoint: string;
  ua: string;
  ip: string;
  statusCode: number;
  ms: number;
  url?: string;
  sessionId?: string;
  mcpTool?: string;
  mcpClientName?: string;
  contextValue?: string;
  wordCount?: number;
  topKeywords?: string[];
}): Promise<RequestLogEntry> {
  let status: RequestStatus;
  if (opts.statusCode === 402) {
    status = "payment";
  } else if (opts.statusCode === 429) {
    status = "ratelimited";
  } else if (opts.statusCode >= 200 && opts.statusCode < 300) {
    status = "success";
  } else {
    status = "failed";
  }

  // Geo lookup BEFORE hashing the IP
  const geo = await lookupGeo(opts.ip);

  // Use MCP clientInfo.name if provided, else parse from UA
  const clientName = opts.mcpClientName || parseClient(opts.ua || "");

  const entry: RequestLogEntry = {
    ts: new Date().toISOString(),
    endpoint: opts.endpoint,
    ua: (opts.ua || "").slice(0, 200), // cap length
    client: clientName,
    ip_hash: hashIp(opts.ip),
    status,
    ms: Math.round(opts.ms),
  };

  // Add geo data if available
  if (geo) {
    if (geo.country) entry.country = geo.country;
    if (geo.countryCode) entry.countryCode = geo.countryCode;
    if (geo.city) entry.city = geo.city;
    if (geo.org) entry.org = geo.org;
  }

  // Log MCP tool name if provided
  if (opts.mcpTool) {
    entry.mcpTool = opts.mcpTool;
  }

  // Only log URL for relevant endpoints
  if (opts.url && LOG_URL_ENDPOINTS.has(opts.endpoint)) {
    entry.url = opts.url.slice(0, 500);
  }

  if (opts.sessionId) {
    entry.sessionId = opts.sessionId.slice(0, 12);
  }

  if (opts.mcpClientName) {
    entry.mcpClientName = opts.mcpClientName;
  }

  if (opts.contextValue) {
    entry.contextValue = opts.contextValue.slice(0, 500);
  }

  if (opts.wordCount !== undefined) {
    entry.wordCount = opts.wordCount;
  }

  if (opts.topKeywords && opts.topKeywords.length > 0) {
    entry.topKeywords = opts.topKeywords;
  }

  return entry;
}

/**
 * Write one log entry to SQLite (primary) and JSONL (backup).
 * Best-effort — never throws, never breaks request pipeline.
 * Silently skips entries that are excluded from stats (bots, owner IP, health checks).
 */
export function logRequest(entry: RequestLogEntry, skipExclusionCheck = false): void {
  // Drop bot/internal traffic — do not write to SQLite or JSONL
  // Pass client name so MCP registry bots (mcpdd, Glama, Smithery, etc.) are caught
  if (!skipExclusionCheck && shouldExcludeFromStats(entry.ip_hash, entry.ua, entry.endpoint, entry.client)) {
    return;
  }
  // ── Primary: SQLite ───────────────────────────────────────────────
  try {
    const targetDomain = entry.url ? extractDomain(entry.url) : null;
    const targetCategory = targetDomain ? classifyDomain(targetDomain) : null;
    const isAgent = entry.client !== 'browser' ? 1 : 0;

    insertRequest.run({
      ts: new Date(entry.ts).getTime(),
      endpoint: entry.endpoint,
      client: entry.client || null,
      ua: entry.ua || null,
      ip_hash: entry.ip_hash || null,
      country: entry.country || null,
      country_code: entry.countryCode || null,
      city: entry.city || null,
      org: entry.org || null,
      target_url: entry.url || null,
      target_domain: targetDomain || null,
      target_category: targetCategory || null,
      status: entry.status,
      response_ms: entry.ms,
      response_bytes: null,
      mcp_tool: entry.mcpTool || null,
      mcp_session: entry.sessionId || null,
      is_agent: isAgent,
      referrer: null,
      accept_language: null,
      context_value: entry.contextValue || null,
      word_count: entry.wordCount ?? null,
      top_keywords: entry.topKeywords ? JSON.stringify(entry.topKeywords) : null,
      mcp_client_name: entry.mcpClientName || null,
    });

    // Upsert session if we have a session ID
    if (entry.sessionId) {
      const tools = entry.mcpTool ? JSON.stringify([entry.mcpTool]) : '[]';
      upsertSession.run({
        id: entry.sessionId,
        now: new Date(entry.ts).getTime(),
        client: entry.client || null,
        country_code: entry.countryCode || null,
        tools_used: tools,
        unique_urls: 0, // will be updated by session finalization
        context_values: entry.contextValue ? JSON.stringify([entry.contextValue]) : null,
        client_version: null,
      });
    }

    // Upsert domain stats if we have a target URL
    if (targetDomain) {
      const successRate = entry.status === 'success' ? 1.0 : 0.0;
      upsertDomain.run({
        domain: targetDomain,
        category: targetCategory,
        now: new Date(entry.ts).getTime(),
        success_rate: successRate,
        response_ms: entry.ms,
      });
    }
  } catch (err) {
    console.warn(
      "[request-log] SQLite write failed:",
      err instanceof Error ? err.message : err
    );
  }

  // ── Backup: JSONL ─────────────────────────────────────────────────
  try {
    ensureDataDir();
    maybeRotate();
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.warn(
      "[request-log] JSONL backup write failed:",
      err instanceof Error ? err.message : err
    );
  }
}

// ─── Read / analytics path ────────────────────────────────────────────────────

interface LogLine {
  ts: string;
  endpoint: string;
  ua: string;
  client: string;
  ip_hash: string;
  country?: string;
  countryCode?: string;
  city?: string;
  org?: string;
  mcpTool?: string;
  url?: string;
  status: string;
  ms: number;
  sessionId?: string;
}

/**
 * Read and parse JSONL log file, returning entries since `sinceMs` epoch.
 */
export function readLogSince(sinceMs: number): LogLine[] {
  if (!existsSync(LOG_FILE)) return [];
  try {
    const content = readFileSync(LOG_FILE, "utf-8");
    const result: LogLine[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry: LogLine = JSON.parse(line);
        if (new Date(entry.ts).getTime() >= sinceMs) {
          result.push(entry);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return result;
  } catch (err) {
    console.warn(
      "[request-log] Read failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * Get clean request count from SQLite (excludes bots/health/internal).
 * Returns { clean, total, filteredOut } for the last N days.
 */
export function getCleanRequestCount(days = 7): { clean: number; total: number; filteredOut: number } {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const total = (db.prepare('SELECT COUNT(*) as cnt FROM requests WHERE ts >= ?').get(since) as any).cnt as number;
    const clean = (db.prepare(`SELECT COUNT(*) as cnt FROM requests WHERE ts >= ? ${BOT_FILTER_SQL}`).get(since) as any).cnt as number;
    return { clean, total, filteredOut: total - clean };
  } catch {
    return { clean: 0, total: 0, filteredOut: 0 };
  }
}

/**
 * Get client breakdown from last N days.
 * Returns { "claude-code": 800, "cursor": 300, ... }
 */
export function getClientBreakdown(days: number): Record<string, number> {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = readLogSince(since);
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const c = e.client || "unknown";
    counts[c] = (counts[c] || 0) + 1;
  }
  return counts;
}

// ─── Insights ─────────────────────────────────────────────────────────────────

export interface InsightsData {
  period: string;
  totalRequests: number;
  filteredOut: number;
  note: string;
  byClient: Record<string, number>;
  byEndpoint: Record<string, number>;
  topUrls: Array<{ url: string; count: number }>;
  uniqueIpHashes: number;
  peakHour: string;
  newClientsToday: number;
  uniqueSessions: number;
  topCountries: Record<string, number>;
  topCities: Record<string, number>;
  topOrgs: Record<string, number>;
  mcpTools: Record<string, number>;
}

/**
 * Compute insights from the last 7 days — queries SQLite for speed.
 * Falls back to JSONL if SQLite has no data yet.
 */
export function computeInsights(): InsightsData {
  const now = Date.now();
  const since7d = now - 7 * 24 * 60 * 60 * 1000;
  const since1d = now - 24 * 60 * 60 * 1000;

  try {
    // Check if SQLite has data
    const rowCount = (db.prepare('SELECT COUNT(*) as cnt FROM requests WHERE ts >= ?').get(since7d) as any).cnt as number;

    if (rowCount > 0) {
      return computeInsightsFromSQLite(since7d, since1d, now);
    }
  } catch (err) {
    console.warn('[request-log] SQLite insights query failed, falling back to JSONL:', err instanceof Error ? err.message : err);
  }

  // Fallback: JSONL
  return computeInsightsFromJSONL(since7d, since1d);
}

/**
 * Fast insights via SQLite queries.
 * All counts exclude bot/internal traffic via BOT_FILTER_SQL.
 */
function computeInsightsFromSQLite(since7d: number, since1d: number, now: number): InsightsData {
  // Total (raw) vs filtered counts — to compute filteredOut
  const rawTotal = (db.prepare(`SELECT COUNT(*) as cnt FROM requests WHERE ts >= ?`).get(since7d) as any).cnt as number;
  const cleanTotal = (db.prepare(`SELECT COUNT(*) as cnt FROM requests WHERE ts >= ? ${BOT_FILTER_SQL}`).get(since7d) as any).cnt as number;
  const filteredOut = rawTotal - cleanTotal;

  // By client (filtered)
  const clientRows = db.prepare(
    `SELECT client, COUNT(*) as cnt FROM requests WHERE ts >= ? ${BOT_FILTER_SQL} GROUP BY client ORDER BY cnt DESC`
  ).all(since7d) as Array<{ client: string; cnt: number }>;
  const byClient: Record<string, number> = {};
  for (const r of clientRows) byClient[r.client || 'unknown'] = r.cnt;

  // By endpoint (filtered)
  const endpointRows = db.prepare(
    `SELECT endpoint, COUNT(*) as cnt FROM requests WHERE ts >= ? ${BOT_FILTER_SQL} GROUP BY endpoint ORDER BY cnt DESC`
  ).all(since7d) as Array<{ endpoint: string; cnt: number }>;
  const byEndpoint: Record<string, number> = {};
  for (const r of endpointRows) byEndpoint[r.endpoint] = r.cnt;

  // Top URLs (filtered)
  const urlRows = db.prepare(
    `SELECT target_url as url, COUNT(*) as cnt FROM requests WHERE ts >= ? AND target_url IS NOT NULL ${BOT_FILTER_SQL} GROUP BY target_url ORDER BY cnt DESC LIMIT 10`
  ).all(since7d) as Array<{ url: string; cnt: number }>;
  const topUrls = urlRows.map(r => ({ url: r.url, count: r.cnt }));

  // Unique IP hashes (filtered)
  const uniqueIps = (db.prepare(
    `SELECT COUNT(DISTINCT ip_hash) as cnt FROM requests WHERE ts >= ? ${BOT_FILTER_SQL}`
  ).get(since7d) as any).cnt as number;

  // Peak hour (filtered)
  const peakHourRow = db.prepare(
    `SELECT strftime('%H', ts/1000, 'unixepoch') as hour, COUNT(*) as cnt
     FROM requests WHERE ts >= ? ${BOT_FILTER_SQL}
     GROUP BY hour ORDER BY cnt DESC LIMIT 1`
  ).get(since7d) as { hour: string; cnt: number } | undefined;
  const peakHour = peakHourRow ? peakHourRow.hour : '00';

  // Unique sessions (filtered)
  const uniqueSessions = (db.prepare(
    `SELECT COUNT(DISTINCT mcp_session) as cnt FROM requests WHERE ts >= ? AND mcp_session IS NOT NULL ${BOT_FILTER_SQL}`
  ).get(since7d) as any).cnt as number;

  // New clients today (filtered)
  const clientsToday = new Set(
    (db.prepare(`SELECT DISTINCT client FROM requests WHERE ts >= ? ${BOT_FILTER_SQL}`).all(since1d) as Array<{ client: string }>).map(r => r.client)
  );
  const clientsBefore1d = new Set(
    (db.prepare(`SELECT DISTINCT client FROM requests WHERE ts >= ? AND ts < ? ${BOT_FILTER_SQL}`).all(since7d, since1d) as Array<{ client: string }>).map(r => r.client)
  );
  const newClientsToday = [...clientsToday].filter(c => !clientsBefore1d.has(c)).length;

  // Top countries (filtered)
  const countryRows = db.prepare(
    `SELECT country_code as k, COUNT(*) as cnt FROM requests WHERE ts >= ? AND country_code IS NOT NULL ${BOT_FILTER_SQL} GROUP BY country_code ORDER BY cnt DESC LIMIT 20`
  ).all(since7d) as Array<{ k: string; cnt: number }>;
  const topCountries: Record<string, number> = {};
  for (const r of countryRows) topCountries[r.k] = r.cnt;

  // Top cities (filtered)
  const cityRows = db.prepare(
    `SELECT city as k, COUNT(*) as cnt FROM requests WHERE ts >= ? AND city IS NOT NULL ${BOT_FILTER_SQL} GROUP BY city ORDER BY cnt DESC LIMIT 20`
  ).all(since7d) as Array<{ k: string; cnt: number }>;
  const topCities: Record<string, number> = {};
  for (const r of cityRows) topCities[r.k] = r.cnt;

  // Top orgs (filtered)
  const orgRows = db.prepare(
    `SELECT org as k, COUNT(*) as cnt FROM requests WHERE ts >= ? AND org IS NOT NULL ${BOT_FILTER_SQL} GROUP BY org ORDER BY cnt DESC LIMIT 20`
  ).all(since7d) as Array<{ k: string; cnt: number }>;
  const topOrgs: Record<string, number> = {};
  for (const r of orgRows) topOrgs[r.k] = r.cnt;

  // MCP tools (filtered)
  const toolRows = db.prepare(
    `SELECT mcp_tool as k, COUNT(*) as cnt FROM requests WHERE ts >= ? AND mcp_tool IS NOT NULL ${BOT_FILTER_SQL} GROUP BY mcp_tool ORDER BY cnt DESC`
  ).all(since7d) as Array<{ k: string; cnt: number }>;
  const mcpTools: Record<string, number> = {};
  for (const r of toolRows) mcpTools[r.k] = r.cnt;

  return {
    period: 'last 7 days',
    totalRequests: cleanTotal,
    filteredOut,
    note: 'Excludes registry probers, health checks, WP scanners, and internal/owner traffic',
    byClient,
    byEndpoint,
    topUrls,
    uniqueIpHashes: uniqueIps,
    peakHour: `${peakHour}:00 UTC`,
    newClientsToday,
    uniqueSessions,
    topCountries,
    topCities,
    topOrgs,
    mcpTools,
  };
}

/**
 * Legacy JSONL-based insights (fallback when SQLite has no data).
 * Applies shouldExcludeFromStats filter to clean historical data.
 */
function computeInsightsFromJSONL(since7d: number, since1d: number): InsightsData {
  const rawEntries = readLogSince(since7d);
  const rawTotal = rawEntries.length;
  const entries = rawEntries.filter(e => !shouldExcludeFromStats(e.ip_hash || '', e.ua || '', e.endpoint || '', e.client || ''));
  const filteredOut = rawTotal - entries.length;

  const byClient: Record<string, number> = {};
  const byEndpoint: Record<string, number> = {};
  const urlCounts: Record<string, number> = {};
  const ipHashSet = new Set<string>();
  const hourCounts: Record<string, number> = {};
  const sessionSet = new Set<string>();
  const clientsBefore1d = new Set<string>();
  const countryCounts: Record<string, number> = {};
  const cityCounts: Record<string, number> = {};
  const orgCounts: Record<string, number> = {};
  const mcpToolCounts: Record<string, number> = {};

  for (const e of entries) {
    const tsMs = new Date(e.ts).getTime();

    byClient[e.client] = (byClient[e.client] || 0) + 1;
    byEndpoint[e.endpoint] = (byEndpoint[e.endpoint] || 0) + 1;

    if (e.url) {
      urlCounts[e.url] = (urlCounts[e.url] || 0) + 1;
    }

    if (e.ip_hash) {
      ipHashSet.add(e.ip_hash);
    }

    const hour = e.ts.slice(11, 13);
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;

    if (e.sessionId) {
      sessionSet.add(e.sessionId);
    }

    if (tsMs < since1d) {
      clientsBefore1d.add(e.client);
    }

    if (e.countryCode) {
      countryCounts[e.countryCode] = (countryCounts[e.countryCode] || 0) + 1;
    }
    if (e.city) {
      cityCounts[e.city] = (cityCounts[e.city] || 0) + 1;
    }
    if (e.org) {
      orgCounts[e.org] = (orgCounts[e.org] || 0) + 1;
    }
    if (e.mcpTool) {
      mcpToolCounts[e.mcpTool] = (mcpToolCounts[e.mcpTool] || 0) + 1;
    }
  }

  let peakHour = "00";
  let peakCount = 0;
  for (const [hour, count] of Object.entries(hourCounts)) {
    if (count > peakCount) {
      peakCount = count;
      peakHour = hour;
    }
  }

  const topUrls = Object.entries(urlCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([url, count]) => ({ url, count }));

  const clientsToday = new Set(
    entries.filter(e => new Date(e.ts).getTime() >= since1d).map(e => e.client)
  );
  const newClientsToday = [...clientsToday].filter(c => !clientsBefore1d.has(c)).length;

  function sortedTop(counts: Record<string, number>, limit = 20): Record<string, number> {
    return Object.fromEntries(
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
    );
  }

  return {
    period: "last 7 days",
    totalRequests: entries.length,
    filteredOut,
    note: 'Excludes registry probers, health checks, WP scanners, and internal/owner traffic',
    byClient,
    byEndpoint,
    topUrls,
    uniqueIpHashes: ipHashSet.size,
    peakHour: `${peakHour}:00 UTC`,
    newClientsToday,
    uniqueSessions: sessionSet.size,
    topCountries: sortedTop(countryCounts),
    topCities: sortedTop(cityCounts),
    topOrgs: sortedTop(orgCounts),
    mcpTools: sortedTop(mcpToolCounts),
  };
}
