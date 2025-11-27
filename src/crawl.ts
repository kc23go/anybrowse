import { FastifyInstance } from 'fastify';
import BrowsercashSDK from '@browsercash/sdk';
import { chromium } from 'playwright-core';
import TurndownService from 'turndown';
import { loadEnvString } from './env.js';
import { runSerpQuery } from './serp.js';

const BROWSER_API_KEY = loadEnvString('BROWSER_API_KEY');
const browserCashClient = new BrowsercashSDK({
  apiKey: BROWSER_API_KEY,
  baseURL: 'https://api.browser.cash',
});

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
});

async function scrapeUrl(url: string) {
  const session = await browserCashClient.browser.session.create();
  if (!session.cdpUrl) throw new Error('No CDP URL returned');

  let browser: any;
  try {
    browser = await chromium.connectOverCDP(session.cdpUrl);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());

    await page.route('**/*', (route: any) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) return route.abort();
      return route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Get HTML and convert to Markdown
    // Using Readability-like strategy often better, but for now simple body extraction
    const content = await page.evaluate(() => {
      // Remove scripts, styles, etc.
      const clone = document.body.cloneNode(true) as HTMLElement;
      const trash = clone.querySelectorAll('script, style, noscript, iframe, svg, footer, nav');
      trash.forEach(el => el.remove());
      return clone.innerHTML;
    });

    const markdown = turndownService.turndown(content);
    const title = await page.title();

    return { url, title, markdown };
  } catch (err) {
    console.error(`[crawl] Failed to scrape ${url}`, err);
    return { url, error: String(err) };
  } finally {
    try { await browser?.close(); } catch {}
    try { await browserCashClient.browser.session.stop({ sessionId: session.sessionId }); } catch {}
  }
}

export async function registerCrawlRoutes(app: FastifyInstance) {
  app.post('/crawl', async (req, reply) => {
    const body = (await req.body) as any;
    const q = (body?.q || '').toString().trim();
    const count = Math.max(1, Math.min(5, Number(body?.count ?? 3))); // Limit to 5 for demo

    if (!q) return reply.status(400).send({ error: 'q_required' });

    try {
      // 1. Get URLs from SERP
      const serpResults = await runSerpQuery(q, count);
      const urls = serpResults.map((r: any) => r.url).filter((u: any) => u && u.startsWith('http'));

      // 2. Scrape URLs in parallel
      const results = await Promise.all(urls.map((url: string) => scrapeUrl(url)));

      return reply.send({ query: q, results });
    } catch (err) {
      console.error('[crawl] error:', err);
      return reply.status(500).send({
        error: 'crawl_failed',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  });
}

