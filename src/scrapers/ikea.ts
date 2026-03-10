/**
 * ikea.ts — IKEA scraper for Scout's Buy Fast lane
 *
 * IKEA is a cornerstone source for prop stylists and interior designers:
 *   - Furniture, lighting, textiles, storage, décor at accessible price points
 *   - In-store pickup available at most US metro locations
 *   - Clean, consistent structured data (JSON-LD + idom data attributes)
 *   - Article numbers are stable, canonical identifiers
 *
 * Strategy (SERP-first, browser-last):
 *   1. Brave SERP: `{query} site:ikea.com/us/en` → product URLs
 *   2. Filter to /us/en/p/ product pages (skip room-sets, guides, categories)
 *   3. Tier-0 HTTP: IKEA SSR pages embed clean JSON-LD Product schema
 *      and structured price/availability data in data- attributes
 *   4. Browser + US proxy: last resort, tight timeout
 *   5. SERP snippet fallback: title + price from Brave description
 *
 * IKEA URL anatomy:
 *   https://www.ikea.com/us/en/p/{slug}/{article-number}/
 *   Article number: 8-digit numeric code (e.g. 10215264)
 *   Sometimes URL-formatted with dashes: e.g. s39247165
 */

import type { Browser } from 'playwright-core';
import { randomUUID } from 'crypto';
import { runSerpQuery } from '../serp.js';
import { getProxy } from './proxy-pool.js';
import { scrapeUrlSlow } from '../scraper.js';
import type { ScoutProduct, FulfillmentOption, SourceResult } from './types.js';
import { isRelevant } from './types.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

const MAX_PRODUCT_PAGES = 5;
const TIER0_TIMEOUT_MS = 7_000;
const BROWSER_TIMEOUT_MS = 14_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePriceCents(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === 'number') return Math.round(raw * 100);
  const cleaned = String(raw).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : Math.round(parsed * 100);
}

function formatCents(cents: number): string {
  return cents === 0 ? 'Price unavailable' : '$' + (cents / 100).toFixed(2);
}

/**
 * Extract IKEA article number from a /p/ URL.
 * e.g. /p/kallax-shelf-unit-10215264/ → 10215264
 *      /p/product-name-s39247165/      → s39247165
 */
function extractIkeaArticle(url: string): string {
  // Article is the alphanumeric suffix of the last path segment (before trailing slash)
  const m = /\/p\/[^/]+-([0-9a-z]{7,12})\/?(?:[?#]|$)/i.exec(url);
  return m ? m[1] : '';
}

function isIkeaProductUrl(url: string): boolean {
  return /ikea\.com\/us\/en\/p\//i.test(url);
}

function extractPriceFromSnippet(snippet: string): number {
  const m = /\$(\d{1,4}(?:\.\d{2})?)/g.exec(snippet);
  return m ? parsePriceCents(m[1]) : 0;
}

// ── Parse IKEA page HTML ──────────────────────────────────────────────────────

interface IkeaPageData {
  articleNumber: string;
  name: string;
  price: number;
  image: string;
  availability: ScoutProduct['availability'];
  category?: string;
  url?: string;
  inStorePickup: boolean;
  deliveryAvailable: boolean;
  measurementNote?: string;
}

function parseIkeaHtml(html: string, fallbackArticle: string): IkeaPageData | null {
  // ── Strategy 1: JSON-LD Product schema ──────────────────────────────────
  // IKEA embeds very clean structured data — this is the gold path
  const ldRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = ldRe.exec(html)) !== null) {
    try {
      const d = JSON.parse(lm[1]);
      const items = Array.isArray(d) ? d : [d];
      for (const item of items) {
        if (item['@type'] !== 'Product') continue;

        const name = (item.name ?? '').trim();
        if (!name) continue;

        const offers = item.offers;
        let price = 0;
        let availability: ScoutProduct['availability'] = 'unknown';

        if (offers) {
          const offerList = Array.isArray(offers) ? offers : [offers];
          for (const o of offerList) {
            price = parsePriceCents(o.price ?? o.lowPrice ?? 0);
            const availStr = (o.availability ?? '').toLowerCase();
            availability =
              availStr.includes('instock') ? 'in_stock' :
              availStr.includes('limitedavailability') ? 'limited' :
              availStr.includes('outofstock') ? 'out_of_stock' : 'unknown';
            break;
          }
        }

        const image = item.image
          ? (Array.isArray(item.image) ? item.image[0] : item.image)
          : '';

        const articleNumber = String(item.sku ?? item.productID ?? fallbackArticle);
        const brand = item.brand?.name ?? '';
        const category = item.category ?? brand ?? undefined;

        // Check if in-store pickup is mentioned in the page
        const inStorePickup = html.includes('Pick up in store') ||
          html.includes('Check in-store availability') ||
          html.includes('store-availability');

        const deliveryAvailable = html.includes('delivery') || html.includes('Delivery');

        // Measurement note — useful for prop planners
        const measMatch = /(\d+[½¼¾]?\s*"[^"<]{0,60})/i.exec(html);
        const measurementNote = measMatch ? measMatch[1].trim().slice(0, 60) : undefined;

        return {
          articleNumber,
          name,
          price,
          image: String(image),
          availability,
          category,
          url: item.url ?? undefined,
          inStorePickup,
          deliveryAvailable,
          measurementNote,
        };
      }
    } catch { /* skip */ }
  }

  // ── Strategy 2: idom / embedded state JSON ──────────────────────────────
  // IKEA React apps sometimes embed state as window.__REDUX_STATE__ or similar
  const reduxRe = /window\.__(?:REDUX_STATE|INITIAL_STATE|STATE)__\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/;
  const reduxMatch = reduxRe.exec(html);
  if (reduxMatch) {
    try {
      const state = JSON.parse(reduxMatch[1]);
      const product =
        state?.product?.current ??
        state?.pdp?.product ??
        state?.items?.[0] ??
        null;

      if (product) {
        const name = (product.name ?? product.productName ?? '').trim();
        const price = parsePriceCents(
          product.price?.current ?? product.regularPrice ?? product.priceValue
        );
        const articleNumber = String(product.id ?? product.articleNumber ?? product.itemNo ?? fallbackArticle);
        const image = product.mainImage?.url ?? product.images?.[0]?.url ?? '';

        if (name) {
          return {
            articleNumber,
            name,
            price,
            image: String(image),
            availability: product.availability === 'IN_STOCK' ? 'in_stock' : 'unknown',
            inStorePickup: false,
            deliveryAvailable: true,
          };
        }
      }
    } catch { /* fall through */ }
  }

  // ── Strategy 3: og:tags + microdata ────────────────────────────────────
  const ogTitle = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(html)?.[1]?.trim();
  const ogImage = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i.exec(html)?.[1];
  const priceStr =
    /<[^>]+class="[^"]*pip-price__integer[^"]*"[^>]*>([\d,]+)/i.exec(html)?.[1] ??
    /<[^>]+itemprop="price"[^>]+content="([^"]+)"/i.exec(html)?.[1];

  if (ogTitle) {
    return {
      articleNumber: fallbackArticle,
      name: ogTitle.replace(/\s*[-|]\s*IKEA.*$/i, '').trim(),
      price: parsePriceCents(priceStr ?? ''),
      image: ogImage ?? '',
      availability: 'unknown',
      inStorePickup: html.includes('Pick up in store'),
      deliveryAvailable: true,
    };
  }

  return null;
}

// ── SERP snippet fallback ─────────────────────────────────────────────────────

function buildFromSerpResult(
  url: string,
  title: string,
  snippet: string,
  scrapedAt: string,
  thumbnail?: string,
): ScoutProduct | null {
  const article = extractIkeaArticle(url);
  const cleanTitle = title
    .replace(/[-|]\s*IKEA.*$/i, '')
    .replace(/\s+\|\s+.*$/, '')
    .trim();
  if (!cleanTitle) return null;

  const price = extractPriceFromSnippet(snippet);

  // Check for IKEA image URL in snippet or use SERP thumbnail
  const ikeaImgFromSnippet = snippet?.match(/https:\/\/www\.ikea\.com\/[^\s"']+\.jpg/)?.[0];
  const imageUrl = ikeaImgFromSnippet || thumbnail || undefined;

  const ff: FulfillmentOption[] = [
    { type: 'shipping', etaLabel: 'Home delivery available', cost: 0, available: true },
  ];

  return {
    id: randomUUID(),
    sourceId: article || randomUUID(),
    source: 'ikea',
    sourceUrl: url,
    name: cleanTitle,
    price,
    priceFormatted: formatCents(price),
    availability: 'unknown',
    fulfillmentOptions: ff,
    images: imageUrl ? [imageUrl] : [],
    confidence: price > 0 ? 0.55 : 0.4,
    lane: 'buy_fast',
    scrapedAt,
  };
}

// ── Build fulfillment options ─────────────────────────────────────────────────

function buildFulfillment(data: IkeaPageData): FulfillmentOption[] {
  const ff: FulfillmentOption[] = [];

  if (data.inStorePickup) {
    ff.push({
      type: 'pickup',
      etaLabel: 'Check in-store availability',
      cost: 0,
      available: true,
    });
  }

  if (data.deliveryAvailable) {
    ff.push({
      type: 'delivery',
      etaLabel: 'Home delivery — date at checkout',
      cost: 0, // IKEA delivery cost varies by order total
      available: data.availability !== 'out_of_stock',
    });
  }

  ff.push({
    type: 'shipping',
    etaLabel: 'Standard delivery',
    cost: 0,
    available: data.availability !== 'out_of_stock',
  });

  return ff;
}

// ── Scrape a single IKEA product URL ─────────────────────────────────────────

async function scrapeIkeaProduct(
  getBrowser: () => Promise<Browser>,
  url: string,
  fallbackArticle: string,
  serpTitle: string,
  serpSnippet: string,
  scrapedAt: string,
  serpThumbnail?: string,
): Promise<ScoutProduct | null> {
  // Tier-0: plain HTTP — IKEA's SSR pages are accessible without bot challenges
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER0_TIMEOUT_MS);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      redirect: 'follow',
    } as RequestInit);
    clearTimeout(timer);

    if (resp.ok) {
      const html = await resp.text();
      if (html.length > 2000 && !html.includes('Just a moment')) {
        const data = parseIkeaHtml(html, fallbackArticle);
        if (data) {
          if (DEBUG_LOG) console.log(`[ikea] tier0 OK: ${url.slice(0, 80)}`);
          return {
            id: randomUUID(),
            sourceId: data.articleNumber,
            source: 'ikea',
            sourceUrl: data.url ?? url,
            name: data.name,
            price: data.price,
            priceFormatted: formatCents(data.price),
            availability: data.availability,
            fulfillmentOptions: buildFulfillment(data),
            images: data.image ? [data.image] : [],
            category: data.category,
            confidence: data.name && data.price > 0 ? 0.92 : data.name ? 0.7 : 0.5,
            lane: 'buy_fast',
            scrapedAt,
          };
        }
      }
    }
  } catch { /* tier0 failed */ }

  // Browser fallback: US proxy, tight timeout
  const browserPromise = (async () => {
    const browser = await getBrowser();
    const usProxy = getProxy('us');
    const result = await scrapeUrlSlow(browser, url, usProxy ?? undefined, { respondWith: 'html' });
    const html = result.html ?? result.markdown ?? '';
    if (!html) return null;
    const data = parseIkeaHtml(html, fallbackArticle);
    if (!data) return null;
    return {
      id: randomUUID(),
      sourceId: data.articleNumber,
      source: 'ikea' as const,
      sourceUrl: data.url ?? url,
      name: data.name,
      price: data.price,
      priceFormatted: formatCents(data.price),
      availability: data.availability,
      fulfillmentOptions: buildFulfillment(data),
      images: data.image ? [data.image] : [],
      category: data.category,
      confidence: data.name && data.price > 0 ? 0.85 : data.name ? 0.65 : 0.4,
      lane: 'buy_fast' as const,
      scrapedAt,
    };
  })();

  const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), BROWSER_TIMEOUT_MS));
  const browserResult = await Promise.race([browserPromise.catch(() => null), timeoutPromise]);
  if (browserResult) return browserResult;

  // SERP snippet fallback — try Brave Image Search first for IKEA product image
  if (!serpThumbnail) {
    const { fetchImageFromBrave } = await import('./types.js');
    serpThumbnail = await fetchImageFromBrave(serpTitle || 'ikea chair', 'ikea.com') ?? undefined;
  }

  // Try og:image meta tag (IKEA serves meta tags to social crawlers)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const metaResp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'facebookexternalhit/1.1', 'Accept': 'text/html' },
    } as RequestInit);
    clearTimeout(t);
    if (metaResp.ok) {
      const reader = metaResp.body?.getReader();
      if (reader) {
        let chunk = '';
        let done = false;
        while (!done && chunk.length < 8000) {
          const { value, done: d } = await reader.read();
          done = d;
          if (value) chunk += new TextDecoder().decode(value);
        }
        await reader.cancel();
        const ogImage = chunk.match(/<meta[^>]+(?:property="og:image"|name="og:image")[^>]+content="([^"]+)"/i)?.[1]
          ?? chunk.match(/content="(https:\/\/www\.ikea\.com\/[^"]+\.jpg[^"]*)"/i)?.[1];
        if (ogImage) serpThumbnail = ogImage;
      }
    }
  } catch { /* continue */ }
  return buildFromSerpResult(url, serpTitle, serpSnippet, scrapedAt, serpThumbnail);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scrape IKEA product listings for a given query.
 *
 * IKEA is a primary source for Scout — clean structured data, strong
 * in-store pickup availability, and furniture/décor focused inventory.
 */
export async function scrapeIkea(
  getBrowser: () => Promise<Browser>,
  query: string,
  _zip: string,
  limit: number = 10,
): Promise<SourceResult> {
  const scrapedAt = new Date().toISOString();

  console.log(`[ikea] SERP search: "${query}"`);

  let serpResults: Array<{ url?: string; title?: string; description?: string }> = [];
  try {
    serpResults = await runSerpQuery(`${query} site:ikea.com/us/en`, Math.min(limit * 3, 20));
  } catch (err: any) {
    return { products: [], success: false, error: `SERP failed: ${err?.message}`, scrapedAt };
  }

  // Filter to confirmed /us/en/p/ product pages
  const productUrls = serpResults
    .filter(r => r.url && isIkeaProductUrl(r.url))
    .slice(0, Math.min(limit, MAX_PRODUCT_PAGES));

  if (DEBUG_LOG) console.log(`[ikea] ${productUrls.length} product URLs from SERP`);

  // If no product pages found, try snippet extraction from any ikea.com result
  if (productUrls.length === 0) {
    const snippetProducts = serpResults
      .filter(r => r.url?.includes('ikea.com'))
      .slice(0, limit)
      .map(r => buildFromSerpResult(r.url!, r.title ?? '', r.description ?? '', scrapedAt, (r as any).thumbnail))
      .filter((p): p is ScoutProduct => p !== null)
      .filter(p => isRelevant(p.name, query));

    return {
      products: snippetProducts,
      success: snippetProducts.length > 0,
      error: snippetProducts.length === 0 ? 'no IKEA product pages found in SERP results' : undefined,
      scrapedAt,
    };
  }

  const settled = await Promise.allSettled(
    productUrls.map(r =>
      scrapeIkeaProduct(
        getBrowser,
        r.url!,
        extractIkeaArticle(r.url!),
        r.title ?? '',
        r.description ?? '',
        scrapedAt,
        (r as any).thumbnail,
      )
    )
  );

  const products: ScoutProduct[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) products.push(s.value);
  }

  const relevantProducts = products.filter(p => isRelevant(p.name, query));
  console.log(`[ikea] Parsed ${products.length}/${productUrls.length} products, ${relevantProducts.length} relevant`);

  return {
    products: relevantProducts,
    success: relevantProducts.length > 0,
    error: relevantProducts.length === 0 ? 'no relevant products parsed' : undefined,
    scrapedAt,
  };
}
