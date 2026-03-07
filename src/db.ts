/**
 * db.ts — SQLite database for anybrowse request analytics
 *
 * Replaces flat JSONL logs with a structured, queryable database.
 * Schema: requests, sessions, domains
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';

const DB_PATH = '/agent/data/anybrowse.db';
mkdirSync('/agent/data', { recursive: true });

export const db = new Database(DB_PATH);

// Enable WAL mode for concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,           -- unix ms
    endpoint TEXT NOT NULL,
    client TEXT,                   -- claude-code, cursor, windsurf, browser, python, unknown
    ua TEXT,                       -- truncated user-agent
    ip_hash TEXT,                  -- 8-char sha256 prefix
    country TEXT,
    country_code TEXT,
    city TEXT,
    org TEXT,                      -- ISP/company
    target_url TEXT,               -- for /scrape and /crawl
    target_domain TEXT,            -- extracted domain
    target_category TEXT,          -- jobs, finance, news, ecommerce, social, docs, other
    status TEXT,                   -- success, failed, empty, blocked
    response_ms INTEGER,
    response_bytes INTEGER,
    mcp_tool TEXT,                 -- scrape, crawl, search (for MCP calls)
    mcp_session TEXT,              -- first 12 chars of session ID
    is_agent INTEGER DEFAULT 0,    -- 0 or 1
    referrer TEXT,                 -- for browser requests
    accept_language TEXT,          -- locale signal
    context_value TEXT,            -- optional intent context provided by agent
    word_count INTEGER,            -- word count of returned markdown
    top_keywords TEXT,             -- JSON array of top 3 keywords
    mcp_client_name TEXT           -- exact clientInfo.name from MCP initialize
  );

  CREATE INDEX IF NOT EXISTS idx_ts ON requests(ts);
  CREATE INDEX IF NOT EXISTS idx_endpoint ON requests(endpoint);
  CREATE INDEX IF NOT EXISTS idx_client ON requests(client);
  CREATE INDEX IF NOT EXISTS idx_country ON requests(country_code);
  CREATE INDEX IF NOT EXISTS idx_target_domain ON requests(target_domain);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,           -- mcp_session ID
    first_seen INTEGER,
    last_seen INTEGER,
    call_count INTEGER DEFAULT 0,
    client TEXT,
    country_code TEXT,
    tools_used TEXT,               -- JSON array of tools used
    duration_ms INTEGER,           -- session duration (last_seen - first_seen)
    unique_urls INTEGER DEFAULT 0, -- distinct URLs scraped in session
    context_values TEXT,           -- JSON array of context strings provided
    client_version TEXT            -- clientInfo.version from MCP initialize
  );

  CREATE TABLE IF NOT EXISTS domains (
    domain TEXT PRIMARY KEY,
    category TEXT,                 -- classified industry vertical
    first_scraped INTEGER,
    last_scraped INTEGER,
    total_scrapes INTEGER DEFAULT 0,
    success_rate REAL,
    avg_response_ms REAL,
    has_screenshot INTEGER DEFAULT 0
  );
`);

// Migrate existing tables: add new columns if they don't exist yet
// SQLite doesn't support IF NOT EXISTS for columns, so we try/catch each
const migrations = [
  // requests new columns
  `ALTER TABLE requests ADD COLUMN context_value TEXT`,
  `ALTER TABLE requests ADD COLUMN word_count INTEGER`,
  `ALTER TABLE requests ADD COLUMN top_keywords TEXT`,
  `ALTER TABLE requests ADD COLUMN mcp_client_name TEXT`,
  // sessions new columns
  `ALTER TABLE sessions ADD COLUMN duration_ms INTEGER`,
  `ALTER TABLE sessions ADD COLUMN unique_urls INTEGER DEFAULT 0`,
  `ALTER TABLE sessions ADD COLUMN context_values TEXT`,
  `ALTER TABLE sessions ADD COLUMN client_version TEXT`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

// ─── Domain category classifier ──────────────────────────────────────────────

const DOMAIN_CATEGORIES: Array<{ patterns: string[]; category: string }> = [
  {
    category: 'jobs',
    patterns: ['linkedin.com', 'indeed.com', 'youngcapital.nl', 'glassdoor.com', 'monster.com', 'ziprecruiter.com', 'lever.co', 'greenhouse.io', 'workday.com'],
  },
  {
    category: 'finance',
    patterns: ['bloomberg.com', 'reuters.com', 'wsj.com', 'ft.com', 'yahoo.com', 'marketwatch.com', 'seekingalpha.com', 'investing.com', 'coinbase.com', 'binance.com'],
  },
  {
    category: 'social',
    patterns: ['twitter.com', 'x.com', 'reddit.com', 'facebook.com', 'instagram.com', 'bilibili.com', 'tiktok.com', 'youtube.com', 'discord.com', 'telegram.org'],
  },
  {
    category: 'news',
    patterns: ['cnn.com', 'bbc.com', 'techcrunch.com', 'hackernews', 'theverge.com', 'nytimes.com', 'washingtonpost.com', 'wired.com', 'ycombinator.com', 'news.ycombinator.com'],
  },
  {
    category: 'docs',
    patterns: ['github.com', 'stackoverflow.com', 'docs.', 'developer.', 'npmjs.com', 'pypi.org', 'crates.io', 'pkg.go.dev', 'rubygems.org'],
  },
  {
    category: 'ecommerce',
    patterns: ['amazon.com', 'ebay.com', 'shopify.com', 'etsy.com', 'aliexpress.com', 'walmart.com', 'target.com'],
  },
  {
    category: 'ai',
    patterns: ['openai.com', 'anthropic.com', 'huggingface.co', 'cursor.com', 'windsurf.com', 'cohere.com', 'mistral.ai', 'replicate.com', 'together.ai'],
  },
];

/**
 * Classify a domain into an industry vertical.
 */
export function classifyDomain(domain: string): string {
  if (!domain) return 'other';
  const lower = domain.toLowerCase();
  for (const { patterns, category } of DOMAIN_CATEGORIES) {
    for (const pattern of patterns) {
      if (lower.includes(pattern)) return category;
    }
  }
  return 'other';
}

/**
 * Extract the domain from a URL string.
 */
export function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ─── Prepared statements ─────────────────────────────────────────────────────

export const insertRequest = db.prepare(`
  INSERT INTO requests (
    ts, endpoint, client, ua, ip_hash,
    country, country_code, city, org,
    target_url, target_domain, target_category,
    status, response_ms, response_bytes,
    mcp_tool, mcp_session, is_agent,
    referrer, accept_language,
    context_value, word_count, top_keywords, mcp_client_name
  ) VALUES (
    @ts, @endpoint, @client, @ua, @ip_hash,
    @country, @country_code, @city, @org,
    @target_url, @target_domain, @target_category,
    @status, @response_ms, @response_bytes,
    @mcp_tool, @mcp_session, @is_agent,
    @referrer, @accept_language,
    @context_value, @word_count, @top_keywords, @mcp_client_name
  )
`);

export const upsertSession = db.prepare(`
  INSERT INTO sessions (id, first_seen, last_seen, call_count, client, country_code, tools_used, unique_urls, context_values, client_version)
  VALUES (@id, @now, @now, 1, @client, @country_code, @tools_used, @unique_urls, @context_values, @client_version)
  ON CONFLICT(id) DO UPDATE SET
    last_seen = @now,
    call_count = call_count + 1,
    tools_used = @tools_used,
    unique_urls = @unique_urls,
    context_values = @context_values,
    duration_ms = @now - first_seen
`);

export const finalizeSession = db.prepare(`
  UPDATE sessions SET
    last_seen = @now,
    duration_ms = @now - first_seen,
    unique_urls = @unique_urls,
    context_values = @context_values,
    tools_used = @tools_used
  WHERE id = @id
`);

export const upsertDomain = db.prepare(`
  INSERT INTO domains (domain, category, first_scraped, last_scraped, total_scrapes, success_rate, avg_response_ms)
  VALUES (@domain, @category, @now, @now, 1, @success_rate, @response_ms)
  ON CONFLICT(domain) DO UPDATE SET
    last_scraped = @now,
    total_scrapes = total_scrapes + 1,
    success_rate = (success_rate * (total_scrapes - 1) + @success_rate) / total_scrapes,
    avg_response_ms = (avg_response_ms * (total_scrapes - 1) + @response_ms) / total_scrapes
`);

// Watches table for change monitoring
db.exec(`
  CREATE TABLE IF NOT EXISTS watches (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    webhook_url TEXT NOT NULL,
    interval_minutes INTEGER DEFAULT 60,
    ip_hash TEXT,
    created_at INTEGER,
    last_checked INTEGER,
    last_changed INTEGER,
    last_hash TEXT,
    check_count INTEGER DEFAULT 0,
    change_count INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS watch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    previous_hash TEXT,
    current_hash TEXT,
    markdown TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_watches_active ON watches(active);
  CREATE INDEX IF NOT EXISTS idx_watches_ip ON watches(ip_hash);
  CREATE INDEX IF NOT EXISTS idx_watch_history_watch ON watch_history(watch_id);
`);

console.log('[db] SQLite database ready at', DB_PATH);
