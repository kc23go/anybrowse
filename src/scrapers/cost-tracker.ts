/**
 * cost-tracker.ts — Usage logging for the /aggregate endpoint
 * Appends JSONL records to /home/openclaw/.openclaw/workspace/anybrowse/data/aggregate-usage.jsonl
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// Production path (VPS): /agent/data/  — matches the convention in scraper.ts
// Local dev: falls back silently if /agent/data/ doesn't exist
const USAGE_LOG = '/agent/data/aggregate-usage.jsonl';

export interface AggregateUsageLog {
  timestamp: string;
  clientKey?: string;
  query: string;
  zip: string;
  sources: string[];
  productsReturned: number;
  creditsConsumed: number;
  durationMs: number;
}

/**
 * Append a usage record to the JSONL log file.
 * Creates the data directory if it doesn't exist.
 * Never throws — logging failures are silently swallowed.
 */
export async function trackAggregateUsage(entry: AggregateUsageLog): Promise<void> {
  try {
    const dir = dirname(USAGE_LOG);
    if (!existsSync(dir)) return; // /agent/data doesn't exist outside VPS — skip silently
    appendFileSync(USAGE_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Non-fatal — never crash because of logging
  }
}
