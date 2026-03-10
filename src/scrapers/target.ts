/**
 * target.ts — Target scraper for Scout's Buy Fast lane
 *
 * Target is a high-value secondary source for prop stylists:
 *   - Same-day pickup at hundreds of US locations (huge for on-set urgency)
 *   - Solid furniture, home décor, and accent pieces at accessible price points
 *   - Ship-to-store and Shipt delivery options
 *
 * Strategy (SERP-first, browser-last):
 *   1. Brave SERP: `{query} site:target.com/p` → product URLs
 *   2. Filter to product pages: /p/ path with /A-{TCIN} suffix
 *   3. Tier-0 HTTP: extract from __TGT_DATA__ JSON block and/or JSON-LD
 *   4. Browser + US proxy: last resort, tight timeout
 *   5. SERP snippet fallback
 *
 * Target URL anatomy:
 *   https://www.target.com/p/{slug}/-/A-{TCIN}
 *   TCIN = Target Company Item Number (8 digits, e.g. A-84595730)
 *
 * Target embeds SSR data as:
 *   window.__TGT_DATA__ = {...}  (in a <script> block)
 * which contains full PDP item data including price, availability, pickup.
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

/** Extract Target TCIN from URL: /A-{8digits} */
function extractTargetTcin(url: string): string {
  const m = /\/A-(\d{5,10})(?:\/|$|\?|#)/i.exec(url);
  return m ? m[1] : '';
}

function isTargetProductUrl(url: string): boolean {
  // Must have /p/ path AND /A- TCIN
  return /target\.com\/p\//i.test(url) && /\/A-\d{5,}/i.test(url);
}

function extractPriceFromSnippet(snippet: string): number {
  const m = /\$(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g.exec(snippet);
  return m ? parsePriceCents(m[1].replace(/,/g, '')) : 0;
}

function parseAvailability(raw?: string | boolean): ScoutProduct['availability'] {
  if (raw === true) return 'in_stock';
  if (raw === false) return 'out_of_stock';
  if (!raw) return 'unknown';
  const s = String(raw).toLowerCase();
  if (s.includes('in_stock') || s.includes('in stock') || s.includes('available')) return 'in_stock';
  if (s.includes('limited') || s.includes('low') || s.includes('last few')) return 'limited';
  if (s.includes('out_of_stock') || s.includes('out of stock') || s.includes('unavailable')) return 'out_of_stock';
  return 'unknown';
}

// ── Parse Target page HTML ────────────────────────────────────────────────────

interface TargetPageData {
  tcin: string;
  name: string;
  price: number;
  image: string;
  availability: ScoutProduct['availability'];
  category?: string;
  url?: string;
  inStorePickup: boolean;
  sameDayDelivery: boolean;
  pickupEta?: string;
}

function parseTargetHtml(html: string, fallbackTcin: string): TargetPageData | null {
  // ── Strategy 1: window.__TGT_DATA__ ─────────────────────────────────────
  // Target SSR embeds full redux-style store as a JS assignment
  const tgtDataRe = /window\.__TGT_DATA__\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/;
  const tgtMatch = tgtDataRe.exec(html);
  if (tgtMatch) {
    try {
      const store = JSON.parse(tgtMatch[1]);
      // Various state shapes depending on Target's deploy
      const item =
        store?.pdp?.item ??
        store?.props?.pageProps?.item ??
        store?.product?.item ??
        null;

      if (item) {
        const name = (
          item.item_details?.item_title ??
          item.general_merchandise_title ??
          item.title ??
          ''
        ).trim();

        if (!name) return null;

        const tcin = String(item.tcin ?? item.dpci ?? fallbackTcin);

        // Price — Target has regular_retail / current_retail / promotional_price
        const pricing = item.price ?? item.item_details?.price;
        const price = parsePriceCents(
          pricing?.current_retail ??
          pricing?.formatted_current_price?.replace(/[^0-9.]/g, '') ??
          pricing?.reg_retail ??
          0
        );

        // Image
        const image =
          item.item_details?.enrichment?.images?.primary_image_url ??
          item.item_details?.images?.primary_url ??
          item.primary_image_url ??
          item.primaryImage ??
          item.images?.[0]?.url ??
          item.images?.[0] ??
          '';

        // Availability
        const avail = item.item_details?.relationship_type_code === 'VA'
          ? 'in_stock'  // VA = Vendored Assortment = available
          : parseAvailability(
              item.availability?.availability_status ??
              item.item_details?.availability_status ??
              item.sellable
            );

        // Fulfillment options
        const inStorePickup = !!(
          item.fulfillment?.store_pickup_allowed ??
          item.item_details?.fulfillment?.pickup_available ??
          item.in_store_only === false
        );
        const sameDayDelivery = !!(
          item.fulfillment?.same_day_delivery_eligible ??
          item.item_details?.fulfillment?.same_day_shipt
        );

        const category =
          item.item_details?.department_name ??
          item.category?.name ??
          undefined;

        return {
          tcin,
          name,
          price,
          image: String(image),
          availability: avail,
          category,
          inStorePickup,
          sameDayDelivery,
        };
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
        const tcin = String(item.sku ?? item.productID ?? fallbackTcin);

        return {
          tcin,
          name,
          price,
          image: String(image),
          availability,
          category: item.brand?.name ?? item.category ?? undefined,
          inStorePickup: false,
          sameDayDelivery: false,
          url: item.url ?? undefined,
        };
      }
    } catch { /* skip */ }
  }

  // ── Strategy 3: og:tags ──────────────────────────────────────────────────
  const ogTitle = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(html)?.[1]?.trim();
  const ogImage = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i.exec(html)?.[1];

  if (ogTitle) {
    // Try to find structured price
    const priceStr =
      /<[^>]+data-test="product-price"[^>]*>\s*\$?([\d,.]+)/i.exec(html)?.[1] ??
      /<[^>]+itemprop="price"[^>]+content="([^"]+)"/i.exec(html)?.[1];

    return {
      tcin: fallbackTcin,
      name: ogTitle.replace(/\s*[-|]\s*Target.*$/i, '').trim(),
      price: parsePriceCents(priceStr ?? ''),
      image: ogImage ?? '',
      availability: 'unknown',
      inStorePickup: false,
      sameDayDelivery: false,
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
): ScoutProduct | null {
  const tcin = extractTargetTcin(url);
  const cleanTitle = title
    .replace(/[-|]\s*Target.*$/i, '')
    .replace(/\s+\|\s+.*$/, '')
    .trim();
  if (!cleanTitle) return null;

  const price = extractPriceFromSnippet(snippet);

  // Target images follow a predictable CDN pattern based on TCIN
  const imageUrl = tcin ? `https://target.scene7.com/is/image/Target/${tcin}` : undefined;

  const ff: FulfillmentOption[] = [
    { type: 'shipping', etaLabel: 'Free shipping on orders $35+', cost: 0, available: true },
  ];

  return {
    id: randomUUID(),
    sourceId: tcin || randomUUID(),
    source: 'target',
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

// ── Build fulfillment options from parsed data ────────────────────────────────

function buildFulfillment(data: TargetPageData): FulfillmentOption[] {
  const ff: FulfillmentOption[] = [];

  if (data.inStorePickup) {
    ff.push({
      type: 'pickup',
      etaLabel: data.pickupEta ?? 'Ready today at select stores',
      cost: 0,
      available: true,
    });
  }

  if (data.sameDayDelivery) {
    ff.push({
      type: 'delivery',
      etaLabel: 'Same-day delivery via Shipt',
      cost: 0,  // variable; often $0 with Target Circle 360
      available: true,
    });
  }

  ff.push({
    type: 'shipping',
    etaLabel: 'Free shipping on orders $35+',
    cost: 0,
    available: data.availability !== 'out_of_stock',
  });

  return ff;
}

// ── Scrape a single Target product URL ───────────────────────────────────────

async function scrapeTargetProduct(
  getBrowser: () => Promise<Browser>,
  url: string,
  fallbackTcin: string,
  serpTitle: string,
  serpSnippet: string,
  scrapedAt: string,
): Promise<ScoutProduct | null> {
  // Tier-0: plain HTTP (Target is Next.js SSR — often works without a browser)
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
        const data = parseTargetHtml(html, fallbackTcin);
        if (data) {
          if (DEBUG_LOG) console.log(`[target] tier0 OK: ${url.slice(0, 80)}`);
          return {
            id: randomUUID(),
            sourceId: data.tcin,
            source: 'target',
            sourceUrl: data.url ?? url,
            name: data.name,
            price: data.price,
            priceFormatted: formatCents(data.price),
            availability: data.availability,
            fulfillmentOptions: buildFulfillment(data),
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
    const data = parseTargetHtml(html, fallbackTcin);
    if (!data) return null;
    return {
      id: randomUUID(),
      sourceId: data.tcin,
      source: 'target' as const,
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

  // SERP snippet fallback
  return buildFromSerpResult(url, serpTitle, serpSnippet, scrapedAt);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scrape Target product listings for a given query.
 *
 * Highlights same-day pickup availability — key differentiator for prop stylists
 * who need items fast and on-location.
 */
export async function scrapeTarget(
  getBrowser: () => Promise<Browser>,
  query: string,
  _zip: string,
  limit: number = 10,
): Promise<SourceResult> {
  const scrapedAt = new Date().toISOString();

  console.log(`[target] SERP search: "${query}"`);

  let serpResults: Array<{ url?: string; title?: string; description?: string }> = [];
  try {
    serpResults = await runSerpQuery(`${query} site:target.com/p`, Math.min(limit * 3, 20));
  } catch (err: any) {
    return { products: [], success: false, error: `SERP failed: ${err?.message}`, scrapedAt };
  }

  // Filter to confirmed product pages (need /p/ + /A- TCIN)
  const productUrls = serpResults
    .filter(r => r.url && isTargetProductUrl(r.url))
    .slice(0, Math.min(limit, MAX_PRODUCT_PAGES));

  if (DEBUG_LOG) console.log(`[target] ${productUrls.length} product URLs from SERP`);

  // Fallback to snippet extraction for any target.com result
  if (productUrls.length === 0) {
    const snippetProducts = serpResults
      .filter(r => r.url?.includes('target.com'))
      .slice(0, limit)
      .map(r => buildFromSerpResult(r.url!, r.title ?? '', r.description ?? '', scrapedAt))
      .filter((p): p is ScoutProduct => p !== null)
      .filter(p => isRelevant(p.name, query));

    return {
      products: snippetProducts,
      success: snippetProducts.length > 0,
      error: snippetProducts.length === 0 ? 'no Target product pages found in SERP results' : undefined,
      scrapedAt,
    };
  }

  const settled = await Promise.allSettled(
    productUrls.map(r =>
      scrapeTargetProduct(
        getBrowser,
        r.url!,
        extractTargetTcin(r.url!),
        r.title ?? '',
        r.description ?? '',
        scrapedAt,
      )
    )
  );

  const products: ScoutProduct[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) products.push(s.value);
  }

  const relevantProducts = products.filter(p => isRelevant(p.name, query));
  console.log(`[target] Parsed ${products.length}/${productUrls.length} products, ${relevantProducts.length} relevant`);

  return {
    products: relevantProducts,
    success: relevantProducts.length > 0,
    error: relevantProducts.length === 0 ? 'no relevant products parsed' : undefined,
    scrapedAt,
  };
}
