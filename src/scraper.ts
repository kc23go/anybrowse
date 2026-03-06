import type { Browser, Page, BrowserContext } from 'playwright-core';
import { loadEnvNumber } from './env.js';
import { parseHtmlToMarkdown } from './markdown.js';
import { isPdfUrl, convertPdfToMarkdown, isPdfSupportEnabled } from './pdf.js';
import { validateUrl, installSsrfRouteBlock } from './url-guard.js';
import { intelligence } from './autonomy/intelligence.js';
import { stats } from './stats.js';

// Re-export PDF utilities for direct access
export { isPdfUrl, convertPdfToMarkdown, isPdfSupportEnabled } from './pdf.js';
export type { PdfConversionResult } from './pdf.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

// Configuration
const MIN_CONTENT_LENGTH = loadEnvNumber('CRAWL_MIN_CONTENT_LENGTH', 100);
const NAVIGATION_TIMEOUT_MS = loadEnvNumber('CRAWL_NAVIGATION_TIMEOUT_MS', 30000);
const SLOW_TIMEOUT_MS = loadEnvNumber('CRAWL_SLOW_TIMEOUT_MS', 45000);

// Cookie consent button selectors to auto-dismiss (ordered by specificity)
const COOKIE_CONSENT_SELECTORS = [
  // Specific common consent frameworks
  '#onetrust-accept-btn-handler',
  '#accept-recommended-btn-handler',
  '.cookie-consent-accept',
  '[data-cookiebanner="accept_button"]',
  // Generic text-based matches (handled via JS evaluation)
];

// Bilibili-specific context options (Chinese CDN optimised)
const BILIBILI_CONTEXT_OPTIONS = {
  locale: 'zh-CN',
  extraHTTPHeaders: {
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// Residential proxy for fallback (only used when blocked)
const PROXY_CONFIG = {
  server: 'http://161.77.10.249:12323',
  username: '14aaa55fdc22e',
  password: '5cc5f8b080',
} as const;

interface ProxyOptions {
  server: string;
  username: string;
  password: string;
}

// Content selectors in priority order (semantic elements first)
const CONTENT_SELECTORS = [
  'main',
  'article',
  '[role="main"]',
  '#content',
  '.content',
  '#main',
  '.main',
];

// Track contexts with route blocking already configured
const configuredContexts = new WeakSet<BrowserContext>();

export type ScrapeErrorReason = 'timeout' | 'blocked' | 'not_found' | 'invalid_url' | 'unknown';

export interface CrawlResult {
  url: string;
  title: string;
  markdown: string;
  status: 'success' | 'empty' | 'error';
  error?: string;
  reason?: ScrapeErrorReason;
  suggestion?: string;
}

const ERROR_SUGGESTIONS: Record<ScrapeErrorReason, string> = {
  timeout: 'The site took too long to respond. Try again or use a different URL.',
  blocked: 'This site may block scrapers. Try again or contact support.',
  not_found: 'The URL could not be found. Check the URL and try again.',
  invalid_url: 'The URL is invalid. Use a valid http:// or https:// URL.',
  unknown: 'Something went wrong. Try again or contact support.',
};

/**
 * Classify an error message into a structured reason code
 */
function classifyError(message: string): ScrapeErrorReason {
  const msg = message.toLowerCase();
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('time out') ||
    msg.includes('exceeded')
  ) return 'timeout';
  if (
    msg.includes('err_connection_refused') ||
    msg.includes('err_cert_') ||
    msg.includes('ssl_') ||
    msg.includes('403') ||
    msg.includes('blocked') ||
    msg.includes('access denied') ||
    msg.includes('forbidden')
  ) return 'blocked';
  if (
    msg.includes('err_name_not_resolved') ||
    msg.includes('err_address_unreachable') ||
    msg.includes('404') ||
    msg.includes('not found') ||
    msg.includes('no such host')
  ) return 'not_found';
  if (
    msg.includes('invalid url') ||
    msg.includes('invalid uri') ||
    msg.includes('url blocked') ||
    msg.includes('ssrf')
  ) return 'invalid_url';
  return 'unknown';
}

/**
 * Build a structured error result for CrawlResult
 */
function makeErrorResult(url: string, message: string): CrawlResult {
  const reason = classifyError(message);
  return {
    url,
    title: '',
    markdown: '',
    status: 'error',
    error: message,
    reason,
    suggestion: ERROR_SUGGESTIONS[reason],
  };
}

/**
 * Log scraper performance with color-coded duration
 */
function logPerf(step: string, url: string, startTime: number, details?: Record<string, unknown>): void {
  const duration = performance.now() - startTime;
  const color = duration < 1000 ? '\x1b[32m' : duration < 5000 ? '\x1b[33m' : '\x1b[31m';
  const urlShort = url.length > 50 ? url.slice(0, 50) + '...' : url;
  const detailsStr = details ? ` | ${JSON.stringify(details)}` : '';
  console.log(`\x1b[35m[SCRAPER]\x1b[0m ${step.padEnd(20)} | ${color}${duration.toFixed(0).padStart(5)}ms\x1b[0m | ${urlShort}${detailsStr}`);
}

/**
 * Check if markdown content meets minimum length threshold
 */
function isValidContent(markdown: string): boolean {
  const cleaned = markdown.replace(/\s+/g, ' ').trim();
  return cleaned.length >= MIN_CONTENT_LENGTH;
}

/**
 * Auto-dismiss cookie consent banners / GDPR popups.
 * Tries known selector IDs first, then scans buttons for common accept-text patterns.
 * Silent on failure — never blocks content extraction.
 */
async function dismissCookieBanners(page: Page): Promise<void> {
  try {
    await page.evaluate((selectors: string[]) => {
      // Try explicit selectors first
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el && el.offsetParent !== null) {
          el.click();
          return;
        }
      }

      // Text-based scan: look for visible buttons / anchors with accept-like text
      const acceptPatterns = [
        /accept all/i,
        /accept cookies/i,
        /i agree/i,
        /agree to all/i,
        /allow all/i,
        /allow cookies/i,
        /got it/i,
        /ok,? got it/i,
        /consent to all/i,
        /同意/,        // Chinese "agree"
        /接受/,        // Chinese "accept"
      ];

      const candidates = Array.from(
        document.querySelectorAll('button, a[role="button"], input[type="button"], input[type="submit"]')
      ) as HTMLElement[];

      for (const el of candidates) {
        const text = (el.textContent || el.getAttribute('value') || '').trim();
        if (el.offsetParent !== null && acceptPatterns.some((re) => re.test(text))) {
          el.click();
          return;
        }
      }
    }, COOKIE_CONSENT_SELECTORS);
  } catch {
    // Never let cookie dismissal crash the scrape
  }
}

/**
 * Extract main content and title from page in a single evaluate call
 */
async function extractContentAndTitle(page: Page): Promise<{ content: string; title: string }> {
  return page.evaluate((selectors: string[]) => {
    const title = document.title || '';
    if (!document.body) return { content: '', title };

    // Try semantic selectors first
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && (el.textContent || '').trim().length > 200) {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script, style, noscript, iframe, svg').forEach((e) => e.remove());
        return { content: clone.innerHTML, title };
      }
    }

    // Fall back to cleaned body
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(
      'script, style, noscript, iframe, svg, header, footer, nav, aside, ' +
      '[role="navigation"], [role="banner"], [role="contentinfo"]'
    ).forEach((el) => el.remove());

    return { content: clone.innerHTML, title };
  }, CONTENT_SELECTORS);
}

/**
 * Configure route blocking on context (called once per context)
 */
async function ensureRouteBlocking(context: BrowserContext, blockStylesheets: boolean): Promise<void> {
  if (configuredContexts.has(context)) return;

  const blockedTypes = blockStylesheets
    ? ['image', 'font', 'stylesheet', 'media']
    : ['image', 'font', 'media'];

  await context.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (blockedTypes.includes(resourceType)) {
      return route.abort();
    }
    return route.continue();
  });

  configuredContexts.add(context);
}

/**
 * Safely close a page, logging any errors
 */
async function closePage(page: Page | null, url: string): Promise<void> {
  if (!page) return;
  try {
    await page.close();
  } catch (err) {
    if (DEBUG_LOG) {
      console.warn(`[scraper] Failed to close page for ${url}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Safely close a context, logging any errors
 */
async function closeContext(context: BrowserContext | null, url: string): Promise<void> {
  if (!context) return;
  try {
    await context.close();
  } catch (err) {
    if (DEBUG_LOG) {
      console.warn(`[scraper] Failed to close context for ${url}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * 
 *  scraper - optimized for static/SSR pages
 * 
 * - Reuses existing browser context when available
 * - Blocks heavy assets (images, fonts, stylesheets)
 * - Waits only for 'domcontentloaded' then extracts immediately
 */
export async function scrapeUrlFast(browser: Browser, url: string, proxy?: ProxyOptions): Promise<CrawlResult> {
  const scrapeStart = performance.now();
  console.log(`\x1b[35m[SCRAPER]\x1b[0m Starting scrape: ${url}${proxy ? ' [proxy]' : ''}`);

  let context: BrowserContext | null = null;
  let createdContext = false;
  let page: Page | null = null;

  // Bilibili and Chinese CDN: use locale-appropriate context
  const isBilibili = url.includes('bilibili.com');

  try {
    const contextStart = performance.now();

    // If proxy is requested, always create a fresh isolated context
    if (proxy) {
      const ctxOptions = isBilibili
        ? { proxy, ...BILIBILI_CONTEXT_OPTIONS }
        : { proxy };
      context = await browser.newContext(ctxOptions);
      createdContext = true;
    } else if (isBilibili) {
      // Bilibili always gets a fresh context with Chinese locale/UA
      context = await browser.newContext(BILIBILI_CONTEXT_OPTIONS);
      createdContext = true;
    } else {
      // Reuse existing context if available, otherwise create new
      const existingContexts = browser.contexts();
      if (existingContexts.length > 0) {
        context = existingContexts[0];
      } else {
        context = await browser.newContext();
        createdContext = true;
      }
    }

    await ensureRouteBlocking(context, true);
    installSsrfRouteBlock(context);
    page = await context.newPage();
    logPerf('Page created', url, contextStart);

    // Navigate and extract content
    const navStart = performance.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    logPerf('Navigation done', url, navStart);

    // Dismiss cookie banners before content extraction
    await dismissCookieBanners(page);

    const extractStart = performance.now();
    const { content, title } = await extractContentAndTitle(page);
    const markdown = parseHtmlToMarkdown(content);
    logPerf('Content extracted', url, extractStart, { titleLen: title.length, mdLen: markdown.length });

    const status = isValidContent(markdown) ? 'success' : 'empty';
    logPerf('FAST TOTAL', url, scrapeStart, { status });

    if (status === 'success') {
      return { url, title, markdown, status };
    }
    return { url, title: '', markdown: '', status: 'empty' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logPerf('FAST ERROR', url, scrapeStart, { error: message });

    if (DEBUG_LOG) {
      console.error(`[scraper:fast] Failed ${url}:`, message);
    }

    return makeErrorResult(url, message);
  } finally {
    await closePage(page, url);
    if (createdContext) {
      await closeContext(context, url);
    }
  }
}

/**
 * Slow scraper - fallback for SPAs and dynamic content
 * 
 * - Creates fresh context for isolation
 * - Waits for full page load
 * - Waits for content to render
 * - Less aggressive asset blocking (allows stylesheets)
 */
export async function scrapeUrlSlow(browser: Browser, url: string, proxy?: ProxyOptions): Promise<CrawlResult> {
  const scrapeStart = performance.now();
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  // Bilibili and Chinese CDN: use locale-appropriate context
  const isBilibili = url.includes('bilibili.com');

  try {
    const contextStart = performance.now();
    let ctxOptions: Record<string, unknown> = {};
    if (proxy) ctxOptions.proxy = proxy;
    if (isBilibili) Object.assign(ctxOptions, BILIBILI_CONTEXT_OPTIONS);
    context = await browser.newContext(ctxOptions);
    await ensureRouteBlocking(context, false);
    installSsrfRouteBlock(context);
    page = await context.newPage();
    logPerf('Context created', url, contextStart);

    // Navigate with full load
    const navStart = performance.now();
    await page.goto(url, { waitUntil: 'load', timeout: SLOW_TIMEOUT_MS });
    logPerf('Navigation done', url, navStart);

    // Dismiss cookie banners / GDPR popups before waiting for content
    await dismissCookieBanners(page);

    // Wait for content to render
    try {
      await page.waitForFunction(
        (minLen: number) => {
          const text = document.body?.innerText || '';
          return text.replace(/\s+/g, '').length > minLen;
        },
        MIN_CONTENT_LENGTH,
        { timeout: 30000 }
      );
    } catch {
      // Content may still be usable even if wait times out
      if (DEBUG_LOG) {
        console.warn(`[scraper:slow] Content wait timed out for ${url}`);
      }
    }

    const extractStart = performance.now();
    const { content, title } = await extractContentAndTitle(page);
    const markdown = parseHtmlToMarkdown(content);
    logPerf('Content extracted', url, extractStart, { titleLen: title.length, mdLen: markdown.length });

    const status = isValidContent(markdown) ? 'success' : 'empty';
    logPerf('SLOW TOTAL', url, scrapeStart, { status });

    if (status === 'success') {
      return { url, title, markdown, status };
    }
    return { url, title, markdown, status: 'empty' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logPerf('SLOW ERROR', url, scrapeStart, { error: message });

    if (DEBUG_LOG) {
      console.error(`[scraper:slow] Failed ${url}:`, message);
    }

    return makeErrorResult(url, message);
  } finally {
    await closePage(page, url);
    await closeContext(context, url);
  }
}

/**
 * Scrape with automatic fallback
 * 
 * Checks if URL is a PDF and uses Datalab Marker API for conversion (if API key is configured).
 * For regular URLs, tries fast scraper first, falls back to slow scraper if fast returns empty/error.
 */
export async function scrapeUrlWithFallback(browser: Browser, url: string): Promise<CrawlResult> {
  const startTime = performance.now();

  // SSRF protection: block internal/private IPs
  try {
    await validateUrl(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logPerf('SSRF BLOCKED', url, startTime, { error: message });
    return makeErrorResult(url, `URL blocked: ${message}`);
  }

  // Handle PDF URLs with Datalab Marker API
  if (isPdfUrl(url)) {
    if (!isPdfSupportEnabled()) {
      logPerf('PDF REJECTED', url, startTime, { reason: 'no_api_key' });
      intelligence.recordCapabilityGap('PDF processing requires DATALAB_API_KEY');
      return {
        url,
        title: '',
        markdown: '',
        status: 'error',
        error: 'PDF URLs require DATALAB_API_KEY to be configured',
      };
    }
    console.log(`\x1b[36m[PDF]\x1b[0m Detected PDF URL, using Marker API: ${url}`);
    const pdfResult = await convertPdfToMarkdown(url);
    logPerf('PDF CONVERSION', url, startTime, { status: pdfResult.status });
    return pdfResult;
  }

  // Check if domain intelligence recommends skipping fast scrape
  const skipFast = intelligence.shouldSlowScrape(url);

  let result: CrawlResult;
  let method: 'fast' | 'slow';

  if (skipFast) {
    // Domain known to fail fast scrape — go straight to slow
    logPerf('INTEL SKIP FAST', url, startTime, { reason: 'domain prefers slow' });
    result = await scrapeUrlSlow(browser, url);
    method = 'slow';
    intelligence.recordScrape(url, 'slow', result.status === 'success', performance.now() - startTime);
  } else {
    // Try fast first
    const fast = await scrapeUrlFast(browser, url);
    const fastDuration = performance.now() - startTime;
    intelligence.recordScrape(url, 'fast', fast.status === 'success', fastDuration);

    if (fast.status === 'success') {
      logPerf('WITH FALLBACK', url, startTime, { method: 'fast', status: 'success' });
      // Score content quality and track domain
      intelligence.scoreContent(fast.markdown);
      recordDomainStats(url, true);
      return fast;
    }

    // Fall back to slow scraper
    console.log(`\x1b[35m[SCRAPER]\x1b[0m Fast scrape incomplete, trying slow method: ${url}`);
    result = await scrapeUrlSlow(browser, url);
    method = 'slow';
    intelligence.recordScrape(url, 'slow', result.status === 'success', performance.now() - startTime);
  }

  // If blocked: retry with residential proxy as last resort
  if ((result.status === 'error' || result.status === 'empty') && result.reason === 'blocked') {
    console.log(`\x1b[35m[SCRAPER]\x1b[0m Blocked — retrying with residential proxy: ${url}`);
    const proxyResult = await scrapeUrlSlow(browser, url, PROXY_CONFIG);
    intelligence.recordScrape(url, 'slow', proxyResult.status === 'success', performance.now() - startTime);
    if (proxyResult.status === 'success') {
      logPerf('PROXY FALLBACK', url, startTime, { status: 'success' });
      intelligence.scoreContent(proxyResult.markdown);
      recordDomainStats(url, true);
      return proxyResult;
    }
    // Keep original result if proxy also failed (proxy error shouldn't override original reason)
    logPerf('PROXY FALLBACK', url, startTime, { status: proxyResult.status });
    result = proxyResult;
  }

  logPerf('WITH FALLBACK', url, startTime, { method, status: result.status });

  // Score content quality on success
  if (result.status === 'success') {
    intelligence.scoreContent(result.markdown);
  }

  // Track domain success/failure in stats
  recordDomainStats(url, result.status === 'success');

  return result;
}

/**
 * Record domain-level stats for the stats module
 */
function recordDomainStats(url: string, success: boolean): void {
  try {
    const domain = new URL(url).hostname;
    stats.recordDomain(domain, success);
  } catch {
    // Invalid URL, skip
  }
}
