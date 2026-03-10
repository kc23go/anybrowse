/**
 * camoufox-scraper.ts
 * 
 * Alternative scraper using camoufox (anti-detection Firefox via Python subprocess).
 * Best for sites that block Chromium-based scrapers: LinkedIn, Twitter/X, major news paywalls.
 * 
 * Requires: pip3 install camoufox[geoip]
 * The camoufox browser binary is downloaded on first use.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseHtmlToMarkdown } from './markdown.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the Python helper script (same directory as this file)
const PYTHON_SCRIPT = join(__dirname, 'camoufox_scrape.py');

// Domains that are best scraped with camoufox (Chromium-resistant sites)
const CAMOUFOX_DOMAINS = [
  'linkedin.com',
  'twitter.com',
  'x.com',
  'nytimes.com',
  'wsj.com',
  'ft.com',
  'bloomberg.com',
  'theatlantic.com',
  'wired.com',
  'medium.com',
  'substack.com',
];

/**
 * Check if a URL should use camoufox based on its domain
 */
export function shouldUseCamoufox(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return CAMOUFOX_DOMAINS.some((domain) => hostname === domain || hostname.endsWith('.' + domain));
  } catch {
    return false;
  }
}

export interface CamoufoxResult {
  url: string;
  title: string;
  markdown: string;
  status: 'success' | 'empty' | 'error';
  error?: string;
}

/**
 * Scrape a URL using camoufox (Python subprocess).
 * 
 * @param url - The URL to scrape
 * @param timeoutMs - Maximum time to wait (default 45s)
 */
export async function scrapeWithCamoufox(url: string, timeoutMs = 45_000): Promise<CamoufoxResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('python3', [PYTHON_SCRIPT, url], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      timeout: timeoutMs,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        console.warn(`[camoufox] Timeout after ${timeoutMs}ms for: ${url}`);
        resolve({ url, title: '', markdown: '', status: 'error', error: `Camoufox timeout after ${timeoutMs}ms` });
        return;
      }

      if (code !== 0) {
        const errMsg = stderr.slice(0, 500) || `Process exited with code ${code}`;
        console.warn(`[camoufox] Process failed (code=${code}) for: ${url}: ${errMsg}`);
        resolve({ url, title: '', markdown: '', status: 'error', error: errMsg });
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim()) as { title: string; html: string; error: string | null };

        if (parsed.error) {
          console.warn(`[camoufox] Scrape error for ${url}: ${parsed.error}`);
          resolve({ url, title: '', markdown: '', status: 'error', error: parsed.error });
          return;
        }

        if (!parsed.html) {
          resolve({ url, title: '', markdown: '', status: 'empty' });
          return;
        }

        const markdown = parseHtmlToMarkdown(parsed.html);
        const cleanedLen = markdown.replace(/\s+/g, ' ').trim().length;

        if (cleanedLen < 100) {
          resolve({ url, title: parsed.title, markdown: '', status: 'empty' });
          return;
        }

        console.log(`[camoufox] Success for ${url} (${cleanedLen} chars)`);
        resolve({ url, title: parsed.title, markdown, status: 'success' });
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        console.warn(`[camoufox] JSON parse error for ${url}: ${msg} | stdout: ${stdout.slice(0, 200)}`);
        resolve({ url, title: '', markdown: '', status: 'error', error: `JSON parse error: ${msg}` });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.warn(`[camoufox] Spawn error for ${url}: ${err.message}`);
      resolve({ url, title: '', markdown: '', status: 'error', error: err.message });
    });
  });
}
