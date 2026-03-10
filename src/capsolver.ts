/**
 * capsolver.ts — Unified CAPTCHA solving via CapSolver API
 * Supports: reCAPTCHA v2, hCaptcha, Cloudflare Turnstile, Walmart/DataDome
 *
 * Set CAPSOLVER_KEY env var (or it falls back to the hardcoded key below).
 */

const CAPSOLVER_KEY = process.env.CAPSOLVER_KEY || '';
const CAPSOLVER_API = 'https://api.capsolver.com';

interface CaptchaTask {
  type: string;
  websiteURL: string;
  websiteKey?: string;
  [key: string]: any;
}

async function createTask(task: CaptchaTask): Promise<string | null> {
  if (!CAPSOLVER_KEY) return null;
  try {
    const resp = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY, task }),
    });
    const data = await resp.json() as any;
    if (data.errorId) {
      console.error('[capsolver] createTask error:', data.errorDescription);
      return null;
    }
    return data.taskId;
  } catch (e: any) {
    console.error('[capsolver] createTask failed:', e.message);
    return null;
  }
}

async function getTaskResult(taskId: string, maxWait = 60000): Promise<any | null> {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const resp = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId }),
      });
      const data = await resp.json() as any;
      if (data.status === 'ready') return data.solution;
      if (data.errorId) {
        console.error('[capsolver] task error:', data.errorDescription);
        return null;
      }
    } catch (e: any) {
      console.error('[capsolver] poll failed:', e.message);
      return null;
    }
  }
  console.warn('[capsolver] task timed out:', taskId);
  return null;
}

/**
 * Detect CAPTCHA type from page HTML content.
 * Returns the type string or null if no CAPTCHA detected.
 */
export function detectCaptchaType(html: string): 'recaptcha' | 'hcaptcha' | 'turnstile' | 'walmart' | null {
  if (html.includes('www.google.com/recaptcha') || html.includes('grecaptcha')) return 'recaptcha';
  if (html.includes('hcaptcha.com') || html.includes('h-captcha')) return 'hcaptcha';
  if (html.includes('challenges.cloudflare.com') || html.includes('cf-turnstile')) return 'turnstile';
  if (
    html.includes('Activate and hold the button') ||
    html.includes('are you a robot') ||
    html.includes('Robot or human') ||
    html.includes('captcha-delivery.com') ||
    html.includes('datadome')
  ) return 'walmart';
  return null;
}

/**
 * Extract sitekey from page HTML for reCAPTCHA/hCaptcha/Turnstile.
 */
function extractSiteKey(html: string, type: string): string | null {
  const patterns: Record<string, RegExp[]> = {
    recaptcha: [/data-sitekey="([^"]+)"/, /['"](6[A-Za-z0-9_-]{38})['"]/],
    hcaptcha:  [/data-sitekey="([^"]+)"/, /sitekey:\s*['"]([^'"]+)['"]/],
    turnstile: [/data-sitekey="([^"]+)"/],
  };
  for (const pattern of (patterns[type] || [])) {
    const m = html.match(pattern);
    if (m) return m[1];
  }
  return null;
}

/**
 * Attempt to solve a CAPTCHA on a live Playwright page.
 * Returns true if the CAPTCHA was solved and the page reloaded, false otherwise.
 *
 * @param page  Playwright Page object
 * @param url   Current page URL
 */
export async function solveCaptchaOnPage(page: any, url: string): Promise<boolean> {
  if (!CAPSOLVER_KEY) {
    console.warn('[capsolver] CAPSOLVER_KEY not set — skipping solve');
    return false;
  }

  const html = await page.content().catch(() => '');
  const type = detectCaptchaType(html);
  if (!type) return false;

  console.log(`[capsolver] Detected ${type} CAPTCHA on ${url}`);

  // ── Walmart / DataDome ──────────────────────────────────────────────────
  if (type === 'walmart') {
    // Extract DataDome captcha URL from the page
    const captchaUrlMatch = html.match(/https:\/\/geo\.captcha-delivery\.com[^"']*/);
    if (!captchaUrlMatch) {
      console.warn('[capsolver] Walmart/DataDome: no captcha-delivery URL found, skipping');
      return false;
    }
    const taskId = await createTask({
      type: 'DatadomeSliderTask',
      websiteURL: url,
      captchaUrl: captchaUrlMatch[0],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      proxy: '',
    });
    if (!taskId) return false;
    const solution = await getTaskResult(taskId);
    if (!solution?.cookie) {
      console.warn('[capsolver] Walmart/DataDome: no cookie in solution');
      return false;
    }
    // Inject the DataDome cookie
    try {
      const domain = new URL(url).hostname;
      await page.context().addCookies([{
        name: 'datadome',
        value: solution.cookie,
        domain: domain.startsWith('.') ? domain : `.${domain}`,
        path: '/',
      }]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      console.log('[capsolver] Walmart/DataDome cookie injected and page reloaded');
      return true;
    } catch (e: any) {
      console.error('[capsolver] Cookie inject failed:', e.message);
      return false;
    }
  }

  // ── reCAPTCHA / hCaptcha / Turnstile ────────────────────────────────────
  const siteKey = extractSiteKey(html, type);
  if (!siteKey) {
    console.warn(`[capsolver] No sitekey found for ${type} on ${url}`);
    return false;
  }

  let taskId: string | null = null;

  if (type === 'recaptcha') {
    taskId = await createTask({
      type: 'ReCaptchaV2TaskProxyless',
      websiteURL: url,
      websiteKey: siteKey,
    });
  } else if (type === 'hcaptcha') {
    taskId = await createTask({
      type: 'HCaptchaTaskProxyless',
      websiteURL: url,
      websiteKey: siteKey,
    });
  } else if (type === 'turnstile') {
    taskId = await createTask({
      type: 'AntiTurnstileTaskProxyless',
      websiteURL: url,
      websiteKey: siteKey,
    });
  }

  if (!taskId) return false;

  const solution = await getTaskResult(taskId);
  if (!solution) return false;

  // Inject token into page and submit
  const token = solution.gRecaptchaResponse || solution.token;
  if (token) {
    await page.evaluate((t: string) => {
      // Inject into hidden textarea (reCAPTCHA / hCaptcha standard)
      const el = document.querySelector(
        '[name="g-recaptcha-response"], [name="h-captcha-response"], #g-recaptcha-response'
      ) as HTMLTextAreaElement | null;
      if (el) {
        el.value = t;
        // Dispatch change event for React-driven forms
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Try to submit the form
      const form = document.querySelector('form');
      if (form) form.submit();
    }, token).catch(() => {});

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    console.log(`[capsolver] ${type} token injected and form submitted`);
  }

  return true;
}
