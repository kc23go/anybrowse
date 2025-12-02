import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Browser } from 'playwright-core';
import { loadEnvNumber } from './env.js';
import { runSerpQuery } from './serp.js';
import { getPool } from './pool.js';
import { CrawlResult, scrapeUrlWithFallback, isPdfUrl, isPdfSupportEnabled } from './scraper.js';
import { createPerfLogger } from './perf.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

/** Maximum URLs to process per browser session */
const CRAWL_TABS_PER_SESSION = loadEnvNumber('CRAWL_TABS_PER_SESSION', 8);

/** Optional jitter to stagger parallel requests (ms) */
const CRAWL_JITTER_MS = loadEnvNumber('CRAWL_JITTER_MS', 0);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CrawlRequestBody {
  q?: string;
  count?: number;
}

interface ScrapeRequestBody {
  url?: string;
}

export async function registerCrawlRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /crawl
   * Search Google and scrape top results to Markdown
   */
  app.post('/crawl', async (req: FastifyRequest, reply: FastifyReply) => {
    const perf = createPerfLogger();
    const body = req.body as CrawlRequestBody;
    const query = (body?.q ?? '').toString().trim();
    const count = Math.max(1, Math.min(20, Number(body?.count ?? 3)));

    perf.event('Request received', { query, count });

    if (!query) {
      return reply.status(400).send({ error: 'q_required' });
    }

    try {
      // 1. Get URLs from SERP service
      perf.beginStep('SERP query');
      const serpResults = await runSerpQuery(query, count);
      perf.endStep('SERP query', { resultsCount: serpResults.length });

      // Filter to valid HTTP URLs
      // PDFs are only included if DATALAB_API_KEY is configured
      const pdfSupport = isPdfSupportEnabled();
      const urls = serpResults
        .map((r) => r.url)
        .filter((url): url is string => typeof url === 'string' && url.startsWith('http'))
        .filter((url) => pdfSupport || !isPdfUrl(url));

      if (urls.length === 0) {
        perf.event('No URLs found from SERP');
        perf.summary();
        return reply.send({ query, results: [] });
      }

      perf.event('URLs to crawl', { count: urls.length, urls });

      // 2. Scrape URLs using browser pool
      if (DEBUG_LOG) {
        console.log(`[crawl] Scraping ${urls.length} URLs using pool (tabs/session=${CRAWL_TABS_PER_SESSION})`);
      }

      perf.beginStep('Scrape all URLs');

      const indexedQueue = urls.map((url, index) => ({ url, index }));
      const results: CrawlResult[] = new Array(urls.length);
      const pool = getPool();

      while (indexedQueue.length > 0) {
        const { maxSize } = pool.stats();
        const sessionsNeeded = Math.min(
          maxSize,
          Math.ceil(indexedQueue.length / Math.max(1, CRAWL_TABS_PER_SESSION))
        );

        if (sessionsNeeded <= 0) {
          if (DEBUG_LOG) {
            console.warn('[crawl] No sessions available; waiting...');
          }
          await delay(250);
          continue;
        }

        // Acquire sessions for this batch
        const sessions = await Promise.all(
          Array.from({ length: sessionsNeeded }, () => pool.acquire())
        );

        try {
          // Process URLs in parallel across sessions
          await Promise.all(
            sessions.map(async (session) => {
              const batch = indexedQueue.splice(0, Math.max(1, CRAWL_TABS_PER_SESSION));
              if (batch.length === 0) return;

              // Optional jitter to avoid thundering herd
              if (CRAWL_JITTER_MS > 0) {
                await delay(Math.floor(Math.random() * CRAWL_JITTER_MS));
              }

              const batchResults = await Promise.all(
                batch.map(({ url }) => scrapeUrlWithFallback(session.browser as Browser, url))
              );

              for (let i = 0; i < batch.length; i++) {
                results[batch[i].index] = batchResults[i];
              }
            })
          );
        } finally {
          // Release all sessions
          const hadErrors = results.some((r) => r?.status === 'error');
          for (const session of sessions) {
            pool.release(session, hadErrors);
          }
        }
      }

      // Summarize results
      const successCount = results.filter((r) => r?.status === 'success').length;
      const emptyCount = results.filter((r) => r?.status === 'empty').length;
      const errorCount = results.filter((r) => r?.status === 'error').length;

      perf.endStep('Scrape all URLs');
      perf.event('Crawl complete', { total: urls.length, success: successCount, empty: emptyCount, errors: errorCount });
      perf.summary();

      if (DEBUG_LOG) {
        console.log(`[crawl] Complete: ${successCount}/${urls.length} with content`);
      }

      return reply.send({ query, results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      perf.error('Crawl', message);
      perf.summary();

      if (DEBUG_LOG) {
        console.error('[crawl] error:', err);
      }

      return reply.status(500).send({
        error: 'crawl_failed',
        message,
      });
    }
  });

  /**
   * POST /scrape
   * Scrape a single URL to Markdown (for testing)
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

    const pool = getPool();
    const session = await pool.acquire();
    let hadError = false;

    try {
      perf.beginStep('Scrape URL');
      const result = await scrapeUrlWithFallback(session.browser as Browser, url);
      perf.endStep('Scrape URL', { status: result.status });
      perf.summary();
      return reply.send(result);
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
      pool.release(session, hadError);
    }
  });
}

