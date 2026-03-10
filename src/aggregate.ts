/**
 * aggregate.ts — POST /aggregate
 *
 * Scout's Buy Fast endpoint. Fan-out to all enabled sources in parallel,
 * merge results, return unified ScoutProduct array.
 *
 * Sources (final set):
 *   walmart  — mass-market, broad inventory, fast shipping
 *   ikea     — furniture / home-décor, strong in-store pickup
 *   wayfair  — home furnishings specialist
 *   target   — home décor + same-day pickup at US stores
 *   amazon   — largest catalog, warm-session enhanced
 *
 * POST /aggregate
 * Body: { query, zip, sources?, limit?, apiKey? }
 *
 * Response: { query, zip, sources: { walmart?, ikea?, wayfair?, target?, amazon? },
 *             products, totalCount, scrapedAt, costCredits }
 *
 * Architecture — lazy browser pool:
 *   All scrapers are SERP-first (Brave API + tier0 HTTP). They only call
 *   getBrowser() when tier0 HTTP fails. Most requests never touch the pool.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Browser } from 'playwright-core';
import { acquireSession, releaseSession } from './pool.js';
import { scrapeWalmart } from './scrapers/walmart.js';
import { scrapeIkea }    from './scrapers/ikea.js';
import { scrapeWayfair } from './scrapers/wayfair.js';
import { scrapeTarget }  from './scrapers/target.js';
import { scrapeAmazon }  from './scrapers/amazon.js';
import { trackAggregateUsage } from './scrapers/cost-tracker.js';
import type { ScoutProduct, SourceResult } from './scrapers/types.js';
import { fetchImageFromBrave, isRelevant } from './scrapers/types.js';
// isRelevant imported above with fetchImageFromBrave

export type { ScoutProduct, SourceResult };

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

/** Wall-clock budget for the entire /aggregate call. */
const AGGREGATE_TIMEOUT_MS = 45_000;

/** Per-source soft deadline — sources that miss it return an empty result */
const SOURCE_TIMEOUT_MS = 20_000;

/** Credits consumed per source. Amazon uses more (SERP + product page scrapes). */
const CREDITS: Record<string, number> = {
  walmart: 2,
  ikea:    2,
  wayfair: 2,
  target:  2,
  amazon:  8,
};

const VALID_SOURCES   = new Set(['walmart', 'ikea', 'wayfair', 'target', 'amazon']);
const DEFAULT_SOURCES = ['walmart', 'ikea', 'wayfair', 'target', 'amazon'];

// ── Request / Response types ──────────────────────────────────────────────────

interface AggregateRequestBody {
  query?: string;
  zip?: string;
  sources?: string[];
  limit?: number;
  apiKey?: string;
}

interface AggregateResponse {
  query: string;
  zip: string;
  sources: {
    walmart?: SourceResult;
    ikea?:    SourceResult;
    wayfair?: SourceResult;
    target?:  SourceResult;
    amazon?:  SourceResult;
  };
  products: ScoutProduct[];
  totalCount: number;
  scrapedAt: string;
  costCredits: number;
}

// ── Per-source soft timeout ───────────────────────────────────────────────────

function withSourceTimeout(
  promise: Promise<SourceResult>,
  sourceId: string,
  timeoutMs: number,
  scrapedAt: string,
): Promise<SourceResult> {
  const fallback: SourceResult = {
    products: [],
    success: false,
    error: `${sourceId} timed out after ${timeoutMs / 1000}s`,
    scrapedAt,
  };
  const timer = new Promise<SourceResult>((resolve) =>
    setTimeout(() => {
      console.warn(`[aggregate] ${sourceId} source timeout after ${timeoutMs}ms`);
      resolve(fallback);
    }, timeoutMs)
  );
  return Promise.race([
    promise.catch((err): SourceResult => ({
      products: [],
      success: false,
      error: err?.message ?? String(err),
      scrapedAt,
    })),
    timer,
  ]);
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerAggregateRoutes(app: FastifyInstance): Promise<void> {
  app.post('/aggregate', async (req: FastifyRequest, reply: FastifyReply) => {
    const startMs = Date.now();
    const body = req.body as AggregateRequestBody;

    // ── Validate ──────────────────────────────────────────────────────────
    const query = (body?.query ?? '').toString().trim();
    const zip   = (body?.zip   ?? '').toString().trim();

    if (!query) return reply.status(400).send({ error: 'query is required' });
    if (!zip)   return reply.status(400).send({ error: 'zip is required' });

    const rawSources = Array.isArray(body?.sources) ? body.sources : DEFAULT_SOURCES;
    const sources = [...new Set(rawSources.filter(s => VALID_SOURCES.has(s)))];
    if (sources.length === 0) {
      return reply.status(400).send({
        error: `sources must include at least one of: ${[...VALID_SOURCES].join(', ')}`,
      });
    }

    const limit  = Math.max(1, Math.min(50, Number(body?.limit ?? 10)));
    const apiKey = body?.apiKey;
    const scrapedAt = new Date().toISOString();

    // ── Lazy browser getter ───────────────────────────────────────────────
    let _lazySession: any = null;
    let _lazySessionPromise: Promise<any> | null = null;

    const getBrowser = (): Promise<Browser> => {
      if (_lazySession) {
        return Promise.resolve((_lazySession as any).browser as Browser);
      }
      if (!_lazySessionPromise) {
        _lazySessionPromise = acquireSession().then(s => {
          _lazySession = s;
          return s;
        }).catch(err => {
          _lazySessionPromise = null;
          throw err;
        });
      }
      return _lazySessionPromise.then(s => (s as any).browser as Browser);
    };

    // ── Global hard timeout ───────────────────────────────────────────────
    let globalTimerHandle: NodeJS.Timeout | null = null;
    const globalTimeout = new Promise<never>((_, reject) => {
      globalTimerHandle = setTimeout(
        () => reject(new Error(`Aggregate timeout after ${AGGREGATE_TIMEOUT_MS / 1000}s`)),
        AGGREGATE_TIMEOUT_MS
      );
    });

    try {
      // ── Fan out to all enabled sources in parallel ────────────────────
      const dispatchMap: Record<string, Promise<SourceResult>> = {};

      if (sources.includes('walmart')) {
        dispatchMap.walmart = withSourceTimeout(
          scrapeWalmart(getBrowser, query, zip, limit),
          'walmart', SOURCE_TIMEOUT_MS, scrapedAt
        );
      }
      if (sources.includes('ikea')) {
        dispatchMap.ikea = withSourceTimeout(
          scrapeIkea(getBrowser, query, zip, limit),
          'ikea', SOURCE_TIMEOUT_MS, scrapedAt
        );
      }
      if (sources.includes('wayfair')) {
        dispatchMap.wayfair = withSourceTimeout(
          scrapeWayfair(getBrowser, query, zip, limit),
          'wayfair', SOURCE_TIMEOUT_MS, scrapedAt
        );
      }
      if (sources.includes('target')) {
        dispatchMap.target = withSourceTimeout(
          scrapeTarget(getBrowser, query, zip, limit),
          'target', SOURCE_TIMEOUT_MS, scrapedAt
        );
      }
      if (sources.includes('amazon')) {
        dispatchMap.amazon = withSourceTimeout(
          scrapeAmazon(getBrowser, query, zip, limit),
          'amazon', SOURCE_TIMEOUT_MS, scrapedAt
        );
      }

      // Race all sources against the global hard timeout
      const promiseEntries = Object.entries(dispatchMap);
      const settledResults = await Promise.race([
        Promise.all(promiseEntries.map(([, p]) => p)),
        globalTimeout,
      ]) as SourceResult[];

      // ── Assemble response ───────────────────────────────────────────
      const resultMap: Record<string, SourceResult> = {};
      for (let i = 0; i < promiseEntries.length; i++) {
        resultMap[promiseEntries[i][0]] = settledResults[i];
      }

      const allProducts = Object.values(resultMap).flatMap(r => r.products);

      // Deduplicate by source + sourceId
      const seen = new Set<string>();
      const products = allProducts.filter(p => {
        const key = `${p.source}:${p.sourceId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        // Quality gate: must have a name
        if (!p.name) return false;
        // Quality gate: confidence must be at least 0.3
        if (p.confidence < 0.3) return false;
        // Relevance gate: safety net — reject products not related to query
        if (!isRelevant(p.name, query)) return false;
        return true;
      });

      // Image enrichment: for products with no images, fetch from Brave Image Search
      const SITE_HINTS: Record<string, string> = {
        walmart: 'walmart.com', ikea: 'ikea.com', wayfair: 'wayfair.com',
        target: 'target.com', amazon: 'amazon.com',
      };
      await Promise.allSettled(
        products
          .filter(p => p.images.length === 0)
          .slice(0, 8)  // cap at 8 concurrent image fetches
          .map(async p => {
            const img = await fetchImageFromBrave(p.name, SITE_HINTS[p.source]).catch(() => null);
            if (img) p.images = [img];
          })
      );

      // Sort: high confidence first, then price ascending
      products.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        if (a.price && b.price) return a.price - b.price;
        return 0;
      });

      const costCredits = sources.reduce((sum, s) => sum + (CREDITS[s] ?? 2), 0);
      const durationMs  = Date.now() - startMs;

      if (globalTimerHandle) clearTimeout(globalTimerHandle);

      if (DEBUG_LOG) {
        console.log(`[aggregate] Done: ${products.length} products from [${sources.join(', ')}] in ${durationMs}ms`);
      }

      trackAggregateUsage({
        timestamp: scrapedAt,
        clientKey: apiKey,
        query,
        zip,
        sources,
        productsReturned: products.length,
        creditsConsumed: costCredits,
        durationMs,
      }).catch(() => {});

      const response: AggregateResponse = {
        query,
        zip,
        sources: resultMap as AggregateResponse['sources'],
        products,
        totalCount: products.length,
        scrapedAt,
        costCredits,
      };

      return reply.send(response);

    } catch (err: any) {
      if (globalTimerHandle) clearTimeout(globalTimerHandle);
      const isTimeout = err?.message?.includes('timeout');
      const status    = isTimeout ? 504 : 500;

      console.error(`[aggregate] Error: ${err?.message}`);

      const emptyResult = (): SourceResult => ({
        products: [], success: false,
        error: err?.message ?? 'aggregate failed', scrapedAt,
      });

      return reply.status(status).send({
        error: err?.message ?? 'aggregate scrape failed',
        query, zip,
        sources: Object.fromEntries(sources.map(s => [s, emptyResult()])),
        products: [], totalCount: 0, scrapedAt, costCredits: 0,
      });

    } finally {
      if (_lazySession) {
        releaseSession(_lazySession, false);
      }
    }
  });

  console.log('[aggregate] POST /aggregate registered (sources: walmart, ikea, wayfair, target, amazon)');
}
