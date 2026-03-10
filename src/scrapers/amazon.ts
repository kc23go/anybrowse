/**
 * amazon.ts — Amazon scraper for Scout's Buy Fast lane
 *
 * Strategy (Option C — SERP + Deep Links):
 *   1. Use Brave Search API (via runSerpQuery) to find Amazon product URLs
 *      Query: `site:amazon.com {query}`
 *   2. Filter to ASIN product pages: amazon.com/{slug}/dp/[A-Z0-9]{10}
 *   3. Scrape each product page to extract title, price, availability, image
 *   4. Return ScoutProducts with honest confidence scores
 *
 * Price accuracy note:
 *   Amazon aggressively geo-redirects and personalises pricing. Without US proxies
 *   the price may be unavailable (set price=0, priceFormatted="See on Amazon").
 *   The confidence field tells Scout's UI whether to show price or just a "View" CTA.
 *
 *   - confidence 0.9: title + price both found
 *   - confidence 0.7: title found, price missing (geo-redirect / login wall)
 *   - confidence 0.0: title missing (parsing failure)
 */

import type { Browser, Page } from 'playwright-core';
import { randomUUID } from 'crypto';
import { scrapeUrlSlow, scrapeUrlWithFallback } from '../scraper.js';
import { runSerpQuery } from '../serp.js';
import { getProxy } from './proxy-pool.js';
import { getWarmSession, releaseWarmSession } from '../warmer.js';
import type { ScoutProduct, FulfillmentOption, SourceResult } from './types.js';
import { isRelevant } from './types.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Max Amazon product pages to scrape per aggregate call.
 * 3 pages × ~8s each = ~8s wall-clock (parallel) — safe within 20s source budget.
 * Raise this once US proxy latency is profiled and confirmed fast.
 */
const MAX_DEEP_LINKS = 6;

/**
 * Timeout for scraping a single Amazon product page.
 * 10s × 3 parallel pages = still well within the 20s source budget.
 */
const PAGE_SCRAPE_TIMEOUT_MS = 10_000;

/** ASIN regex — 10 uppercase alphanumeric chars after /dp/ or /gp/product/ */
const ASIN_DP_RE = /\/dp\/([A-Z0-9]{10})(?:\/|$|\?)/;
const ASIN_GP_RE = /\/gp\/product\/([A-Z0-9]{10})(?:\/|$|\?)/;

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractAsin(url: string): string | null {
  const m = ASIN_DP_RE.exec(url) ?? ASIN_GP_RE.exec(url);
  return m ? m[1] : null;
}

function canonicalAmazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}`;
}

function parsePriceCents(raw: string | undefined | null): number {
  if (!raw) return 0;
  // Handle "$1,234.99" or "1234.99" or "1,234"
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : Math.round(parsed * 100);
}

function formatCents(cents: number): string {
  if (cents === 0) return 'See on Amazon';
  return '$' + (cents / 100).toFixed(2);
}

// ── DOM extraction from Amazon product page HTML ──────────────────────────────

interface AmazonProductData {
  asin: string;
  title: string;
  price: number;
  priceUnavailable: boolean;
  image: string;
  availability: ScoutProduct['availability'];
  quantityAvailable?: number;
  fulfillmentOptions: FulfillmentOption[];
  category?: string;
}

function extractAmazonProduct(html: string, asin: string): AmazonProductData {
  // ── Title ──────────────────────────────────────────────────────────────────
  let title = '';

  // Try span#productTitle (most reliable)
  const titleSpanRe = /<span[^>]+id="productTitle"[^>]*>([\s\S]*?)<\/span>/i;
  const titleMatch = titleSpanRe.exec(html);
  if (titleMatch) {
    title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
  }

  // Fallback: og:title meta
  if (!title) {
    const ogTitleRe = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i;
    const ogMatch = ogTitleRe.exec(html);
    if (ogMatch) title = ogMatch[1].trim();
  }

  // Fallback: <h1> with id="title"
  if (!title) {
    const h1Re = /<h1[^>]+id="title"[^>]*>([\s\S]*?)<\/h1>/i;
    const h1Match = h1Re.exec(html);
    if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();
  }

  // ── Price ──────────────────────────────────────────────────────────────────
  let price = 0;
  let priceUnavailable = false;

  // Primary: .a-price-whole + .a-price-fraction (the green/red split price)
  const priceWholeRe = /<span[^>]+class="[^"]*a-price-whole[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
  const priceFracRe = /<span[^>]+class="[^"]*a-price-fraction[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
  const wholeMatch = priceWholeRe.exec(html);
  const fracMatch = priceFracRe.exec(html);

  if (wholeMatch) {
    const whole = wholeMatch[1].replace(/<[^>]+>/g, '').replace(/[^0-9]/g, '');
    const frac = fracMatch ? fracMatch[1].replace(/<[^>]+>/g, '').replace(/[^0-9]/g, '') : '00';
    const combined = `${whole}.${frac.padStart(2, '0')}`;
    price = parsePriceCents(combined);
  }

  // Fallback: #priceblock_ourprice or #priceblock_dealprice
  if (!price) {
    const pbRe = /<span[^>]+id="priceblock_(?:ourprice|dealprice|saleprice)"[^>]*>([\s\S]*?)<\/span>/i;
    const pbMatch = pbRe.exec(html);
    if (pbMatch) {
      price = parsePriceCents(pbMatch[1].replace(/<[^>]+>/g, '').trim());
    }
  }

  // Fallback: corePriceDisplay or corePrice
  if (!price) {
    const corePriceRe = /<span[^>]+id="corePriceDisplay_[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
    const coreMatch = corePriceRe.exec(html);
    if (coreMatch) {
      const text = coreMatch[1].replace(/<[^>]+>/g, '').trim();
      price = parsePriceCents(text);
    }
  }

  // Fallback: JSON-LD offers price
  if (!price) {
    const jsonLdRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let jm: RegExpExecArray | null;
    while ((jm = jsonLdRe.exec(html)) !== null) {
      try {
        const data = JSON.parse(jm[1]);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if ((item['@type'] === 'Product' || item['@type'] === 'Offer') && item.offers?.price) {
            price = parsePriceCents(String(item.offers.price));
            if (price) break;
          }
        }
      } catch { /* skip */ }
      if (price) break;
    }
  }

  // Reject euro prices (wrong locale — US proxy didn't work)
  if (price > 0) {
    // Check if any price element contains "€" — means we got a non-US page
    const euroCheck = /<span[^>]+class="[^"]*a-price[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(html);
    if (euroCheck && euroCheck[1].includes('€')) {
      price = 0;
    }
  }
  // Also check for "€" in common price blocks
  if (price > 0) {
    const priceArea = html.slice(0, 50_000); // check first 50KB
    const euroInPriceBlock = /id="(?:priceblock_ourprice|price_inside_buybox)[^"]*"[^>]*>[^<]*€/i.test(priceArea);
    if (euroInPriceBlock) price = 0;
  }

  if (!price) {
    priceUnavailable = true;
  }

  // ── Image ──────────────────────────────────────────────────────────────────
  let image = '';

  // Try #landingImage (main product image)
  const landingRe = /<img[^>]+id="landingImage"[^>]+(?:src|data-a-dynamic-image)="([^"]+)"/i;
  const landingMatch = landingRe.exec(html);
  if (landingMatch) image = landingMatch[1];

  // Fallback: og:image
  if (!image) {
    const ogImgRe = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i;
    const ogImgMatch = ogImgRe.exec(html);
    if (ogImgMatch) image = ogImgMatch[1];
  }

  // Fallback: #imgTagWrappingLink first img
  if (!image) {
    const wrapRe = /<a[^>]+id="imgTagWrappingLink"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i;
    const wrapMatch = wrapRe.exec(html);
    if (wrapMatch) image = wrapMatch[1];
  }

  // ── Availability ───────────────────────────────────────────────────────────
  let availability: ScoutProduct['availability'] = 'unknown';
  let quantityAvailable: number | undefined;

  // #availability span text
  const availRe = /<span[^>]+id="availability"[^>]*>([\s\S]*?)<\/span>/i;
  const availMatch = availRe.exec(html);
  if (availMatch) {
    const availText = availMatch[1].replace(/<[^>]+>/g, '').trim().toLowerCase();
    if (availText.includes('in stock')) {
      availability = 'in_stock';
      // "Only N left" pattern
      const onlyMatch = /only\s+(\d+)\s+left/i.exec(availText);
      if (onlyMatch) {
        availability = 'limited';
        quantityAvailable = parseInt(onlyMatch[1], 10);
      }
    } else if (availText.includes('currently unavailable') || availText.includes('out of stock')) {
      availability = 'out_of_stock';
    } else if (availText.length > 0) {
      availability = 'in_stock'; // "Usually ships within..." = available
    }
  }

  // Fallback: check page text for common signals
  if (availability === 'unknown') {
    if (html.includes('id="add-to-cart-button"')) availability = 'in_stock';
    else if (html.includes('Currently unavailable') || html.includes('currently-unavailable')) availability = 'out_of_stock';
  }

  // ── Fulfillment ────────────────────────────────────────────────────────────
  const fulfillmentOptions: FulfillmentOption[] = [];

  // Prime delivery hint
  const hasPrime = html.includes('prime-logo') || html.includes('primeDelivery') || html.includes('prime_logo');
  const deliveryRe = /(?:Delivery|Ships)\s+(?:by\s+)?([A-Z][a-z]+\s+\d+)/i;
  const deliveryMatch = deliveryRe.exec(html);
  const etaLabel = deliveryMatch ? `Ships by ${deliveryMatch[1]}` : (hasPrime ? 'Prime delivery' : 'Standard shipping');

  fulfillmentOptions.push({
    type: 'shipping',
    etaLabel,
    cost: 0,
    available: availability !== 'out_of_stock',
  });

  // Pickup availability (rare for Amazon but check)
  if (html.includes('pickup') || html.includes('Pickup')) {
    fulfillmentOptions.push({ type: 'pickup', etaLabel: 'Pickup available', cost: 0, available: true });
  }

  // ── Category ───────────────────────────────────────────────────────────────
  let category: string | undefined;
  const breadcrumbRe = /<a[^>]+class="[^"]*a-link-normal[^"]*"[^>]*>\s*([\w\s&,]+?)\s*<\/a>/gi;
  const breadcrumbs: string[] = [];
  let bm: RegExpExecArray | null;
  // Extract first few breadcrumb-ish links from #wayfinding-breadcrumbs
  const wayfindingRe = /<ul[^>]+id="wayfinding-breadcrumbs_feature_div"[^>]*>([\s\S]*?)<\/ul>/i;
  const wayfinding = wayfindingRe.exec(html);
  if (wayfinding) {
    const linkRe = /<a[^>]*>([\s\S]*?)<\/a>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(wayfinding[1])) !== null) {
      const text = lm[1].replace(/<[^>]+>/g, '').trim();
      if (text && !text.includes('\n') && text.length < 50) {
        breadcrumbs.push(text);
      }
      if (breadcrumbs.length >= 3) break;
    }
  }
  if (breadcrumbs.length > 0) category = breadcrumbs.join(' > ');

  return {
    asin,
    title,
    price,
    priceUnavailable,
    image,
    availability,
    quantityAvailable,
    fulfillmentOptions,
    category,
  };
}

// ── Fetch one Amazon product page ────────────────────────────────────────────

/**
 * Fetch an Amazon product page HTML.
 *
 * Attempt order:
 *   1. Plain HTTP fetch — Amazon almost always blocks, but instant when it works.
 *   2. Slow Chromium browser with US residential proxy — US geo, JS rendered.
 *      Wrapped in PAGE_SCRAPE_TIMEOUT_MS so it never blocks indefinitely.
 */
async function fetchAmazonHtml(
  getBrowser: () => Promise<Browser>,
  url: string,
  warmPage?: Page,
): Promise<string> {
  // Tier 0: plain HTTP (fast attempt, often 403 on Amazon but free to try)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
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
      if (html.includes('productTitle') || html.includes('priceblock')) {
        if (DEBUG_LOG) console.log(`[amazon] tier0 OK: ${url}`);
        return html;
      }
    }
  } catch { /* continue to browser */ }

  // Warm session path: use pre-warmed page with accumulated Amazon cookies
  if (warmPage) {
    try {
      if (DEBUG_LOG) console.log(`[amazon] warm session: ${url}`);
      await warmPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 12_000 });
      const html = await warmPage.content();
      if (html && html.length > 1000) return html;
    } catch { /* fall through to cold browser */ }
  }

  // Tiered browser fallback: tries Windows relay → Camoufox → VPS → VPS+proxy
  // This uses the full scraper pipeline which includes real Chrome windows relay
  const browser = await getBrowser();
  if (DEBUG_LOG) console.log(`[amazon] tiered scraper fallback: ${url}`);
  try {
    const result = await scrapeUrlWithFallback(browser, url, false, { respondWith: 'html' });
    if (result.html && result.html.length > 1000) return result.html;
    if (result.markdown && result.markdown.length > 200) return result.markdown;
  } catch { /* fall through to direct slow with US proxy */ }

  // Last resort: slow scraper with US proxy directly
  const usProxy = getProxy('us');
  if (DEBUG_LOG) console.log(`[amazon] last resort slow+US proxy: ${usProxy?.server ?? 'none'}`);
  const result = await scrapeUrlSlow(browser, url, usProxy ?? undefined, { respondWith: 'html' });
  return result.html ?? result.markdown ?? '';
}

// ── Scrape one Amazon product page ────────────────────────────────────────────
async function scrapeAmazonProduct(
  getBrowser: () => Promise<Browser>,
  asin: string,
  scrapedAt: string,
  warmPage?: Page,
): Promise<ScoutProduct | null> {
  const url = canonicalAmazonUrl(asin);

  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), PAGE_SCRAPE_TIMEOUT_MS)
  );

  const fetchPromise = fetchAmazonHtml(getBrowser, url, warmPage);
  const html = await Promise.race([fetchPromise, timeoutPromise]);

  if (!html) {
    if (DEBUG_LOG) console.log(`[amazon] Timeout/empty for ASIN ${asin}`);
    return null;
  }

  const data = extractAmazonProduct(html, asin);

  if (!data.title) {
    if (DEBUG_LOG) console.log(`[amazon] No title found for ASIN ${asin}`);
    return null;
  }

  const confidence = data.title && data.price > 0 ? 0.9 : data.title ? 0.7 : 0.0;

  return {
    id: randomUUID(),
    sourceId: asin,
    source: 'amazon',
    sourceUrl: url,
    name: data.title,
    price: data.price,
    priceFormatted: formatCents(data.price),
    availability: data.availability,
    quantityAvailable: data.quantityAvailable,
    fulfillmentOptions: data.fulfillmentOptions,
    images: data.image ? [data.image] : [],
    category: data.category,
    confidence,
    lane: 'buy_fast',
    scrapedAt,
  };
}

// ── Build product from SERP snippet (fallback when page scraping fails) ───────

function buildAmazonProductFromSerp(
  asin: string,
  serpTitle: string | undefined,
  serpSnippet: string | undefined,
  scrapedAt: string,
): ScoutProduct | null {
  if (!serpTitle) return null;

  // Clean the title (remove "- Amazon.com" suffix, truncate)
  let title = serpTitle
    .replace(/\s*[|-]\s*Amazon\.com.*$/i, '')
    .replace(/\s*:\s*Amazon\.com.*$/i, '')
    .trim();
  if (!title || title.length < 5) return null;

  // Try to extract price from snippet
  let price = 0;
  if (serpSnippet) {
    const priceMatch = /\$(\d{1,4}(?:[.,]\d{2,3})*)/g.exec(serpSnippet);
    if (priceMatch) {
      price = parsePriceCents(priceMatch[1].replace(/,/g, ''));
    }
  }

  const url = `https://www.amazon.com/dp/${asin}`;
  return {
    id: randomUUID(),
    sourceId: asin,
    source: 'amazon',
    sourceUrl: url,
    name: title,
    price,
    priceFormatted: price > 0 ? formatCents(price) : 'See on Amazon',
    availability: 'unknown',
    fulfillmentOptions: [{ type: 'shipping', etaLabel: 'Prime delivery available', cost: 0, available: true }],
    images: [],
    confidence: price > 0 ? 0.55 : 0.4,
    lane: 'buy_fast',
    scrapedAt,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scrape Amazon product listings for a given query.
 *
 * Step 1: Brave SERP to find Amazon ASIN URLs for this query
 * Step 2: Scrape each ASIN product page to extract structured data
 * Step 3: Return ScoutProducts with honest confidence scores
 */
export async function scrapeAmazon(
  getBrowser: () => Promise<Browser>,
  query: string,
  _zip: string,           // zip not used for Amazon (no location-specific results)
  limit: number = 10,
): Promise<SourceResult> {
  const scrapedAt = new Date().toISOString();

  console.log(`[amazon] SERP search: "${query}"`);

  // ── Step 1: SERP to find ASIN URLs ────────────────────────────────────────
  // Query: `"{query}" amazon.com` — no site: restriction for better coverage.
  // We filter for /dp/ or /gp/product/ + ASIN pattern ourselves in step 2.
  let serpResults: Array<{ url?: string; title?: string; description?: string }> = [];
  try {
    serpResults = await runSerpQuery(`"${query}" amazon.com`, Math.min(limit * 3, 30));
    // If not enough ASIN results, try a second query without quotes for broader coverage
    if (serpResults.filter(r => r.url?.includes('/dp/')).length < 3) {
      const extra = await runSerpQuery(`${query} amazon.com buy`, Math.min(limit * 3, 30)).catch(() => []);
      serpResults = [...serpResults, ...extra];
    }
  } catch (err: any) {
    const error = err?.message ?? String(err);
    console.error(`[amazon] SERP failed: ${error}`);
    return { products: [], success: false, error: `SERP failed: ${error}`, scrapedAt };
  }

  if (DEBUG_LOG) console.log(`[amazon] SERP returned ${serpResults.length} results`);

  // ── Step 2: Filter to ASIN product pages (/dp/ or /gp/product/ + 10-char ASIN) ─
  const asinSet = new Set<string>();
  const asinUrls: Array<{ asin: string; url: string; serpTitle?: string; serpSnippet?: string }> = [];

  for (const r of serpResults) {
    const url = r.url ?? '';
    if (!url.includes('amazon.com')) continue;
    // Must have /dp/ or /gp/product/ path and a valid ASIN
    if (!/\/dp\//i.test(url) && !/\/gp\/product\//i.test(url)) continue;

    const asin = extractAsin(url);
    if (asin && !asinSet.has(asin)) {
      asinSet.add(asin);
      // Always use amazon.com (not amazon.de etc.)
      asinUrls.push({ asin, url: `https://www.amazon.com/dp/${asin}`, serpTitle: r.title, serpSnippet: r.description });
      if (asinUrls.length >= Math.min(limit, MAX_DEEP_LINKS)) break;
    }
  }

  if (DEBUG_LOG) console.log(`[amazon] Found ${asinUrls.length} ASIN URLs to scrape`);

  // ── Step 2b: SERP fallback — scrape Amazon search page for ASINs ─────────
  if (asinUrls.length === 0) {
    console.log(`[amazon] SERP returned no ASIN URLs — falling back to Amazon search page`);
    try {
      const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query)}&i=furniture`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let searchHtml = '';
      try {
        const resp = await fetch(searchUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          redirect: 'follow',
        } as RequestInit);
        clearTimeout(timer);
        if (resp.ok) searchHtml = await resp.text();
      } catch { clearTimeout(timer); }

      if (!searchHtml) {
        // Try tiered browser fallback for search page (includes Windows relay)
        const browser = await getBrowser();
        try {
          const result = await scrapeUrlWithFallback(browser, searchUrl, false, { respondWith: 'html' });
          searchHtml = result.html ?? result.markdown ?? '';
        } catch {
          const usProxy = getProxy('us');
          const result = await scrapeUrlSlow(browser, searchUrl, usProxy ?? undefined, { respondWith: 'html' });
          searchHtml = result.html ?? result.markdown ?? '';
        }
      }

      if (searchHtml) {
        // Extract ASINs from data-asin attributes
        const dataAsinRe = /data-asin="([A-Z0-9]{10})"/g;
        let am: RegExpExecArray | null;
        while ((am = dataAsinRe.exec(searchHtml)) !== null && asinUrls.length < Math.min(limit, MAX_DEEP_LINKS)) {
          const asin = am[1];
          if (!asinSet.has(asin)) {
            asinSet.add(asin);
            asinUrls.push({ asin, url: `https://www.amazon.com/dp/${asin}` });
          }
        }
        if (DEBUG_LOG) console.log(`[amazon] Search page fallback found ${asinUrls.length} ASINs`);
      }
    } catch (fbErr: any) {
      console.error(`[amazon] Search page fallback failed: ${fbErr?.message}`);
    }
  }

  if (asinUrls.length === 0) {
    return {
      products: [],
      success: false,
      error: `No Amazon product pages found in SERP results for "${query}"`,
      scrapedAt,
    };
  }

  // ── Step 3: Try to acquire a pre-warmed session (accumulated Amazon cookies) ──
  const warmSession = await getWarmSession('us').catch(() => null);
  if (warmSession && DEBUG_LOG) {
    console.log(`[amazon] Using warm session ${warmSession.id.slice(0, 8)} (score=${warmSession.warmthScore})`);
  }

  try {
    // ── Step 4: Scrape each ASIN page in parallel (capped at MAX_DEEP_LINKS) ──
    // Warm page is used for the first ASIN; subsequent ones use cold browser
    const scrapeResults = await Promise.allSettled(
      asinUrls.map(({ asin }, i) =>
        scrapeAmazonProduct(getBrowser, asin, scrapedAt, i === 0 ? warmSession?.page : undefined)
      )
    );

    const products: ScoutProduct[] = [];
    for (let i = 0; i < scrapeResults.length; i++) {
      const settled = scrapeResults[i];
      if (settled.status === 'fulfilled' && settled.value) {
        products.push(settled.value);
      } else {
        // Page scraping failed — fall back to SERP snippet data
        const { asin, serpTitle, serpSnippet } = asinUrls[i];
        if (DEBUG_LOG) console.log(`[amazon] Page scraping failed for ASIN ${asin} — using SERP snippet fallback`);
        const serpProduct = buildAmazonProductFromSerp(asin, serpTitle, serpSnippet, scrapedAt);
        if (serpProduct) products.push(serpProduct);
      }
    }

    const relevantProducts = products.filter(p => isRelevant(p.name, query));
    console.log(`[amazon] Scraped ${products.length}/${asinUrls.length} products, ${relevantProducts.length} relevant`);

    return {
      products: relevantProducts,
      success: relevantProducts.length > 0,
      error: relevantProducts.length === 0 ? 'no relevant products scraped' : undefined,
      scrapedAt,
    };
  } finally {
    if (warmSession) releaseWarmSession(warmSession.id);
  }
}
