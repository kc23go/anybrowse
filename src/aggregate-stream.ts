/**
 * aggregate-stream.ts — POST /aggregate/stream
 *
 * Streaming SSE version of /aggregate.
 * Sends product cards immediately as SERP results arrive, then enriches
 * each card with real prices/availability via per-product page scrapes.
 *
 * SSE event protocol:
 *   event: start          — search kicked off
 *   event: products       — SERP-level cards from one source (may have price=0)
 *   event: product_update — real price/availability for one product
 *   event: source_error   — a source failed gracefully
 *   event: done           — all sources + enrichments complete
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { scrapeWalmart } from './scrapers/walmart.js';
import { scrapeIkea }    from './scrapers/ikea.js';
import { scrapeWayfair } from './scrapers/wayfair.js';
import { scrapeTarget }  from './scrapers/target.js';
import { scrapeAmazon }  from './scrapers/amazon.js';
import { trackAggregateUsage } from './scrapers/cost-tracker.js';
import type { ScoutProduct } from './scrapers/types.js';
import { isRelevant, fetchImageFromBrave } from './scrapers/types.js';

const SITE_HINTS: Record<string, string> = {
  walmart: 'walmart.com', ikea: 'ikea.com', wayfair: 'wayfair.com',
  target: 'target.com', amazon: 'amazon.com',
};
import { request as httpsRequest } from 'https';
import { request as httpRequest }  from 'http';
import { acquireSession, releaseSession } from './pool.js';
import type { Browser } from 'playwright-core';

// ── Source registry ───────────────────────────────────────────────────────────

const SOURCE_SCRAPERS: Record<string, Function> = {
  walmart: scrapeWalmart,
  ikea:    scrapeIkea,
  wayfair: scrapeWayfair,
  target:  scrapeTarget,
  amazon:  scrapeAmazon,
};

// ── anybrowse owner key for internal /scrape calls ────────────────────────────
const OWNER_KEY = process.env.OWNER_API_KEY ?? '';
const SCRAPE_BASE = process.env.SCRAPE_BASE ?? 'https://anybrowse.dev';

// ── Internal scrape helper ────────────────────────────────────────────────────

async function internalScrape(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ url, js: false });
    const parsed = new URL(SCRAPE_BASE);
    const isHttps = parsed.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const req = reqFn(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: '/scrape',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${OWNER_KEY}`,
        },
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('scrape timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Product-page enrichment ───────────────────────────────────────────────────

interface ProductUpdate {
  id: string;
  source: string;
  price: number;
  priceFormatted: string;
  availability: string;
  fulfillmentOptions: Array<{ type: string; etaLabel: string; cost: number; available: boolean }>;
  images?: string[];
  confidence: number;
}

async function scrapeProductPage(
  source: string,
  product: ScoutProduct,
  zip?: string,
): Promise<ProductUpdate | null> {
  if (!product.sourceUrl) return null;

  try {
    const html = await internalScrape(product.sourceUrl);

    let price = 0;
    let priceFormatted = '';
    let availability = 'unknown';

    if (source === 'walmart') {
      // JSON-LD first
      const ldMatch = html.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)"?/);
      if (ldMatch) price = Math.round(parseFloat(ldMatch[1]) * 100);
      // itemprop fallback
      if (!price) {
        const ipMatch = html.match(/itemprop="price"[^>]*content="([0-9.]+)"/);
        if (ipMatch) price = Math.round(parseFloat(ipMatch[1]) * 100);
      }
      // availability
      if (html.includes('"availability":"InStock"') || html.includes('"InStock"')) availability = 'in_stock';
      else if (html.includes('"OutOfStock"')) availability = 'out_of_stock';
    }

    else if (source === 'ikea') {
      // JSON-LD price — very reliable
      const ldMatch = html.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)"?/);
      if (ldMatch) price = Math.round(parseFloat(ldMatch[1]) * 100);
      if (html.includes('"availability":"InStock"') || html.includes('AVAILABLE')) availability = 'in_stock';
      else if (html.includes('OUT_OF_STOCK') || html.includes('"OutOfStock"')) availability = 'out_of_stock';
    }

    else if (source === 'wayfair') {
      // wf_prefetch_data JSON blob
      const wfMatch = html.match(/window\.__wf_prefetch_data\s*=\s*(\{.{0,5000}?\});/s);
      if (wfMatch) {
        try {
          const wfData = JSON.parse(wfMatch[1]);
          const priceVal = wfData?.product?.price?.salePrice ?? wfData?.product?.price?.listPrice;
          if (priceVal) price = Math.round(parseFloat(String(priceVal)) * 100);
          const stock = wfData?.product?.stockLevel;
          if (stock === 'IN_STOCK' || stock === 'LIMITED_STOCK') availability = stock === 'LIMITED_STOCK' ? 'limited' : 'in_stock';
          else if (stock === 'OUT_OF_STOCK') availability = 'out_of_stock';
        } catch { /* ignore parse errors */ }
      }
      // fallback: JSON-LD
      if (!price) {
        const ldMatch = html.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)"?/);
        if (ldMatch) price = Math.round(parseFloat(ldMatch[1]) * 100);
      }
    }

    else if (source === 'target') {
      // __TGT_DATA__ JSON blob
      const tgtMatch = html.match(/__TGT_DATA__\s*=\s*(\{.{0,10000}?\});/s);
      if (tgtMatch) {
        try {
          const tgtData = JSON.parse(tgtMatch[1]);
          // Walk the deeply nested Target structure
          const priceNodes = JSON.stringify(tgtData).match(/"current_retail"\s*:\s*([\d.]+)/);
          if (priceNodes) price = Math.round(parseFloat(priceNodes[1]) * 100);
          const avail = JSON.stringify(tgtData).match(/"availability_status"\s*:\s*"([^"]+)"/);
          if (avail) availability = avail[1].toLowerCase().includes('in') ? 'in_stock' : 'out_of_stock';
        } catch { /* ignore */ }
      }
      if (!price) {
        const ldMatch = html.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)"?/);
        if (ldMatch) price = Math.round(parseFloat(ldMatch[1]) * 100);
      }
    }

    else if (source === 'amazon') {
      // #priceblock_ourprice or .a-price .a-offscreen
      const amMatch = html.match(/class="a-offscreen">\$([0-9,]+\.[0-9]{2})</);
      if (amMatch) price = Math.round(parseFloat(amMatch[1].replace(',', '')) * 100);
      if (!price) {
        const pbMatch = html.match(/id="priceblock_ourprice"[^>]*>\$([0-9,]+\.[0-9]{2})/);
        if (pbMatch) price = Math.round(parseFloat(pbMatch[1].replace(',', '')) * 100);
      }
      // Amazon doesn't show availability clearly — assume in_stock if price found
      availability = price > 0 ? 'in_stock' : 'unknown';
    }

    if (!price) return null; // couldn't parse — don't send a useless update

    priceFormatted = price > 0 ? `$${(price / 100).toFixed(2)}` : '';

    const fulfillmentOptions: ProductUpdate['fulfillmentOptions'] = [];
    if (availability === 'in_stock' || availability === 'limited') {
      fulfillmentOptions.push({ type: 'delivery', etaLabel: 'Delivery available', cost: 0, available: true });
    }

    // Extract product images from the scraped content
    const imagePatterns = [
      // IKEA
      /https:\/\/www\.ikea\.com\/[a-z]+\/[a-z]+\/images\/products\/[^"'\s]+\.jpg/gi,
      // Walmart CDN
      /https:\/\/i5\.walmartimages\.com\/[^"'\s]+\.jpg/gi,
      // Wayfair
      /https:\/\/secure\.img1-fg\.wfcdn\.com\/[^"'\s]+\.jpg/gi,
      // Amazon
      /https:\/\/m\.media-amazon\.com\/images\/I\/[^"'\s]+\.jpg/gi,
      // Target scene7
      /https:\/\/target\.scene7\.com\/is\/image\/Target\/[^"'\s]+/gi,
      // Generic fallback — any https image
      /https:\/\/[^"'\s]+\.(jpg|webp|png)(?:\?[^"'\s]*)?/gi,
    ];

    const images: string[] = [];
    for (const pattern of imagePatterns) {
      const matches = html.match(pattern);
      if (matches) {
        const valid = matches.filter(url =>
          !url.includes('icon') &&
          !url.includes('logo') &&
          !url.includes('pixel') &&
          !url.includes('spinner') &&
          !url.includes('favicon') &&
          url.length < 300
        );
        images.push(...valid.slice(0, 2));
        if (images.length >= 2) break;
      }
    }

    return {
      id:               product.id,
      source,
      price,
      priceFormatted,
      availability,
      fulfillmentOptions,
      images:           images.length > 0 ? images : undefined,
      confidence: 0.85,
    };
  } catch {
    return null;
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerAggregateStreamRoutes(app: FastifyInstance) {
  app.post('/aggregate/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    const {
      query,
      zip,
      sources = Object.keys(SOURCE_SCRAPERS),
      limit   = 10,
    } = req.body as any;

    if (!query?.trim()) {
      return reply.code(400).send({ error: 'query is required' });
    }

    // ── SSE headers ───────────────────────────────────────────────────────────
    // reply.hijack() tells Fastify we're managing this response manually via
    // reply.raw — prevents ERR_HTTP_HEADERS_SENT when Fastify tries to finalize
    // the response after the async handler returns.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type':               'text/event-stream',
      'Cache-Control':              'no-cache',
      'Connection':                 'keep-alive',
      'X-Accel-Buffering':          'no',
      'Access-Control-Allow-Origin':'*',
    });

    const send = (event: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { /* client disconnected */ }
    };

    const startMs    = Date.now();
    let totalProducts = 0;
    let totalCredits  = 0;

    send('start', { query, zip, sources });

    // ── Lazy browser getter (shared across all scrapers in this request) ────
    let _lazySession: any = null;
    let _lazySessionPromise: Promise<any> | null = null;
    const getBrowser = (): Promise<Browser> => {
      if (_lazySession) return Promise.resolve((_lazySession as any).browser as Browser);
      if (!_lazySessionPromise) {
        _lazySessionPromise = acquireSession().then(s => { _lazySession = s; return s; })
          .catch(err => { _lazySessionPromise = null; throw err; });
      }
      return _lazySessionPromise.then(s => (s as any).browser as Browser);
    };

    // ── Phase 1 + 2: parallel per-source scrape then per-product enrichment ──
    const scraperPromises = (sources as string[])
      .filter((s) => SOURCE_SCRAPERS[s])
      .map(async (source) => {
        try {
          const result = await SOURCE_SCRAPERS[source](getBrowser, query, zip ?? '90028', limit);

          if (result.products?.length > 0) {
            // Quality + relevance gate before streaming
            const validProducts = result.products.filter((p: ScoutProduct) => {
              if (!p.name) return false;
              if (p.confidence < 0.3) return false;
              if (!isRelevant(p.name, query)) return false;
              return true;
            });

            if (validProducts.length === 0) {
              send('source_error', { source, error: 'no relevant products found' });
            } else {
              // Enrich images for products with none (Brave Image Search, fast)
              await Promise.allSettled(
                validProducts
                  .filter((p: ScoutProduct) => p.images.length === 0)
                  .slice(0, 5)
                  .map(async (p: ScoutProduct) => {
                    const img = await fetchImageFromBrave(p.name, SITE_HINTS[p.source]).catch(() => null);
                    if (img) p.images = [img];
                  })
              );

              // Immediately stream the SERP-level cards (price may be 0 / "Loading...")
              send('products', { source, products: validProducts });
              totalProducts += validProducts.length;
              totalCredits  += validProducts.length;

              // Enrich each low-confidence card with a real product-page scrape
              const enrichPromises = validProducts.map(async (product: ScoutProduct) => {
                if (product.confidence < 0.7 && product.sourceUrl) {
                  const update = await scrapeProductPage(source, product, zip).catch(() => null);
                  // Fix 7: only emit if adds real info
                  if (update && (update.price > 0 || update.availability !== 'unknown')) {
                    send('product_update', update);
                  }
                }
              });

              await Promise.allSettled(enrichPromises);
            }
          } else {
            send('source_error', { source, error: result.error ?? 'no products returned' });
          }
        } catch (err: any) {
          send('source_error', { source, error: err.message?.slice(0, 100) });
        }
      });

    await Promise.allSettled(scraperPromises);

    // Release browser session if one was acquired
    if (_lazySession) {
      try { releaseSession(_lazySession, false); } catch { /* ignore */ }
      _lazySession = null;
    }

    const durationMs = Date.now() - startMs;

    // ── Usage logging ─────────────────────────────────────────────────────────
    await trackAggregateUsage({
      timestamp:        new Date().toISOString(),
      query,
      zip:              zip ?? '90028',
      sources,
      productsReturned: totalProducts,
      creditsConsumed:  totalCredits,
      durationMs,
    });

    send('done', {
      totalCount:       totalProducts,
      sourcesCompleted: sources.length,
      costCredits:      totalCredits,
      durationMs,
    });

    reply.raw.end();
  });
}
