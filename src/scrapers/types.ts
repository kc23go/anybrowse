/**
 * types.ts — Shared Scout product types for the /aggregate endpoint
 */

export interface FulfillmentOption {
  type: 'delivery' | 'pickup' | 'shipping';
  etaLabel: string;
  /** Price in cents; 0 = free */
  cost: number;
  available: boolean;
}

export interface ScoutProduct {
  id: string;
  sourceId: string;
  source: 'walmart' | 'ikea' | 'wayfair' | 'target' | 'amazon';
  sourceUrl: string;
  name: string;
  /** Price in cents (integer). 0 when unavailable. */
  price: number;
  /** Formatted string, e.g. "$24.99" or "See on Amazon" */
  priceFormatted: string;
  availability: 'in_stock' | 'limited' | 'out_of_stock' | 'unknown';
  quantityAvailable?: number;
  fulfillmentOptions: FulfillmentOption[];
  images: string[];
  category?: string;
  /** 0–1. How reliably this record was parsed. 0 = critical fields missing. */
  confidence: number;
  lane: 'buy_fast';
  scrapedAt: string;
}

export interface SourceResult {
  products: ScoutProduct[];
  success: boolean;
  error?: string;
  scrapedAt: string;
}

/** Returns true if the product name contains at least one non-trivial keyword from the query */
export function isRelevant(productName: string, query: string): boolean {
  if (!productName || !query) return false;
  // Stop words to ignore
  const STOP = new Set(['a','an','the','and','or','for','in','on','at','to','of','with','by','from','as','into','through','set','pack']);
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
  if (queryWords.length === 0) return true; // very short query, skip filter
  const nameLower = productName.toLowerCase();
  return queryWords.some(word => nameLower.includes(word));
}

// ── Brave Image Search for product images ────────────────────────────────────
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || 'BSA9XeQg5Lplg9t2sSoMAWsGcYJ817l';

/**
 * Decode a Brave image proxy URL to get the original image URL.
 * Brave thumbnail format: https://imgs.search.brave.com/.../g:ce/{base64url}
 * Falls back to using the Brave proxy URL directly if decode fails.
 */
function decodeBraveThumbnail(thumbUrl: string): string | null {
  try {
    const b64part = thumbUrl.split('/g:ce/')[1];
    if (!b64part) return thumbUrl; // use as-is if no g:ce segment
    // Strip non-base64url chars (query params, anchors, etc.)
    const b64 = b64part.replace(/[^A-Za-z0-9\-_=]/g, '');
    if (b64.length < 10) return thumbUrl;
    const decoded = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    // Validate it looks like a URL
    if (decoded.startsWith('http') && decoded.length < 500) {
      return decoded.split('?')[0]; // strip query params
    }
    // Decode failed — use Brave proxy URL directly
    return thumbUrl;
  } catch {
    return thumbUrl; // always return something usable
  }
}

/**
 * Fetch a product image URL using Brave Image Search.
 * Fast, no browser needed, works for Walmart/IKEA/Wayfair/Target/Amazon.
 */
export async function fetchImageFromBrave(query: string, siteHint?: string): Promise<string | null> {
  try {
    const searchQuery = siteHint ? `${query} site:${siteHint}` : query;
    const url = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(searchQuery)}&count=3&safesearch=off`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    } as RequestInit);
    clearTimeout(t);
    if (!resp.ok) return null;
    const data = await resp.json() as { results?: Array<{ thumbnail?: { src?: string }; properties?: { url?: string } }> };
    for (const r of data.results ?? []) {
      // Try to decode the Brave proxy thumbnail to get original CDN URL
      const thumb = r.thumbnail?.src;
      if (thumb?.includes('/g:ce/')) {
        const decoded = decodeBraveThumbnail(thumb);
        if (decoded) return decoded;
      }
      // Fallback: use thumbnail directly (Brave proxy URL)
      if (thumb) return thumb;
      // Or the properties.url if available
      if (r.properties?.url) return r.properties.url;
    }
    return null;
  } catch {
    return null;
  }
}
