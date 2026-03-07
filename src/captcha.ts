/**
 * CAPTCHA solving via CapSolver API
 * Supports: reCAPTCHA v2, Cloudflare Turnstile
 * Set CAPSOLVER_KEY env var to enable.
 */

const CAPSOLVER_API = 'https://api.capsolver.com';
const CAPSOLVER_KEY = process.env.CAPSOLVER_KEY || '';

export async function solveRecaptchaV2(pageUrl: string, siteKey: string): Promise<string | null> {
  if (!CAPSOLVER_KEY) return null;
  try {
    // Create task
    const createResp = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: CAPSOLVER_KEY,
        task: { type: 'ReCaptchaV2TaskProxyless', websiteURL: pageUrl, websiteKey: siteKey }
      })
    });
    const { taskId, errorCode } = await createResp.json() as { taskId?: string; errorCode?: string };
    if (errorCode || !taskId) return null;

    // Poll for result (max 60s)
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 2500));
      const pollResp = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId })
      });
      const result = await pollResp.json() as { status?: string; solution?: { gRecaptchaResponse?: string } };
      if (result.status === 'ready') return result.solution?.gRecaptchaResponse || null;
      if (result.status === 'failed') return null;
    }
    return null;
  } catch { return null; }
}

export async function solveTurnstile(pageUrl: string, siteKey: string): Promise<string | null> {
  if (!CAPSOLVER_KEY) return null;
  try {
    const createResp = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: CAPSOLVER_KEY,
        task: { type: 'AntiTurnstileTaskProxyless', websiteURL: pageUrl, websiteKey: siteKey }
      })
    });
    const { taskId, errorCode } = await createResp.json() as { taskId?: string; errorCode?: string };
    if (errorCode || !taskId) return null;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 2500));
      const pollResp = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId })
      });
      const result = await pollResp.json() as { status?: string; solution?: { token?: string } };
      if (result.status === 'ready') return result.solution?.token || null;
      if (result.status === 'failed') return null;
    }
    return null;
  } catch { return null; }
}
