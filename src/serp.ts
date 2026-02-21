import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Browser, Page } from 'playwright-core';
import { acquireSession, releaseSession } from './pool.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

interface SerpResult {
  url?: string;
  title?: string;
  description?: string;
}

interface SerpRequestBody {
  q?: string;
  count?: number;
}

/**
 * Extract search results from a Google SERP page
 */
async function extractGoogleResults(page: Page, count: number): Promise<SerpResult[]> {
  return page.evaluate((maxCount: number) => {
    const results: Array<{ url: string; title: string; description: string }> = [];
    // Google organic result containers
    const containers = document.querySelectorAll('#search .g, #rso .g, #rso > div > div.g');

    for (const container of containers) {
      if (results.length >= maxCount) break;

      const anchor = container.querySelector('a[href^="http"]');
      const heading = container.querySelector('h3');
      // Google uses various classes for snippets
      const snippet =
        container.querySelector('[data-sncf]') ||
        container.querySelector('.VwiC3b') ||
        container.querySelector('.st') ||
        container.querySelector('[data-content-feature="1"]');

      if (anchor && heading) {
        const href = anchor.getAttribute('href') || '';
        // Skip Google's own links
        if (href.startsWith('http') && !href.includes('google.com/search')) {
          results.push({
            url: href,
            title: heading.textContent?.trim() || '',
            description: snippet?.textContent?.trim() || '',
          });
        }
      }
    }

    return results;
  }, count);
}

/**
 * Extract search results from a DuckDuckGo HTML page (fallback)
 */
async function extractDdgResults(page: Page, count: number): Promise<SerpResult[]> {
  const raw = await page.evaluate((maxCount: number) => {
    const results: Array<{ url: string; title: string; description: string }> = [];
    const items = document.querySelectorAll('.result, .web-result');

    for (const item of items) {
      if (results.length >= maxCount) break;

      const anchor = item.querySelector('.result__a, .result-title a');
      const snippet = item.querySelector('.result__snippet, .result-snippet');

      if (anchor) {
        const href = anchor.getAttribute('href') || '';
        results.push({
          url: href,
          title: anchor.textContent?.trim() || '',
          description: snippet?.textContent?.trim() || '',
        });
      }
    }

    return results;
  }, count);

  // Post-process: unwrap DuckDuckGo redirect URLs in Node.js context
  return raw.map((r) => {
    let url = r.url || '';
    if (url.startsWith('//')) url = 'https:' + url;
    if (url.includes('duckduckgo.com/l/?uddg=')) {
      try {
        const parsed = new URL(url);
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) url = uddg;
      } catch { /* keep original */ }
    }
    return { ...r, url };
  }).filter((r) => r.url.startsWith('http'));
}

/**
 * Perform a search query using a real browser via the pool.
 * Tries Google first, falls back to DuckDuckGo HTML if Google fails.
 */
export async function runSerpQuery(query: string, count = 5): Promise<SerpResult[]> {
  const session = await acquireSession();
  let hadError = false;

  try {
    const browser = session.browser as Browser;
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    try {
      // Try Google first
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${Math.min(count + 5, 20)}&hl=en`;
      if (DEBUG_LOG) console.log(`[serp] Searching Google: ${query}`);

      await page.goto(googleUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Wait briefly for results to render
      await page.waitForSelector('#search, #rso', { timeout: 5000 }).catch(() => {});

      const googleResults = await extractGoogleResults(page, count);

      if (googleResults.length > 0) {
        if (DEBUG_LOG) console.log(`[serp] Google returned ${googleResults.length} results`);
        return googleResults;
      }

      // Fallback to DuckDuckGo HTML search
      if (DEBUG_LOG) console.log('[serp] Google returned no results, falling back to DuckDuckGo');
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      await page.goto(ddgUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

      const ddgResults = await extractDdgResults(page, count);
      if (DEBUG_LOG) console.log(`[serp] DuckDuckGo returned ${ddgResults.length} results`);
      return ddgResults;
    } finally {
      await context.close().catch(() => {});
    }
  } catch (err) {
    hadError = true;
    if (DEBUG_LOG) console.error('[serp] Search error:', err);
    throw err;
  } finally {
    releaseSession(session, hadError);
  }
}

/**
 * Register SERP routes
 */
export async function registerSerpRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /serp/search
   * Search using real Chrome browser and return structured results
   */
  app.post('/serp/search', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as SerpRequestBody;
    const query = (body?.q ?? '').toString().trim();
    const count = Math.max(1, Math.min(20, Number(body?.count ?? 5)));

    if (!query) {
      return reply.status(400).send({ error: 'q_required' });
    }

    try {
      const results = await runSerpQuery(query, count);
      return reply.send({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (DEBUG_LOG) {
        console.error('[serp] error:', err);
      }

      return reply.status(500).send({
        error: 'serp_failed',
        message,
      });
    }
  });

  console.log('[serp] Browser-based search registered (Google + DuckDuckGo fallback)');
}
