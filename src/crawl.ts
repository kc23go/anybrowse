import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Browser } from 'playwright-core';
import { loadEnvNumber } from './env.js';
import { acquireSession, releaseSession, getPoolStats } from './pool.js';
import { CrawlResult, ScrapeOptions, scrapeUrlWithFallback, scrapeUrlTier0, isPdfUrl, isPdfSupportEnabled } from './scraper.js';
import { createPerfLogger } from './perf.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

function isAgentUserAgent(req: FastifyRequest): boolean {
  const ua = req.headers['user-agent'] || '';
  const referer = req.headers['referer'] || '';
  return (
    ua.includes('Claude') || ua.includes('Cursor') || ua.includes('Windsurf') ||
    ua.includes('python') || ua.includes('node-fetch') || ua.includes('axios') ||
    ua.includes('okhttp') || ua.includes('Go-http') ||
    (!referer && !ua.includes('Mozilla'))
  );
}

/** Maximum URLs to process per browser session */
const CRAWL_TABS_PER_SESSION = loadEnvNumber('CRAWL_TABS_PER_SESSION', 8);

/** Optional jitter to stagger parallel requests (ms) */
const CRAWL_JITTER_MS = loadEnvNumber('CRAWL_JITTER_MS', 0);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CrawlRequestBody {
  url?: string;
  maxPages?: number;
  sameDomain?: boolean; // default true — only follow links on the same domain
}

interface ScrapeRequestBody {
  url?: string;
  waitForSelector?: string;
  targetSelector?: string;
  respondWith?: 'markdown' | 'html' | 'text' | 'screenshot';
  actions?: Array<{ type: 'click' | 'type' | 'scroll' | 'wait'; selector?: string; value?: string; }>;
  screenshot?: boolean;    // capture base64 PNG screenshot (browser tiers only)
  includeLinks?: boolean;  // extract all hrefs from page (default: false)
  includeHtml?: boolean;   // include raw page HTML (default: true — always included)
}

export async function registerCrawlRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /crawl
   * Crawl a website: fetch a seed URL, discover same-domain links, scrape up to maxPages.
   * Returns an array of {url, title, markdown, success} objects.
   *
   * Body: { url: string, maxPages?: number (default 5), sameDomain?: boolean (default true) }
   */
  app.post('/crawl', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as CrawlRequestBody;
    const seedUrl = (body?.url ?? '').toString().trim();
    const maxPages = Math.max(1, Math.min(50, Number(body?.maxPages ?? 5)));
    const sameDomainOnly = body?.sameDomain !== false; // default true

    if (!seedUrl || !/^https?:\/\//i.test(seedUrl)) {
      return reply.status(400).send({
        error: 'url_required',
        hint: 'POST { "url": "https://example.com", "maxPages": 5 }',
      });
    }

    let seedDomain = '';
    try { seedDomain = new URL(seedUrl).hostname; } catch {
      return reply.status(400).send({ error: 'invalid_url' });
    }

    type PageResult = { url: string; title: string; markdown: string; success: boolean; error?: string };
    const results: PageResult[] = [];
    // Normalize seed URL for dedup (strip trailing slash, lowercase scheme+host)
    const normalizeCrawlUrl = (u: string): string => {
      try {
        const p = new URL(u);
        return p.origin.toLowerCase() + (p.pathname.replace(/\/$/, '') || '/') + (p.search || '');
      } catch { return u; }
    };
    const seenUrls = new Set<string>([normalizeCrawlUrl(seedUrl)]);

    // ── Helper: scrape one URL (tier0 → browser fallback) with hard cap ──────
    async function scrapeOne(url: string, skipTier0 = false): Promise<PageResult> {
      try {
        // Try tier0 first (fast plain HTTP) unless caller already tried it
        if (!skipTier0) {
          const t0 = await Promise.race<CrawlResult | null>([
            scrapeUrlTier0(url, { includeLinks: true }),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 7_000)),
          ]).catch(() => null);
          if (t0 && t0.status === 'success' && t0.markdown) {
            return { url, title: t0.title ?? '', markdown: t0.markdown, success: true, _links: t0.links } as PageResult & { _links?: string[] };
          }
        }
        // Browser fallback with hard timeout
        const session = await acquireSession();
        let hadError = false;
        try {
          const result = await Promise.race<CrawlResult>([
            scrapeUrlWithFallback(session.browser as Browser, url, isAgentUserAgent(req), { skipTier0: true, includeLinks: true }),
            new Promise<CrawlResult>((_, rej) => setTimeout(() => rej(new Error('page timeout')), 15_000)),
          ]);
          if (result.status === 'success' && result.markdown) {
            return { url, title: result.title ?? '', markdown: result.markdown, success: true, _links: (result as any).links } as PageResult & { _links?: string[] };
          }
          hadError = result.status === 'error';
          return { url, title: '', markdown: '', success: false, error: result.error || result.status };
        } catch (e: any) {
          hadError = true;
          return { url, title: '', markdown: '', success: false, error: e.message || 'timeout' };
        } finally {
          releaseSession(session, hadError);
        }
      } catch (e: any) {
        return { url, title: '', markdown: '', success: false, error: e.message || 'scrape_error' };
      }
    }

    // ── Step 1: Scrape seed URL and collect its links ─────────────────────────
    const seedResult = await scrapeOne(seedUrl) as PageResult & { _links?: string[] };
    results.push({ url: seedResult.url, title: seedResult.title, markdown: seedResult.markdown, success: seedResult.success, error: seedResult.error });

    if (!seedResult.success) {
      return reply.send({
        url: seedUrl,
        results,
        summary: { total: 1, success: 0, failed: 1, pagesScraped: 1 },
      });
    }

    // ── Step 2: Discover links from seed page ─────────────────────────────────
    const rawLinks: string[] = (seedResult as any)._links ?? [];
    const candidateUrls = rawLinks
      .filter(link => {
        try {
          const parsed = new URL(link);
          if (!sameDomainOnly) return true;
          if (parsed.hostname !== seedDomain) return false;
          // Skip obvious non-content resource paths
          const p = parsed.pathname.toLowerCase();
          if (p.match(/\.(css|js|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|pdf|xml|rss)$/)) return false;
          return true;
        } catch { return false; }
      })
      .filter(link => {
        // Dedup by normalized URL (preserve query strings; strip fragment + trailing slash)
        const key = normalizeCrawlUrl(link);
        if (seenUrls.has(key)) return false;
        seenUrls.add(key);
        return true;
      })
      .slice(0, maxPages - 1);

    if (DEBUG_LOG) {
      console.log(`[crawl] Seed ok, found ${rawLinks.length} links → ${candidateUrls.length} candidates (maxPages=${maxPages})`);
    }

    // ── Step 3: Scrape candidate pages in parallel (tier0 → browser) ─────────
    if (candidateUrls.length > 0) {
      const TIER0_TIMEOUT_MS = 6_000;
      const tier0Settled = await Promise.allSettled(
        candidateUrls.map(url =>
          Promise.race<CrawlResult | null>([
            scrapeUrlTier0(url, { includeLinks: false }),
            new Promise<null>(resolve => setTimeout(() => resolve(null), TIER0_TIMEOUT_MS)),
          ])
            .then(r => ({ url, result: r }))
            .catch(() => ({ url, result: null }))
        )
      );

      const browserQueue: string[] = [];
      for (const settled of tier0Settled) {
        if (settled.status !== 'fulfilled') continue;
        const { url, result } = settled.value;
        if (result && result.status === 'success' && result.markdown) {
          results.push({ url, title: result.title ?? '', markdown: result.markdown, success: true });
        } else {
          browserQueue.push(url);
        }
      }

      // Browser fallback for tier0 misses — in parallel with hard per-URL cap
      if (browserQueue.length > 0) {
        let session: Awaited<ReturnType<typeof acquireSession>> | null = null;
        let hadError = false;
        try {
          session = await acquireSession();
          const PER_URL_MS = 15_000;
          const browserResults = await Promise.allSettled(
            browserQueue.map(url =>
              Promise.race<CrawlResult>([
                scrapeUrlWithFallback(session!.browser as Browser, url, isAgentUserAgent(req), { skipTier0: true }),
                new Promise<CrawlResult>((_, rej) => setTimeout(() => rej(new Error('page timeout')), PER_URL_MS)),
              ])
            )
          );
          browserResults.forEach((r, i) => {
            const url = browserQueue[i];
            if (r.status === 'fulfilled' && r.value.status === 'success') {
              results.push({ url, title: r.value.title ?? '', markdown: r.value.markdown, success: true });
            } else {
              hadError = true;
              const errMsg = r.status === 'rejected' ? r.reason?.message : r.value.error;
              results.push({ url, title: '', markdown: '', success: false, error: errMsg || 'failed' });
            }
          });
        } catch (e: any) {
          hadError = true;
          browserQueue.forEach(url => {
            if (!results.find(r => r.url === url)) {
              results.push({ url, title: '', markdown: '', success: false, error: e.message || 'browser_unavailable' });
            }
          });
        } finally {
          if (session) releaseSession(session, hadError);
        }
      }
    }

    const successCount = results.filter(r => r.success).length;
    return reply.send({
      url: seedUrl,
      results,
      summary: {
        total: results.length,
        success: successCount,
        failed: results.length - successCount,
        pagesScraped: results.length,
      },
    });
  });

  /**
   * POST /scrape
   * Scrape a single URL to Markdown
   */
  app.post('/scrape', async (req: FastifyRequest, reply: FastifyReply) => {
    const perf = createPerfLogger();
    const body = req.body as ScrapeRequestBody;
    const url = (body?.url ?? '').toString().trim();

    perf.event('Scrape request', { url });

    if (!url || !/^https?:\/\//i.test(url)) {
      return reply.status(400).send({ error: 'valid_url_required' });
    }

    // Reject PDF URLs if DATALAB_API_KEY is not configured
    if (isPdfUrl(url) && !isPdfSupportEnabled()) {
      perf.event('PDF rejected - no API key');
      perf.summary();
      return reply.status(400).send({
        error: 'pdf_not_supported',
        message: 'PDF URLs require DATALAB_API_KEY to be configured',
      });
    }

    // Build options from request body
    const scrapeOpts: ScrapeOptions = {};
    if (body?.waitForSelector) scrapeOpts.waitForSelector = body.waitForSelector;
    if (body?.targetSelector) scrapeOpts.targetSelector = body.targetSelector;
    if (body?.respondWith) scrapeOpts.respondWith = body.respondWith;
    if (body?.actions) scrapeOpts.actions = body.actions;
    if (body?.screenshot) scrapeOpts.screenshot = true;
    if (body?.includeLinks) scrapeOpts.includeLinks = true;
    const hasOptions = Object.keys(scrapeOpts).length > 0;

    // ── Tier 0: try plain HTTP fetch BEFORE acquiring the browser pool ────────
    // This handles ~40% of static URLs with no browser overhead at all.
    // Skip if options require browser-specific features.
    const needsBrowser = !!(scrapeOpts.actions?.length || scrapeOpts.waitForSelector || scrapeOpts.respondWith === 'screenshot' || scrapeOpts.screenshot);
    if (!needsBrowser && !isPdfUrl(url)) {
      const tier0 = await scrapeUrlTier0(url, scrapeOpts);
      if (tier0) {
        perf.event('Tier0 HTTP success', { len: tier0.markdown.length });
        perf.summary();
        return reply.send({ ...tier0, success: tier0.status === 'success' });
      }
    }

    const session = await acquireSession();
    let hadError = false;

    try {
      perf.beginStep('Scrape URL');
      let result = await scrapeUrlWithFallback(session.browser as Browser, url, isAgentUserAgent(req), hasOptions ? scrapeOpts : undefined);

      // If result has very little content, retry with explicit slow scraper as final attempt
      const contentLen = result.markdown ? result.markdown.length : 0;
      if (contentLen < 200 && result.status !== 'error') {
        console.log(`[scrape] Content too short (${contentLen} chars), retrying with slow scraper: ${url}`);
        const retryResult = await scrapeUrlWithFallback(session.browser as Browser, url, isAgentUserAgent(req), hasOptions ? scrapeOpts : undefined);
        if (retryResult.markdown && retryResult.markdown.length > contentLen) {
          result = retryResult;
        }
      }

      perf.endStep('Scrape URL', { status: result.status, contentLen: result.markdown?.length ?? 0 });
      perf.summary();
      return reply.send({ ...result, success: result.status === 'success' });
    } catch (err) {
      hadError = true;
      const message = err instanceof Error ? err.message : String(err);
      perf.error('Scrape', message);
      perf.summary();

      if (DEBUG_LOG) {
        console.error('[scrape] error:', err);
      }

      return reply.status(500).send({
        error: 'scrape_failed',
        message,
      });
    } finally {
      releaseSession(session, hadError);
    }
  });

  /**
   * GET /r/:url
   * Shorthand scrape: GET /r/https://example.com → returns markdown as text/plain
   * Inspired by Jina Reader's /r/ shortcut for quick LLM context fetching.
   */
  app.get('/r/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawUrl = (req.params as any)['*'] as string;
    if (!rawUrl) {
      return reply.status(400).type('text/plain').send('Usage: GET /r/https://example.com');
    }
    const fullUrl = (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) ? rawUrl : 'https://' + rawUrl;
    if (!/^https?:\/\//i.test(fullUrl)) {
      return reply.status(400).type('text/plain').send('Invalid URL');
    }

    // Try tier 0 (plain HTTP) first — fast, no browser needed
    const tier0 = await scrapeUrlTier0(fullUrl);
    if (tier0) {
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      return reply.send(tier0.markdown);
    }

    // Escalate to browser tier
    const session = await acquireSession();
    let hadError = false;
    try {
      const result = await scrapeUrlWithFallback(session.browser as Browser, fullUrl, isAgentUserAgent(req));
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      return reply.send(result.markdown || result.error || 'No content');
    } catch (err) {
      hadError = true;
      const message = err instanceof Error ? err.message : String(err);
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      return reply.status(500).send(`Error: ${message}`);
    } finally {
      releaseSession(session, hadError);
    }
  });
}
