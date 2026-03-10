/**
 * walmart.ts — Walmart scraper for Scout's Buy Fast lane
 *
 * Strategy (SERP-first, browser-last):
 *   1. Brave SERP: `{query} site:walmart.com` → product URLs in <1s
 *   2. Tier-0 HTTP on each product URL → individual page JSON (SSR, often works)
 *   3. If tier-0 blocked: extract what we can from the SERP snippet itself
 *   4. Browser with US proxy: only if everything else fails, per-page, fast timeout
 *
 * This design gives sub-10s responses on warm paths without a browser.
 */

import type { Browser } from 'playwright-core';
import { randomUUID } from 'crypto';
import { scrapeUrlTier0, scrapeUrlSlow } from '../scraper.js';
import { runSerpQuery } from '../serp.js';
import { getProxy } from './proxy-pool.js';
import type { ScoutProduct, FulfillmentOption, SourceResult } from './types.js';
import { isRelevant, fetchImageFromBrave } from './types.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

/** Max Walmart product pages to fetch per call */
const MAX_PRODUCT_PAGES = 5;
/** Timeout for each tier-0 product page fetch */
const TIER0_TIMEOUT_MS = 6_000;
/** Timeout for browser-based fallback per page */
const BROWSER_TIMEOUT_MS = 12_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function parseAvailability(raw?: string): ScoutProduct['availability'] {
  if (!raw) return 'unknown';
  const s = raw.toLowerCase();
  if (s.includes('in stock') || s.includes('available')) return 'in_stock';
  if (s.includes('limited') || s.includes('only')) return 'limited';
  if (s.includes('out of stock') || s.includes('unavailable')) return 'out_of_stock';
  return 'unknown';
}

/** Extract Walmart item ID from URL (numeric tail after /ip/ or in URL params) */
function extractWalmartId(url: string): string {
  // Pattern 1: /ip/product-name/1234567890
  const slashMatch = /\/ip\/[^/]*?\/(\d{6,12})/.exec(url);
  if (slashMatch) return slashMatch[1];
  // Pattern 2: /ip/1234567890
  const directMatch = /\/ip\/(\d{6,12})/.exec(url);
  if (directMatch) return directMatch[1];
  // Pattern 3: itemId=1234567890 query param
  try {
    const itemId = new URL(url).searchParams.get('itemId');
    if (itemId) return itemId;
  } catch { /* skip */ }
  return '';
}

function isWalmartProductUrl(url: string): boolean {
  return url.includes('walmart.com/ip/') || url.includes('walmart.com/p/');
}

// ── Price extraction from SERP snippet ───────────────────────────────────────
// Brave snippets often contain prices like "$189.00" or "from $24.99"
function extractPriceFromSnippet(snippet: string): number {
  const m = /\$(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g.exec(snippet);
  if (m) return parsePriceCents(m[1].replace(',', ''));
  return 0;
}

// ── Parse Walmart product page HTML ──────────────────────────────────────────
function parseWalmartProductHtml(
  html: string,
  fallbackId: string,
  scrapedAt: string,
): ScoutProduct | null {
  const now = scrapedAt;

  // 1. Try __NEXT_DATA__ (primary)
  const nextRe = /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
  const nextMatch = nextRe.exec(html);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const item =
        data?.props?.pageProps?.initialData?.data?.product ??
        data?.props?.pageProps?.product ??
        null;
      if (item) {
        const id = item.usItemId ?? item.id ?? fallbackId;
        const name = (item.name ?? item.title ?? '').trim();
        const price = parsePriceCents(
          item.priceInfo?.currentPrice?.price ??
          item.priceInfo?.price ??
          item.price ?? 0
        );
        const image =
          item.imageInfo?.thumbnailUrl ??
          item.imageInfo?.heroImage?.url ??
          (Array.isArray(item.imageInfo?.allImages) ? item.imageInfo.allImages[0]?.url : undefined) ??
          item.primaryImage ??
          '';
        const avail = parseAvailability(item.availabilityStatusV2?.display ?? item.availabilityStatus ?? '');
        const url = 'https://www.walmart.com' + (item.canonicalUrl ?? `/ip/${id}`);

        const ff: FulfillmentOption[] = [{
          type: 'shipping', etaLabel: 'Standard shipping', cost: 0,
          available: avail !== 'out_of_stock',
        }];

        if (name) return {
          id: randomUUID(), sourceId: String(id), source: 'walmart',
          sourceUrl: url, name, price, priceFormatted: formatCents(price),
          availability: avail, fulfillmentOptions: ff,
          images: image ? [image] : [],
          confidence: name && price > 0 ? 0.9 : 0.6,
          lane: 'buy_fast', scrapedAt: now,
        };
      }
    } catch { /* fall through */ }
  }

  // 2. Try __WML_REDUX_INITIAL_STATE__ (older pages)
  const reduxRe = /window\.__WML_REDUX_INITIAL_STATE__\s*=\s*\{/;
  const reduxStart = reduxRe.exec(html);
  if (reduxStart) {
    const brace = html.indexOf('{', reduxStart.index + reduxStart[0].length - 1);
    const jsonStr = extractBalancedJson(html, brace, 1_000_000);
    if (jsonStr) {
      try {
        const state = JSON.parse(jsonStr);
        const item =
          state?.product?.item ??
          state?.productDetail?.item?.primaryOffer ??
          null;
        if (item?.productId || item?.usItemId) {
          const id = item.usItemId ?? item.productId ?? fallbackId;
          const name = (item.product?.buyBox?.sellers?.[0]?.name ?? item.name ?? '').trim();
          const price = parsePriceCents(item.priceInfo?.currentPrice?.price ?? 0);
          const reduxImage =
            item.imageInfo?.thumbnailUrl ??
            item.primaryImage ??
            item.images?.[0]?.url ??
            '';
          if (name) return {
            id: randomUUID(), sourceId: String(id), source: 'walmart',
            sourceUrl: `https://www.walmart.com/ip/${id}`,
            name, price, priceFormatted: formatCents(price),
            availability: 'unknown',
            fulfillmentOptions: [{ type: 'shipping', etaLabel: 'Standard shipping', cost: 0, available: true }],
            images: reduxImage ? [String(reduxImage)] : [],
            confidence: name && price > 0 ? 0.85 : 0.5,
            lane: 'buy_fast', scrapedAt: now,
          };
        }
      } catch { /* skip */ }
    }
  }

  // 3. Regex fallback — look for Walmart CDN image URL embedded anywhere in the HTML
  const walmartImgRe = /"(https:\/\/i5\.walmartimages\.com\/[^"]{10,300})"/;
  const walmartImgMatch = walmartImgRe.exec(html);
  if (walmartImgMatch) {
    // We found an image but not a full product — can't reliably reconstruct without name
    // Return null so caller falls back to SERP snippet
  }

  return null;
}

function extractBalancedJson(text: string, startIndex: number, maxScan: number): string | null {
  const end = Math.min(startIndex + maxScan, text.length);
  let depth = 0, inStr = false, esc = false;
  for (let i = startIndex; i < end; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return text.slice(startIndex, i + 1); }
  }
  return null;
}

// ── Build a ScoutProduct from a SERP snippet (no page scrape) ─────────────────
function buildFromSerpResult(
  url: string,
  title: string,
  snippet: string,
  scrapedAt: string,
  thumbnail?: string,
): ScoutProduct | null {
  const itemId = extractWalmartId(url);
  if (!itemId && !title) return null;

  const price = extractPriceFromSnippet(snippet);
  const cleanTitle = title
    .replace(/- Walmart\.com$/i, '')
    .replace(/\| Walmart$/i, '')
    .trim();

  if (!cleanTitle) return null;

  // Try to find a Walmart CDN image — check SERP thumbnail, then snippet text
  const walmartImgFromSnippet = snippet?.match(/https:\/\/i5\.walmartimages\.com\/[^\s"']+/)?.[0];
  const imageUrl = thumbnail || walmartImgFromSnippet || undefined;

  return {
    id: randomUUID(),
    sourceId: itemId || randomUUID(),
    source: 'walmart',
    sourceUrl: url,
    name: cleanTitle,
    price,
    priceFormatted: formatCents(price),
    availability: 'unknown',
    fulfillmentOptions: [{ type: 'shipping', etaLabel: 'Standard shipping', cost: 0, available: true }],
    images: imageUrl ? [imageUrl] : [],
    confidence: price > 0 ? 0.65 : 0.45,
    lane: 'buy_fast',
    scrapedAt,
  };
}

// ── Scrape a single Walmart product URL ───────────────────────────────────────
async function scrapeWalmartProduct(
  getBrowser: () => Promise<Browser>,
  url: string,
  fallbackId: string,
  serpTitle: string,
  serpSnippet: string,
  scrapedAt: string,
  serpThumbnail?: string,
): Promise<ScoutProduct | null> {
  // Tier-0: plain HTTP (fast, sometimes works for Walmart SSR product pages)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER0_TIMEOUT_MS);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    } as RequestInit);
    clearTimeout(timer);

    if (resp.ok) {
      const html = await resp.text();
      if (html.length > 1000 && !html.includes('Just a moment')) {
        const product = parseWalmartProductHtml(html, fallbackId, scrapedAt);
        if (product) {
          if (DEBUG_LOG) console.log(`[walmart] tier0 product parse OK: ${url.slice(0, 80)}`);
          return product;
        }
      }
    }
  } catch { /* tier0 failed, continue */ }

  // Browser fallback (US proxy): only if tier0 failed, acquired lazily
  // Wrap in timeout so it never blocks the aggregate response
  const browserPromise = (async () => {
    const browser = await getBrowser();
    const usProxy = getProxy('us');
    const result = await scrapeUrlSlow(browser, url, usProxy ?? undefined, { respondWith: 'html' });
    const html = result.html ?? result.markdown ?? '';
    if (!html) return null;
    return parseWalmartProductHtml(html, fallbackId, scrapedAt);
  })();

  const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), BROWSER_TIMEOUT_MS));
  const browserResult = await Promise.race([browserPromise.catch(() => null), timeoutPromise]);
  if (browserResult) return browserResult;

  // Last resort: build from SERP data alone
  // Try Brave Image Search to get product image (fast, no browser needed)
  if (!serpThumbnail) {
    serpThumbnail = await fetchImageFromBrave(serpTitle || 'walmart chair', 'walmart.com') ?? undefined;
  }

  // Try one final lightweight fetch for og:image meta tag (first 8KB only)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const metaResp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'facebookexternalhit/1.1',  // social crawlers get og: tags quickly
        'Accept': 'text/html',
      },
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
          ?? chunk.match(/content="(https:\/\/i5\.walmartimages\.com\/[^"]+)"/i)?.[1];
        if (ogImage) serpThumbnail = ogImage;
      }
    }
  } catch { /* og:image fetch failed, continue without image */ }

  return buildFromSerpResult(url, serpTitle, serpSnippet, scrapedAt, serpThumbnail);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function scrapeWalmart(
  getBrowser: () => Promise<Browser>,
  query: string,
  _zip: string,
  limit: number = 10,
): Promise<SourceResult> {
  const scrapedAt = new Date().toISOString();

  console.log(`[walmart] SERP search: "${query}"`);

  // Step 1: Brave SERP to discover Walmart product URLs
  let serpResults: Array<{ url?: string; title?: string; description?: string }> = [];
  try {
    // walmart.com/ip/ filter pushes Brave toward individual item pages
    serpResults = await runSerpQuery(`site:walmart.com/ip ${query}`, Math.min(limit * 3, 20));
  } catch (err: any) {
    return { products: [], success: false, error: `SERP failed: ${err?.message}`, scrapedAt };
  }

  // Step 2: Filter to product pages
  const productUrls = serpResults
    .filter(r => r.url && isWalmartProductUrl(r.url))
    .slice(0, Math.min(limit, MAX_PRODUCT_PAGES));

  if (DEBUG_LOG) console.log(`[walmart] ${productUrls.length} product URLs from SERP`);

  if (productUrls.length === 0) {
    // No product pages — build from all SERP results as fallback
    const products = serpResults
      .filter(r => r.url?.includes('walmart.com'))
      .slice(0, limit)
      .map(r => buildFromSerpResult(r.url!, r.title ?? '', r.description ?? '', scrapedAt, (r as any).thumbnail))
      .filter((p): p is ScoutProduct => p !== null)
      .filter(p => isRelevant(p.name, query));

    return {
      products,
      success: products.length > 0,
      error: products.length === 0 ? 'no Walmart product pages in SERP results' : undefined,
      scrapedAt,
    };
  }

  // Step 3: Scrape each product page in parallel
  const settled = await Promise.allSettled(
    productUrls.map(r =>
      scrapeWalmartProduct(
        getBrowser,
        r.url!,
        extractWalmartId(r.url!),
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
  console.log(`[walmart] Parsed ${products.length} products, ${relevantProducts.length} relevant`);

  return {
    products: relevantProducts,
    success: relevantProducts.length > 0,
    error: relevantProducts.length === 0 ? 'no relevant products parsed' : undefined,
    scrapedAt,
  };
}
