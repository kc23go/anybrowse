import type { Browser, Page, BrowserContext } from 'playwright-core';
import { loadEnvNumber } from './env.js';
import { parseHtmlToMarkdown } from './markdown.js';
import { isPdfUrl, convertPdfToMarkdown, isPdfSupportEnabled } from './pdf.js';
import { validateUrl, installSsrfRouteBlock } from './url-guard.js';
import { intelligence } from './autonomy/intelligence.js';
import { stats } from './stats.js';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { solveRecaptchaV2, solveTurnstile } from './captcha.js';
import { internalRelayFetch } from './internal-relay.js';

// Re-export PDF utilities for direct access
export { isPdfUrl, convertPdfToMarkdown, isPdfSupportEnabled } from './pdf.js';
export type { PdfConversionResult } from './pdf.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

// ── User-Agent rotation pool ────────────────────────────────────────────────
// Realistic Chrome UAs across Windows/Mac/Linux and recent Chrome versions
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Fingerprint randomization pools ─────────────────────────────────────────
// Randomize viewport and locale per session to look like different real users
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 2560, height: 1440 },
  { width: 1280, height: 800 },
  { width: 1600, height: 900 },
];

const LOCALES = ['en-US', 'en-GB', 'en-CA', 'en-AU'];

function randomViewport(): { width: number; height: number } {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

function randomLocale(): string {
  return LOCALES[Math.floor(Math.random() * LOCALES.length)];
}

// ── Anti-detection init script ───────────────────────────────────────────────
// Injected into every page before any navigation to hide automation signals.
// Note: playwright-extra stealth plugin runs first; this adds extra hardening.
//
// SAFETY RULES for this script:
// - All sections MUST be in try-catch (errors in one section must not block others)
// - Do NOT delete window.__playwright* — these are Playwright internals, deleting causes hangs
// - Do NOT call putImageData in toDataURL override — modifies canvas state unexpectedly
// - Keep prototype overrides minimal to avoid breaking page functionality
const STEALTH_INIT_SCRIPT = `
  // ── 1. WebDriver removal — strongest possible ────────────────────────────
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
      enumerable: false,
    });
  } catch(e) {}

  // ── 2. Permissions API — realistic notification state ────────────────────
  try {
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : originalQuery(parameters);
  } catch(e) {}

  // ── 3. Languages — always multi-value like a real browser ────────────────
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
    Object.defineProperty(navigator, 'language', {
      get: () => 'en-US',
      configurable: true,
    });
  } catch(e) {}

  // ── 4. Chrome runtime — full realistic object ────────────────────────────
  // The stealth plugin sets window.chrome, but we ensure runtime is complete.
  try {
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        onMessage: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
        onConnect: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
        sendMessage: () => {},
        connect: () => ({
          onMessage: { addListener: () => {}, removeListener: () => {} },
          onDisconnect: { addListener: () => {}, removeListener: () => {} },
          postMessage: () => {},
          disconnect: () => {},
        }),
        getManifest: () => ({}),
        getURL: function(path) { return 'chrome-extension://invalid/' + path; },
        id: undefined,
        lastError: undefined,
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function() {
        return {
          requestTime: Date.now() / 1000,
          startLoadTime: Date.now() / 1000,
          commitLoadTime: Date.now() / 1000,
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        };
      };
    }
    if (!window.chrome.csi) {
      window.chrome.csi = function() {
        return { startE: Date.now(), onloadT: Date.now(), pageT: 1000 + Math.random() * 1000, tran: 15 };
      };
    }
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        getDetails: function() { return null; },
        getIsInstalled: function() { return false; },
        runningState: function() { return 'cannot_run'; },
      };
    }
  } catch(e) {}

  // ── 5. Canvas fingerprint — intercept toDataURL only (safe approach) ─────
  // We add noise by intercepting toDataURL without modifying canvas state.
  // This avoids the dangerous putImageData → corrupt canvas rendering issue.
  try {
    const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      // Get the real data URL first
      const result = _origToDataURL.call(this, type, quality);
      // Add a tiny query-string-style suffix that changes the hash but isn't
      // part of actual image data — this is enough to confuse fingerprinters
      // while keeping the canvas rendering intact.
      if (result && result.startsWith('data:image')) {
        // Inject a stable-per-session but unique noise character into base64
        // by flipping the last data character (safe: base64 alphabet is a-zA-Z0-9+/)
        const mid = result.lastIndexOf(',');
        if (mid > 0 && result.length > mid + 10) {
          const noise = (result.charCodeAt(result.length - 3) ^ 1) & 63;
          const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          return result.slice(0, -3) + b64chars[noise] + result.slice(-2);
        }
      }
      return result;
    };
  } catch(e) {}

  // ── 6. WebRTC — disable to prevent IP leak through proxy ─────────────────
  // Without this, the real VPS IP leaks via WebRTC STUN requests even when
  // all page traffic goes through the residential proxy.
  try {
    const _noopPC = function() { throw new TypeError('RTCPeerConnection is not supported'); };
    Object.defineProperty(window, 'RTCPeerConnection', { value: _noopPC, configurable: true, writable: true });
    Object.defineProperty(window, 'webkitRTCPeerConnection', { value: _noopPC, configurable: true, writable: true });
    Object.defineProperty(window, 'mozRTCPeerConnection', { value: undefined, configurable: true, writable: true });
  } catch(e) {}

  // ── 7. Screen/window dimensions — fix headless defaults ─────────────────
  // Headless Chrome sets outerWidth=0 and outerHeight=0. Real browsers don't.
  try {
    if (window.outerWidth === 0) {
      Object.defineProperty(window, 'outerWidth', { get: function() { return window.innerWidth; }, configurable: true });
    }
    if (window.outerHeight === 0) {
      Object.defineProperty(window, 'outerHeight', { get: function() { return window.innerHeight + 80; }, configurable: true });
    }
  } catch(e) {}

  // ── 8. Network connection info — realistic values ─────────────────────────
  try {
    if (!navigator.connection) {
      Object.defineProperty(navigator, 'connection', {
        get: function() {
          return { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false,
                   addEventListener: function() {}, removeEventListener: function() {} };
        },
        configurable: true,
      });
    }
  } catch(e) {}
`;

// ── Cookie cache per domain (in-memory) ─────────────────────────────────────
// Stores cookies from successful scrapes and restores them on the next visit
// to the same domain — makes us look like a returning visitor.
const cookieCache = new Map<string, any[]>();

// ── Cloudflare challenge detection ──────────────────────────────────────────
function isCloudflareBlock(content: string): boolean {
  return (
    content.includes('Just a moment') ||
    content.includes('cf-browser-verification') ||
    content.includes('Enable JavaScript and cookies to continue') ||
    content.includes('Attention Required! | Cloudflare') ||
    content.includes('Checking if the site connection is secure') ||
    content.includes('_cf_chl_opt')
  );
}

const SCREENSHOTS_DIR = '/agent/data/screenshots';
const SCRAPE_LOG = '/agent/data/scrape-log.jsonl';

// Ensure data directories exist at module load time (silent on failure for local dev)
try {
  if (!existsSync('/agent/data')) mkdirSync('/agent/data', { recursive: true });
  if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });
} catch { /* /agent/data only exists on production server */ }

/**
 * Sanitize a URL into a safe filename using its hostname
 */
export function sanitizeDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
  } catch {
    return 'unknown';
  }
}

export interface ScrapeLogEntry {
  url: string;
  domain: string;
  title: string;
  timestamp: string;
  isAgent: boolean;
  count: number;
}

/**
 * Append a scrape entry to the JSONL log (silent on failure)
 */
export function appendScrapeLog(entry: ScrapeLogEntry): void {
  try {
    if (!existsSync('/agent/data')) return;
    appendFileSync(SCRAPE_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* silent */ }
}

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
    const viewport = randomViewport();
    const locale = randomLocale();
    const stealthHeaders = {
      'Accept-Language': locale.toLowerCase() + ',en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    };
    if (proxy) {
      const ua = randomUA();
      const ctxOptions = isBilibili
        ? { proxy, ...BILIBILI_CONTEXT_OPTIONS }
        : { proxy, userAgent: ua, viewport, locale, extraHTTPHeaders: stealthHeaders };
      context = await browser.newContext(ctxOptions);
      createdContext = true;
    } else if (isBilibili) {
      // Bilibili always gets a fresh context with Chinese locale/UA
      context = await browser.newContext(BILIBILI_CONTEXT_OPTIONS);
      createdContext = true;
    } else {
      // Reuse existing context if available, otherwise create new with random UA
      const existingContexts = browser.contexts();
      if (existingContexts.length > 0) {
        context = existingContexts[0];
      } else {
        context = await browser.newContext({ userAgent: randomUA(), viewport, locale, extraHTTPHeaders: stealthHeaders });
        createdContext = true;
      }
    }

    // Restore cookies for this domain if we've visited before
    const domain = new URL(url).hostname;
    if (cookieCache.has(domain)) {
      try {
        await context.addCookies(cookieCache.get(domain)!);
      } catch { /* silent — cookie restore is best-effort */ }
    }

    await ensureRouteBlocking(context, true);
    installSsrfRouteBlock(context);
    page = await context.newPage();
    // Set a short default timeout for JS eval operations to prevent rebrowser-patch hangs.
    // Navigation has its own explicit timeout; this guards against indefinite eval stalls.
    page.setDefaultTimeout(8000);
    // Inject stealth script before any navigation (hides webdriver, fixes plugins, etc.)
    await page.addInitScript(STEALTH_INIT_SCRIPT).catch(() => {});
    logPerf('Page created', url, contextStart);

    // Navigate and extract content (explicit timeout overrides page default)
    const navStart = performance.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    logPerf('Navigation done', url, navStart);

    // Human-like behavior: short delay + scroll (capped at 8s by setDefaultTimeout)
    // If execution context is unavailable (rebrowser-patch stall), these safely time out.
    await page.waitForTimeout(500 + Math.random() * 800).catch(() => {});
    await page.evaluate(() => {
      window.scrollBy(0, Math.random() * 300 + 100);
    }).catch(() => {});
    await page.waitForTimeout(200 + Math.random() * 300).catch(() => {});

    // Dismiss cookie banners before content extraction
    await dismissCookieBanners(page);

    // Check for Cloudflare block — wait and retry once before falling through
    let rawHtml = await page.content();
    if (isCloudflareBlock(rawHtml)) {
      console.log(`\x1b[35m[SCRAPER]\x1b[0m Cloudflare challenge detected (fast), waiting 5s to retry: ${url}`);
      await page.waitForTimeout(5000);
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }); } catch { /* ignore reload errors */ }
      rawHtml = await page.content();
    }

    const extractStart = performance.now();
    const { content, title } = await extractContentAndTitle(page);
    const markdown = parseHtmlToMarkdown(content);
    logPerf('Content extracted', url, extractStart, { titleLen: title.length, mdLen: markdown.length });

    const status = isValidContent(markdown) ? 'success' : 'empty';
    logPerf('FAST TOTAL', url, scrapeStart, { status });

    if (status === 'success') {
      // Save cookies for this domain (returning visitor on next visit)
      try {
        const cookies = await context!.cookies();
        if (cookies.length > 0) cookieCache.set(domain, cookies);
      } catch { /* silent */ }
      // Take screenshot before closing page
      try {
        const screenshotPath = `${SCREENSHOTS_DIR}/${sanitizeDomain(url)}.jpg`;
        if (existsSync(SCREENSHOTS_DIR)) {
          await page!.screenshot({ path: screenshotPath, type: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 1280, height: 800 } });
        }
      } catch { /* silent fail */ }
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
    const slowViewport = randomViewport();
    const slowLocale = randomLocale();
    const slowStealthHeaders = {
      'Accept-Language': slowLocale.toLowerCase() + ',en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    };
    let ctxOptions: Record<string, unknown> = {};
    if (proxy) ctxOptions.proxy = proxy;
    if (isBilibili) {
      Object.assign(ctxOptions, BILIBILI_CONTEXT_OPTIONS);
    } else {
      ctxOptions.userAgent = randomUA();
      ctxOptions.viewport = slowViewport;
      ctxOptions.locale = slowLocale;
      ctxOptions.extraHTTPHeaders = slowStealthHeaders;
    }
    context = await browser.newContext(ctxOptions);

    // Restore cookies for this domain if we've visited before
    const slowDomain = new URL(url).hostname;
    if (cookieCache.has(slowDomain)) {
      try {
        await context.addCookies(cookieCache.get(slowDomain)!);
      } catch { /* silent — cookie restore is best-effort */ }
    }

    await ensureRouteBlocking(context, false);
    installSsrfRouteBlock(context);
    page = await context.newPage();
    // Set a short default timeout for JS eval operations — prevents rebrowser-patch hangs.
    // Navigation has its own explicit timeout; this guards evaluate() calls.
    page.setDefaultTimeout(10000);
    // Inject stealth script before any navigation (hides webdriver, fixes plugins, etc.)
    await page.addInitScript(STEALTH_INIT_SCRIPT).catch(() => {});
    logPerf('Context created', url, contextStart);

    // Navigate with full load (explicit timeout overrides page default)
    const navStart = performance.now();
    await page.goto(url, { waitUntil: 'load', timeout: SLOW_TIMEOUT_MS });
    logPerf('Navigation done', url, navStart);

    // Human-like behavior: short delay + scroll (capped at 10s by setDefaultTimeout)
    await page.waitForTimeout(500 + Math.random() * 800).catch(() => {});
    await page.evaluate(() => {
      window.scrollBy(0, Math.random() * 300 + 100);
    }).catch(() => {});
    await page.waitForTimeout(200 + Math.random() * 300).catch(() => {});

    // Dismiss cookie banners / GDPR popups before waiting for content
    await dismissCookieBanners(page);

    // Check for Cloudflare block — wait and retry once before falling through
    let rawHtmlSlow = await page.content();
    if (isCloudflareBlock(rawHtmlSlow)) {
      console.log(`\x1b[35m[SCRAPER]\x1b[0m Cloudflare challenge detected (slow), waiting 5s to retry: ${url}`);
      await page.waitForTimeout(5000);
      try { await page.reload({ waitUntil: 'load', timeout: SLOW_TIMEOUT_MS }); } catch { /* ignore reload errors */ }
      rawHtmlSlow = await page.content();
    }

    // ── CAPTCHA detection & solving ─────────────────────────────────────────
    // reCAPTCHA v2
    if (rawHtmlSlow.includes('g-recaptcha') || rawHtmlSlow.includes('grecaptcha')) {
      const siteKey = await page.evaluate(() => {
        const el = document.querySelector('.g-recaptcha');
        return el?.getAttribute('data-sitekey') || null;
      }).catch(() => null);
      if (siteKey) {
        console.log(`\x1b[35m[SCRAPER]\x1b[0m reCAPTCHA detected, attempting CapSolver: ${url}`);
        const token = await solveRecaptchaV2(url, siteKey);
        if (token) {
          await page.evaluate((t: string) => {
            const el = document.getElementById('g-recaptcha-response') as HTMLTextAreaElement | null;
            if (el) el.value = t;
          }, token).catch(() => {});
          // Submit the form or trigger the callback
          await page.evaluate(() => {
            const form = document.querySelector('form');
            if (form) form.submit();
          }).catch(() => {});
          await page.waitForTimeout(3000);
          rawHtmlSlow = await page.content();
        }
      }
    }

    // Cloudflare Turnstile
    if (rawHtmlSlow.includes('cf-turnstile')) {
      const turnSiteKey = await page.evaluate(() => {
        const el = document.querySelector('.cf-turnstile');
        return el?.getAttribute('data-sitekey') || null;
      }).catch(() => null);
      if (turnSiteKey) {
        console.log(`\x1b[35m[SCRAPER]\x1b[0m Turnstile detected, attempting CapSolver: ${url}`);
        const token = await solveTurnstile(url, turnSiteKey);
        if (token) {
          // Inject token into hidden input if present
          await page.evaluate((t: string) => {
            const inp = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
            if (inp) inp.value = t;
          }, token).catch(() => {});
          await page.waitForTimeout(3000);
          rawHtmlSlow = await page.content();
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────────

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
      // Save cookies for this domain (returning visitor on next visit)
      try {
        const cookies = await context!.cookies();
        if (cookies.length > 0) cookieCache.set(slowDomain, cookies);
      } catch { /* silent */ }
      // Take screenshot before closing page
      try {
        const screenshotPath = `${SCREENSHOTS_DIR}/${sanitizeDomain(url)}.jpg`;
        if (existsSync(SCREENSHOTS_DIR)) {
          await page!.screenshot({ path: screenshotPath, type: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 1280, height: 800 } });
        }
      } catch { /* silent fail */ }
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
export async function scrapeUrlWithFallback(browser: Browser, url: string, isAgent?: boolean): Promise<CrawlResult> {
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
      // Log scrape metadata
      appendScrapeLog({
        url,
        domain: new URL(url).hostname,
        title: fast.title,
        timestamp: new Date().toISOString(),
        isAgent: isAgent ?? false,
        count: 1,
      });
      return fast;
    }

    // Fall back to slow scraper
    console.log(`\x1b[35m[SCRAPER]\x1b[0m Fast scrape incomplete, trying slow method: ${url}`);
    result = await scrapeUrlSlow(browser, url);
    method = 'slow';
    intelligence.recordScrape(url, 'slow', result.status === 'success', performance.now() - startTime);
  }

  // If blocked: tier 1 — internal relay browser (residential proxy, persistent Playwright)
  if ((result.status === 'error' || result.status === 'empty') && result.reason === 'blocked') {
    console.log(`\x1b[35m[SCRAPER]\x1b[0m Blocked — trying internal relay browser: ${url}`);
    const relayHtml = await internalRelayFetch(url);
    if (relayHtml && !isCloudflareBlock(relayHtml)) {
      const { content: relayContent, title: relayTitle } = (() => {
        // Quick parse: strip scripts/styles from raw HTML to get content
        const cleaned = relayHtml
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '');
        return { content: cleaned, title: '' };
      })();
      const relayMarkdown = parseHtmlToMarkdown(relayContent);
      if (isValidContent(relayMarkdown)) {
        logPerf('RELAY FALLBACK', url, startTime, { status: 'success' });
        intelligence.scoreContent(relayMarkdown);
        recordDomainStats(url, true);
        appendScrapeLog({
          url,
          domain: new URL(url).hostname,
          title: relayTitle,
          timestamp: new Date().toISOString(),
          isAgent: isAgent ?? false,
          count: 1,
        });
        return { url, title: relayTitle, markdown: relayMarkdown, status: 'success' };
      }
    }

    // tier 2 — slow scraper with explicit proxy config
    console.log(`\x1b[35m[SCRAPER]\x1b[0m Relay failed — retrying with residential proxy (slow): ${url}`);
    const proxyResult = await scrapeUrlSlow(browser, url, PROXY_CONFIG);
    intelligence.recordScrape(url, 'slow', proxyResult.status === 'success', performance.now() - startTime);
    if (proxyResult.status === 'success') {
      logPerf('PROXY FALLBACK', url, startTime, { status: 'success' });
      intelligence.scoreContent(proxyResult.markdown);
      recordDomainStats(url, true);
      // Log scrape metadata
      appendScrapeLog({
        url,
        domain: new URL(url).hostname,
        title: proxyResult.title,
        timestamp: new Date().toISOString(),
        isAgent: isAgent ?? false,
        count: 1,
      });
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
    // Log scrape metadata
    appendScrapeLog({
      url,
      domain: new URL(url).hostname,
      title: result.title,
      timestamp: new Date().toISOString(),
      isAgent: isAgent ?? false,
      count: 1,
    });
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
