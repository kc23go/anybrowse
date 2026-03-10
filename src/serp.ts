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
  query?: string; // alias for q
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
 * Simplify a query for retry: remove quotes, special characters, trim excess whitespace.
 */
function simplifyQuery(query: string): string {
  return query
    .replace(/["']/g, '')
    .replace(/[+\-*/&|~^(){}[\]]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Try DuckDuckGo Instant Answers API as a lightweight search fallback.
 * Returns results if the response contains topics, otherwise empty array.
 */
async function duckduckgoInstantAnswers(query: string, count: number): Promise<SerpResult[]> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      AbstractURL?: string;
      AbstractText?: string;
      Heading?: string;
      RelatedTopics?: Array<{ FirstURL?: string; Text?: string; Name?: string }>;
      Results?: Array<{ FirstURL?: string; Text?: string }>;
    };
    const results: SerpResult[] = [];

    // Primary abstract result
    if (data.AbstractURL && data.AbstractText) {
      results.push({
        url: data.AbstractURL,
        title: data.Heading || query,
        description: data.AbstractText,
      });
    }

    // Direct results
    for (const r of data.Results || []) {
      if (r.FirstURL && results.length < count) {
        results.push({ url: r.FirstURL, title: r.Text || '', description: '' });
      }
    }

    // Related topics
    for (const t of data.RelatedTopics || []) {
      if (t.FirstURL && results.length < count) {
        results.push({ url: t.FirstURL, title: t.Name || t.Text || '', description: t.Text || '' });
      }
    }

    if (DEBUG_LOG) console.log(`[serp] DDG instant answers returned ${results.length} results for: ${query}`);
    return results;
  } catch (err) {
    if (DEBUG_LOG) console.warn('[serp] DDG instant answers failed:', err);
    return [];
  }
}

/**
 * Search using SearXNG self-hosted instance (localhost:8888).
 * Returns results in SerpResult format.
 */
async function searchWithSearxng(query: string, count: number): Promise<SerpResult[]> {
  const url = `http://localhost:8888/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=0`;
  if (DEBUG_LOG) console.log(`[serp] SearXNG query: ${query}`);

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`SearXNG error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as { results?: Array<{ url: string; title: string; content?: string; engine?: string }> };
  const results = (data.results || []).slice(0, count);

  return results.map((r) => ({
    url: r.url || '',
    title: r.title || '',
    description: r.content || '',
  }));
}

/**
 * Search using Brave Search API.
 */
async function searchWithBrave(query: string, count: number, braveKey: string): Promise<SerpResult[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count || 10}`,
    {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': braveKey,
      },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!res.ok) throw new Error(`Brave Search API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { web?: { results?: Array<{ url: string; title: string; description: string }> } };
  return (data.web?.results || []).map((r) => ({
    url: r.url,
    title: r.title,
    description: r.description,
  }));
}

/**
 * Perform a search query.
 * Priority: SearXNG (self-hosted) → Brave Search API → DuckDuckGo Instant Answers → browser-based scraping.
 */
export async function runSerpQuery(query: string, count = 5): Promise<SerpResult[]> {
  const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY;

  // ── SearXNG first (self-hosted, free, no rate limits) ──────────────────
  try {
    const searxngResults = await searchWithSearxng(query, count);
    if (searxngResults.length > 0) {
      if (DEBUG_LOG) console.log(`[serp] SearXNG returned ${searxngResults.length} results`);
      return searxngResults;
    }
    console.warn('[serp] SearXNG returned 0 results, falling back');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[serp] SearXNG failed: ${msg}, falling back to Brave`);
  }

  if (BRAVE_KEY) {
    if (DEBUG_LOG) console.log(`[serp] Using Brave Search API for: ${query}`);
    let braveResults: SerpResult[] = [];
    let braveError: Error | null = null;

    try {
      braveResults = await searchWithBrave(query, count, BRAVE_KEY);
    } catch (err) {
      braveError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[serp] Brave Search failed: ${braveError.message}`);
    }

    // If Brave returned results, return them
    if (braveResults.length > 0) return braveResults;

    // Retry with simplified query if Brave returned 0 results (not an error)
    if (!braveError) {
      const simplified = simplifyQuery(query);
      if (simplified !== query) {
        console.log(`[serp] Brave returned 0 results, retrying with simplified query: "${simplified}"`);
        try {
          const retryResults = await searchWithBrave(simplified, count, BRAVE_KEY);
          if (retryResults.length > 0) return retryResults;
        } catch { /* fall through to DDG */ }
      }
    }

    // Fallback to DuckDuckGo instant answers if Brave fails or returns nothing
    console.log(`[serp] Falling back to DuckDuckGo instant answers for: ${query}`);
    const ddgResults = await duckduckgoInstantAnswers(query, count);
    if (ddgResults.length > 0) return ddgResults;

    // If everything failed, throw original Brave error (or empty)
    if (braveError) throw braveError;
    return [];
  }

  // ── Browser-based fallback ──────────────────────────────────────────────
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
    const query = (body?.q ?? body?.query ?? '').toString().trim();
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

  /**
   * POST /serp — alias for /serp/search (accepts q or query param)
   */
  app.post('/serp', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as SerpRequestBody;
    const query = (body?.q ?? body?.query ?? '').toString().trim();
    const count = Math.max(1, Math.min(20, Number(body?.count ?? 5)));

    if (!query) {
      return reply.status(400).send({ error: 'q_required' });
    }

    try {
      const results = await runSerpQuery(query, count);
      return reply.send({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'serp_failed', message });
    }
  });

  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  console.log(`[serp] Search registered — SearXNG (primary) → ${braveKey ? 'Brave API' : 'browser-based'} (fallback)`);
}
