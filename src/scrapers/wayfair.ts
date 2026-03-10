/**
 * wayfair.ts — Wayfair scraper for Scout's Buy Fast lane
 *
 * Wayfair is the dominant furniture / home-décor marketplace — perfectly
 * aligned with Scout's prop-sourcing use-case for interior designers and
 * production teams.
 *
 * Strategy (SERP-first, browser-last):
 *   1. Brave SERP: `{query} site:wayfair.com` → product URLs
 *   2. Filter to /pdp/ product pages (skip category / search pages)
 *   3. Tier-0 HTTP: extract from JSON-LD Product schema (Wayfair embeds it)
 *      and/or window.wf_prefetch_data script block
 *   4. Browser + US proxy: last resort, tight timeout
 *   5. SERP snippet fallback: title + price from Brave description
 *
 * Wayfair URL anatomy:
 *   https://www.wayfair.com/{category}/pdp/{slug}-{SKU}.html
 *   e.g. .../furniture/pdp/mercury-row-accent-chair-W004826113.html
 *   SKU is the alphanumeric suffix before .html (often starts with letter).
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

/** Extract Wayfair SKU from a /pdp/ URL — the suffix before .html */
function extractWayfairSku(url: string): string {
  // e.g. /mercury-row-accent-chair-W004826113.html → W004826113
  const m = /pdp\/[^/]+-([A-Z0-9]{6,12})\.html/i.exec(url);
  return m ? m[1].toUpperCase() : '';
}

function isWayfairProductUrl(url: string): boolean {
  if (!url.includes('wayfair.com')) return false;
  // Accept /pdp/ pages
  if (/wayfair\.com\/[a-z0-9-]+\/pdp\//i.test(url)) return true;
  // Accept numeric product ID URLs like "-12345678.html"
  if (/-\d{6,}\.html/i.test(url)) return true;
  return false;
}

function isWayfairSearchUrl(url: string): boolean {
  return url.includes('wayfair.com') && (url.includes('/keyword.php') || url.includes('/search/'));
}

function extractPriceFromSnippet(snippet: string): number {
  const m = /\$(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g.exec(snippet);
  return m ? parsePriceCents(m[1].replace(/,/g, '')) : 0;
}

// ── Parse Wayfair page HTML ───────────────────────────────────────────────────

interface WayfairPageData {
  sku: string;
  name: string;
  price: number;
  image: string;
  availability: ScoutProduct['availability'];
  category?: string;
  url?: string;
  shippingEstimate?: string;
}

function parseWayfairHtml(html: string, fallbackSku: string): WayfairPageData | null {
  // ── Strategy 1: window.wf_prefetch_data ─────────────────────────────────
  // Wayfair embeds full product state as a JS assignment in a <script> block
  const prefetchRe = /window\.wf_prefetch_data\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/;
  const prefetchMatch = prefetchRe.exec(html);
  if (prefetchMatch) {
    try {
      const data = JSON.parse(prefetchMatch[1]);
      // The data structure varies — try multiple paths
      const product =
        data?.data?.product ??
        data?.product ??
        data?.sku_details ??
        null;

      if (product) {
        const name = (product.name ?? product.product_name ?? '').trim();
        const price = parsePriceCents(
          product.sale_price ?? product.regular_price ?? product.price ?? product.retail_price
        );
        const image =
          product.imageUrl ??
          product.thumbnail_url ??
          product.medium_image_url ??
          product.large_image_url ??
          (Array.isArray(product.images) ? product.images[0] : null) ??
          '';
        const sku = String(product.sku ?? product.part_number ?? fallbackSku);
        const inStock = product.in_stock != null
          ? Boolean(product.in_stock)
          : (product.available_qty != null ? product.available_qty > 0 : true);
        const shipping = product.shipping_message ?? product.free_shipping_message ?? '';

        if (name) {
          return {
            sku,
            name,
            price,
            image: String(image),
            availability: inStock ? 'in_stock' : 'out_of_stock',
            shippingEstimate: shipping || undefined,
          };
        }
      }
    } catch { /* fall through */ }
  }

  // ── Strategy 2: JSON-LD Product schema ──────────────────────────────────
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

        // Price from offers (array or single)
        let price = 0;
        const offers = item.offers;
        if (offers) {
          const offerList = Array.isArray(offers) ? offers : [offers];
          for (const o of offerList) {
            price = parsePriceCents(o.price ?? o.lowPrice ?? 0);
            if (price > 0) break;
          }
        }

        const image = item.image
          ? Array.isArray(item.image) ? item.image[0] : item.image
          : '';

        const availStr = (offers?.availability ?? offers?.[0]?.availability ?? '').toLowerCase();
        const availability: ScoutProduct['availability'] =
          availStr.includes('instock') ? 'in_stock' :
          availStr.includes('limitedavailability') ? 'limited' :
          availStr.includes('outofstock') ? 'out_of_stock' : 'unknown';

        const sku = String(item.sku ?? item.productID ?? fallbackSku);
        const brand = item.brand?.name ?? '';
        const category = brand || (item.category ?? undefined);

        return {
          sku,
          name,
          price,
          image: String(image),
          availability,
          category,
          url: item.url ?? undefined,
        };
      }
    } catch { /* skip */ }
  }

  // ── Strategy 3: og:tags + structured price from page ────────────────────
  const ogTitle = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(html)?.[1]?.trim();
  const ogImage = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i.exec(html)?.[1];
  const ogUrl = /<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i.exec(html)?.[1];

  // Wayfair sometimes has a data-enzyme-id or itemprop price
  const priceStr =
    /<[^>]+itemprop="price"[^>]+content="([^"]+)"/i.exec(html)?.[1] ??
    /<[^>]+class="[^"]*BasePriceRange[^"]*"[^>]*>\$?([\d,.]+)/i.exec(html)?.[1];

  if (ogTitle) {
    return {
      sku: fallbackSku,
      name: ogTitle.replace(/\s*[-|]\s*Wayfair.*$/i, '').trim(),
      price: parsePriceCents(priceStr ?? ''),
      image: ogImage ?? '',
      availability: 'unknown',
      url: ogUrl ?? undefined,
    };
  }

  return null;
}

// ── Extract products from Wayfair search/keyword page ────────────────────────

function extractProductsFromWayfairSearchPage(html: string, scrapedAt: string, limit: number): ScoutProduct[] {
  const products: ScoutProduct[] = [];

  // Strategy 1: window.__APOLLO_STATE__ JSON
  const apolloRe = /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/;
  const apolloMatch = apolloRe.exec(html);
  if (apolloMatch) {
    try {
      const state = JSON.parse(apolloMatch[1]);
      // Walk all keys looking for Product objects
      for (const [, val] of Object.entries(state)) {
        if (!val || typeof val !== 'object') continue;
        const v = val as Record<string, any>;
        if (v.__typename !== 'Product' && v.__typename !== 'FurnitureProduct') continue;
        const name = (v.name ?? v.productName ?? '').trim();
        if (!name) continue;
        const price = parsePriceCents(v.salePrice ?? v.regularPrice ?? v.price ?? 0);
        const image = v.thumbnailUrl ?? v.mediumImageUrl ?? '';
        const sku = String(v.sku ?? v.partNumber ?? randomUUID());
        const url = v.url ?? v.canonicalUrl ?? '';
        products.push({
          id: randomUUID(),
          sourceId: sku,
          source: 'wayfair',
          sourceUrl: url.startsWith('http') ? url : `https://www.wayfair.com${url}`,
          name,
          price,
          priceFormatted: formatCents(price),
          availability: v.inStock === false ? 'out_of_stock' : 'in_stock',
          fulfillmentOptions: [{ type: 'shipping', etaLabel: 'Free shipping on orders $35+', cost: 0, available: true }],
          images: image ? [image] : [],
          confidence: price > 0 ? 0.8 : 0.6,
          lane: 'buy_fast',
          scrapedAt,
        });
        if (products.length >= limit) break;
      }
    } catch { /* fall through */ }
  }

  if (products.length >= limit) return products;

  // Strategy 2: JSON-LD ItemList or multiple Product schemas
  const ldRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = ldRe.exec(html)) !== null && products.length < limit) {
    try {
      const d = JSON.parse(lm[1]);
      const items = Array.isArray(d) ? d : [d];
      for (const item of items) {
        if (products.length >= limit) break;
        if (item['@type'] === 'ItemList' && Array.isArray(item.itemListElement)) {
          for (const el of item.itemListElement) {
            if (products.length >= limit) break;
            const prod = el.item ?? el;
            const name = (prod.name ?? '').trim();
            if (!name) continue;
            const price = parsePriceCents(prod.offers?.price ?? prod.price ?? 0);
            const url = prod.url ?? '';
            products.push({
              id: randomUUID(),
              sourceId: prod.sku ?? randomUUID(),
              source: 'wayfair',
              sourceUrl: url.startsWith('http') ? url : `https://www.wayfair.com${url}`,
              name,
              price,
              priceFormatted: formatCents(price),
              availability: 'unknown',
              fulfillmentOptions: [{ type: 'shipping', etaLabel: 'Free shipping on orders $35+', cost: 0, available: true }],
              images: prod.image ? [prod.image] : [],
              confidence: price > 0 ? 0.75 : 0.5,
              lane: 'buy_fast',
              scrapedAt,
            });
          }
        } else if (item['@type'] === 'Product') {
          const name = (item.name ?? '').trim();
          if (!name) continue;
          const price = parsePriceCents(item.offers?.price ?? 0);
          products.push({
            id: randomUUID(),
            sourceId: item.sku ?? randomUUID(),
            source: 'wayfair',
            sourceUrl: item.url ?? '',
            name,
            price,
            priceFormatted: formatCents(price),
            availability: 'unknown',
            fulfillmentOptions: [{ type: 'shipping', etaLabel: 'Free shipping on orders $35+', cost: 0, available: true }],
            images: item.image ? [Array.isArray(item.image) ? item.image[0] : item.image] : [],
            confidence: price > 0 ? 0.75 : 0.5,
            lane: 'buy_fast',
            scrapedAt,
          });
        }
      }
    } catch { /* skip */ }
  }

  if (products.length >= limit) return products;

  // Strategy 3: Extract product card data from HTML patterns
  // Wayfair product cards often have data-id or data-sku attributes with title/price nearby
  const productCardRe = /data-sku="([^"]+)"[^>]*[\s\S]*?<[^>]+class="[^"]*ProductName[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/gi;
  let pcm: RegExpExecArray | null;
  while ((pcm = productCardRe.exec(html)) !== null && products.length < limit) {
    const sku = pcm[1];
    const name = pcm[2].replace(/<[^>]+>/g, '').trim();
    if (!name) continue;
    products.push({
      id: randomUUID(),
      sourceId: sku,
      source: 'wayfair',
      sourceUrl: `https://www.wayfair.com/keyword.php?keyword=${sku}`,
      name,
      price: 0,
      priceFormatted: formatCents(0),
      availability: 'unknown',
      fulfillmentOptions: [{ type: 'shipping', etaLabel: 'Free shipping on orders $35+', cost: 0, available: true }],
      images: [],
      confidence: 0.4,
      lane: 'buy_fast',
      scrapedAt,
    });
  }

  return products;
}

// ── SERP snippet fallback ─────────────────────────────────────────────────────

function buildFromSerpResult(
  url: string,
  title: string,
  snippet: string,
  scrapedAt: string,
): ScoutProduct | null {
  const sku = extractWayfairSku(url);
  const cleanTitle = title
    .replace(/[-|]\s*Wayfair.*$/i, '')
    .replace(/\s+\|\s+.*$/, '')
    .trim();
  if (!cleanTitle) return null;

  const price = extractPriceFromSnippet(snippet);

  return {
    id: randomUUID(),
    sourceId: sku || randomUUID(),
    source: 'wayfair',
    sourceUrl: url,
    name: cleanTitle,
    price,
    priceFormatted: formatCents(price),
    availability: 'unknown',
    fulfillmentOptions: [{ type: 'shipping', etaLabel: 'Free shipping on orders $35+', cost: 0, available: true }],
    images: [],
    confidence: price > 0 ? 0.55 : 0.4,
    lane: 'buy_fast',
    scrapedAt,
  };
}

// ── Scrape a single Wayfair product URL ───────────────────────────────────────

async function scrapeWayfairProduct(
  getBrowser: () => Promise<Browser>,
  url: string,
  fallbackSku: string,
  serpTitle: string,
  serpSnippet: string,
  scrapedAt: string,
): Promise<ScoutProduct | null> {
  // Tier-0: plain HTTP (Wayfair SSR pages are often accessible without bot detection)
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
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    } as RequestInit);
    clearTimeout(timer);

    if (resp.ok) {
      const html = await resp.text();
      if (html.length > 2000 && !html.includes('Just a moment') && !html.includes('cf-browser-verification')) {
        const data = parseWayfairHtml(html, fallbackSku);
        if (data) {
          if (DEBUG_LOG) console.log(`[wayfair] tier0 OK: ${url.slice(0, 80)}`);
          const ff: FulfillmentOption[] = [{
            type: 'shipping',
            etaLabel: data.shippingEstimate ?? 'Free shipping on orders $35+',
            cost: 0,
            available: data.availability !== 'out_of_stock',
          }];
          return {
            id: randomUUID(),
            sourceId: data.sku || fallbackSku,
            source: 'wayfair',
            sourceUrl: data.url ?? url,
            name: data.name,
            price: data.price,
            priceFormatted: formatCents(data.price),
            availability: data.availability,
            fulfillmentOptions: ff,
            images: data.image ? [data.image] : [],
            category: data.category,
            confidence: data.name && data.price > 0 ? 0.9 : data.name ? 0.7 : 0.5,
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
    const data = parseWayfairHtml(html, fallbackSku);
    if (!data) return null;
    const ff: FulfillmentOption[] = [{
      type: 'shipping',
      etaLabel: data.shippingEstimate ?? 'Free shipping on orders $35+',
      cost: 0,
      available: data.availability !== 'out_of_stock',
    }];
    return {
      id: randomUUID(),
      sourceId: data.sku || fallbackSku,
      source: 'wayfair' as const,
      sourceUrl: data.url ?? url,
      name: data.name,
      price: data.price,
      priceFormatted: formatCents(data.price),
      availability: data.availability,
      fulfillmentOptions: ff,
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

  // SERP snippet fallback
  return buildFromSerpResult(url, serpTitle, serpSnippet, scrapedAt);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scrape Wayfair product listings for a given query.
 *
 * Step 1: Brave SERP to find Wayfair product page URLs
 * Step 2: Filter to /pdp/ product pages (not category pages)
 * Step 3: Scrape each page for structured product data
 */
export async function scrapeWayfair(
  getBrowser: () => Promise<Browser>,
  query: string,
  _zip: string,
  limit: number = 10,
): Promise<SourceResult> {
  const scrapedAt = new Date().toISOString();

  console.log(`[wayfair] SERP search: "${query}"`);

  // ── Step 1: Try multiple SERP queries in sequence until we have enough URLs ─
  const serpQueries = [
    `"${query}" site:wayfair.com`,
    `"${query}" wayfair.com furniture`,
  ];

  let allSerpResults: Array<{ url?: string; title?: string; description?: string }> = [];

  for (const serpQuery of serpQueries) {
    if (allSerpResults.filter(r => r.url?.includes('wayfair.com')).length >= limit * 2) break;
    try {
      if (DEBUG_LOG) console.log(`[wayfair] Trying SERP query: ${serpQuery}`);
      const results = await runSerpQuery(serpQuery, Math.min(limit * 3, 20));
      // Merge, dedup by URL
      const existingUrls = new Set(allSerpResults.map(r => r.url));
      for (const r of results) {
        if (r.url && !existingUrls.has(r.url)) {
          allSerpResults.push(r);
          existingUrls.add(r.url);
        }
      }
    } catch (err: any) {
      if (DEBUG_LOG) console.log(`[wayfair] SERP query failed: ${err?.message}`);
    }
  }

  if (allSerpResults.length === 0) {
    return { products: [], success: false, error: 'All SERP queries failed', scrapedAt };
  }

  // ── Step 2: Separate product pages from search/keyword pages ─────────────
  const productPageUrls = allSerpResults
    .filter(r => r.url && isWayfairProductUrl(r.url))
    .slice(0, Math.min(limit, MAX_PRODUCT_PAGES));

  const searchPageResults = allSerpResults
    .filter(r => r.url && isWayfairSearchUrl(r.url))
    .slice(0, 2); // Only need a couple of search pages

  if (DEBUG_LOG) console.log(`[wayfair] ${productPageUrls.length} product URLs, ${searchPageResults.length} search pages from SERP`);

  const products: ScoutProduct[] = [];

  // ── Step 3: Scrape confirmed product pages ───────────────────────────────
  if (productPageUrls.length > 0) {
    const settled = await Promise.allSettled(
      productPageUrls.map(r =>
        scrapeWayfairProduct(
          getBrowser,
          r.url!,
          extractWayfairSku(r.url!),
          r.title ?? '',
          r.description ?? '',
          scrapedAt,
        )
      )
    );

    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) products.push(s.value);
    }
    if (DEBUG_LOG) console.log(`[wayfair] Scraped ${products.length} from product pages`);
  }

  // ── Step 4: Scrape keyword/search pages if we still need more products ───
  if (products.length < limit && searchPageResults.length > 0) {
    for (const r of searchPageResults) {
      if (products.length >= limit) break;
      try {
        if (DEBUG_LOG) console.log(`[wayfair] Scraping search page: ${r.url}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIER0_TIMEOUT_MS);
        let searchHtml = '';
        try {
          const resp = await fetch(r.url!, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
          } as RequestInit);
          clearTimeout(timer);
          if (resp.ok) searchHtml = await resp.text();
        } catch { clearTimeout(timer); }

        if (!searchHtml || searchHtml.length < 2000 || searchHtml.includes('cf-browser-verification')) {
          // Try browser
          const browser = await getBrowser();
          const usProxy = getProxy('us');
          const result = await scrapeUrlSlow(browser, r.url!, usProxy ?? undefined, { respondWith: 'html' });
          searchHtml = result.html ?? result.markdown ?? '';
        }

        if (searchHtml) {
          const searchProducts = extractProductsFromWayfairSearchPage(searchHtml, scrapedAt, limit - products.length);
          products.push(...searchProducts);
          if (DEBUG_LOG) console.log(`[wayfair] Got ${searchProducts.length} from search page`);
        }
      } catch (err: any) {
        if (DEBUG_LOG) console.log(`[wayfair] Search page scrape failed: ${err?.message}`);
      }
    }
  }

  // ── Step 5: SERP snippet fallback if still not enough ───────────────────
  if (products.length < 3) {
    const snippetProducts = allSerpResults
      .filter(r => r.url?.includes('wayfair.com') && !products.some(p => p.sourceUrl === r.url))
      .slice(0, limit - products.length)
      .map(r => buildFromSerpResult(r.url!, r.title ?? '', r.description ?? '', scrapedAt))
      .filter((p): p is ScoutProduct => p !== null);
    products.push(...snippetProducts);
    if (DEBUG_LOG && snippetProducts.length > 0) console.log(`[wayfair] Added ${snippetProducts.length} from SERP snippets`);
  }

  const relevantProducts = products.filter(p => isRelevant(p.name, query)).slice(0, limit);
  console.log(`[wayfair] Total products: ${products.length}, relevant: ${relevantProducts.length}`);

  return {
    products: relevantProducts,
    success: relevantProducts.length > 0,
    error: relevantProducts.length === 0 ? 'no relevant products parsed from any Wayfair source' : undefined,
    scrapedAt,
  };
}
