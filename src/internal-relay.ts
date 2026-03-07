/**
 * Internal relay browser — a persistent headless Playwright instance
 * that routes through our residential proxy, acting as an always-on
 * relay without needing a human Chrome extension.
 */

import { chromium } from 'playwright-core';
import type { Browser, BrowserContext } from 'playwright-core';

let internalBrowser: Browser | null = null;
let internalContext: BrowserContext | null = null;

const RESIDENTIAL_PROXY = process.env.RESIDENTIAL_PROXY || 'http://14aaa55fdc22e:5cc5f8b080@161.77.10.249:12323';

export async function getInternalRelayContext(): Promise<BrowserContext | null> {
  try {
    if (!internalBrowser || !internalBrowser.isConnected()) {
      // Reset context whenever browser is re-created
      internalContext = null;
      internalBrowser = await chromium.launch({
        headless: true,
        proxy: { server: RESIDENTIAL_PROXY },
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
        ]
      });
    }
    if (!internalContext) {
      internalContext = await internalBrowser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
      });
    }
    return internalContext;
  } catch (err) {
    console.warn('[internal-relay] Failed to create context:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function internalRelayFetch(url: string): Promise<string | null> {
  try {
    const ctx = await getInternalRelayContext();
    if (!ctx) return null;
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500 + Math.random() * 1000);
      const html = await page.content();
      return html;
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    console.warn('[internal-relay] Fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Tear down the persistent browser (call on process exit if needed)
 */
export async function closeInternalRelay(): Promise<void> {
  try {
    if (internalContext) { await internalContext.close(); internalContext = null; }
    if (internalBrowser) { await internalBrowser.close(); internalBrowser = null; }
  } catch { /* silent */ }
}
