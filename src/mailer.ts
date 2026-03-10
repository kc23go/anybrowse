/**
 * mailer.ts — anybrowse transactional email via Resend
 *
 * Sends email via Resend REST API (https://resend.com).
 * No SMTP, no Gmail — clean REST with hello@anybrowse.dev as the sender.
 *
 * Setup (one-time, KC must do this):
 *   1. Sign up at https://resend.com/signup
 *   2. Add domain: anybrowse.dev
 *   3. Add DKIM DNS records in Namecheap (Resend provides 3 TXT records)
 *   4. Generate API key (starts with re_...)
 *   5. Set RESEND_API_KEY in production-env
 *
 * Env vars:
 *   RESEND_API_KEY  — API key from resend.com (required for sending)
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = "hello@anybrowse.dev";
const FROM_NAME = "anybrowse";

// Whether the mailer is configured
export function isMailerEnabled(): boolean {
  return !!(RESEND_API_KEY && !RESEND_API_KEY.startsWith("re_placeholder"));
}

/**
 * Send a plain-text + optional HTML email via Resend API.
 * Returns a Promise that resolves/rejects (index.ts uses .catch() on it).
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  if (!isMailerEnabled()) {
    console.log(`[mailer] RESEND_API_KEY not set — skipping email to ${opts.to}`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`[mailer] Resend error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as { id: string };
  console.log(`[mailer] Email sent via Resend: ${data.id} → ${opts.to}`);
}

/**
 * Convenience: send the standard API key delivery email.
 * Returns true on success, false on failure.
 */
export async function sendApiKeyEmail(
  email: string,
  apiKey: string,
  credits: number,
): Promise<boolean> {
  try {
    await sendEmail({
      to: email,
      subject: "Your anybrowse API key is ready",
      text: `Your API key: ${apiKey}

This gives you ${credits.toLocaleString()} scrapes.

curl -X POST https://anybrowse.dev/scrape \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com"}'

Check balance: https://anybrowse.dev/credits/balance?key=${apiKey}
Dashboard: https://anybrowse.dev/dashboard

Questions? Reply to this email.

anybrowse.dev`,
      html: `<div style="font-family:Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:2rem;background:#f4f0eb;color:#1a1a1a">
<h2 style="color:#d94400;margin-bottom:0.5rem">Your API key is ready!</h2>
<div style="background:#fff;border:2px solid #d94400;border-radius:8px;padding:1.25rem;margin:1.5rem 0">
  <div style="font-size:0.65rem;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#767676;margin-bottom:0.5rem">YOUR API KEY</div>
  <code style="font-family:monospace;font-size:1rem;word-break:break-all;font-weight:600">${apiKey}</code>
</div>
<p style="color:#555"><strong>${credits.toLocaleString()} credits</strong> loaded. 1 credit = 1 scrape. Credits never expire.</p>
<p><a href="https://anybrowse.dev/credits/balance?key=${apiKey}" style="color:#d94400">Check balance</a> &middot; <a href="https://anybrowse.dev/dashboard" style="color:#d94400">Dashboard</a></p>
<p style="font-size:0.85rem;color:#999">Questions? Reply to this email.</p>
</div>`,
    });
    return true;
  } catch (err: any) {
    console.error("[mailer] sendApiKeyEmail failed:", err.message);
    return false;
  }
}

// ── Lead email lookup by IP hash ─────────────────────────────────────────────

const LEADS_FILE = "/agent/data/leads.csv";

/**
 * Compute the same 8-char ip_hash used in request logging.
 */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 8);
}

/**
 * Look up an email address for a given IP hash from leads.csv.
 * Returns null if not found or file doesn't exist.
 *
 * leads.csv format: timestamp,email,source[,ip_hash]
 * Only rows with a matching ip_hash (4th column) are considered.
 */
export function lookupEmailByIpHash(ipHash: string): string | null {
  try {
    if (!existsSync(LEADS_FILE)) return null;
    const content = readFileSync(LEADS_FILE, "utf-8");
    const lines = content.split("\n");
    // Scan from most recent (bottom) upward
    for (let i = lines.length - 1; i >= 1; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(",");
      if (parts.length >= 4) {
        const rowIpHash = parts[3].trim();
        const email = parts[1].trim();
        if (rowIpHash === ipHash && email && email.includes("@")) {
          return email;
        }
      }
    }
    return null;
  } catch (err: any) {
    console.error("[mailer] Failed to read leads.csv:", err.message);
    return null;
  }
}

// ── Recovery email templates ─────────────────────────────────────────────────

export function buildPaymentRecoveryEmail(error: string): { subject: string; text: string; html: string } {
  const subject = "Your anybrowse payment didn't go through — here's the fix";

  const text = `Hi,

Your last anybrowse payment attempt failed with this error:

  "${error}"

The most common cause: the X-PAYMENT header was constructed manually.
This header requires EIP-712 signing and a specific JSON structure — it's complex to build by hand.

THE FIX: Use the x402 client library instead.

  npm install x402

  import { wrapFetch } from 'x402/client';
  import { createWallet } from '@coinbase/agentkit';

  const wallet = await createWallet();
  const fetch402 = wrapFetch(fetch, wallet);

  // This handles payment automatically — no X-PAYMENT header needed
  const response = await fetch402('https://anybrowse.dev/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' })
  });
  const { markdown } = await response.json();

Full documentation with working examples:
  https://anybrowse.dev/docs/x402?retry=1

Try again:
  https://anybrowse.dev/docs/x402?retry=1

Questions? Reply to this email.

— anybrowse
`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body{font-family:"Helvetica Neue",Helvetica,sans-serif;background:#f4f0eb;color:#1a1a1a;margin:0;padding:20px}
.wrap{max-width:580px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e0dcd7}
.header{background:#1a1a1a;padding:20px 28px;display:flex;align-items:center;gap:12px}
.header-title{color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.02em}
.header-sub{color:#ff6b35;font-size:12px;font-weight:400;margin-top:2px}
.body{padding:28px}
h2{font-size:20px;font-weight:800;color:#1a1a1a;margin:0 0 8px}
p{color:#555;font-size:14px;line-height:1.6;margin:0 0 16px}
.error-box{background:#fff5f5;border:1px solid #fca5a5;border-radius:6px;padding:12px 16px;font-family:monospace;font-size:13px;color:#dc2626;margin:0 0 20px}
pre{background:#1a1a1a;color:#f4f0eb;border-radius:6px;padding:16px 18px;font-family:"SF Mono",monospace;font-size:12px;line-height:1.6;margin:0 0 16px;overflow-x:auto;white-space:pre-wrap}
.highlight{color:#ff6b35}
.btn{display:inline-block;background:#d94400;color:#fff;text-decoration:none;padding:10px 20px;border-radius:5px;font-size:14px;font-weight:600;margin:8px 0 20px}
.footer{background:#f4f0eb;padding:16px 28px;font-size:12px;color:#999;border-top:1px solid #e0dcd7}
</style></head>
<body>
<div class="wrap">
  <div class="header">
    <div>
      <div class="header-title">anybrowse</div>
      <div class="header-sub">Payment Recovery</div>
    </div>
  </div>
  <div class="body">
    <h2>Payment didn't go through</h2>
    <p>Your payment attempt failed with this error:</p>
    <div class="error-box">${error.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
    <p><strong>The most common cause:</strong> the <code>X-PAYMENT</code> header was constructed manually. This requires EIP-712 signing and specific JSON encoding — it's complex to build by hand.</p>
    <p><strong>The fix:</strong> Use the <code>x402</code> npm package — it handles payment signing automatically.</p>
    <pre><span class="highlight">// 1. Install</span>
npm install x402

<span class="highlight">// 2. Wrap fetch with your wallet</span>
import { wrapFetch } from 'x402/client';
import { createWallet } from '@coinbase/agentkit';

const wallet = await createWallet();
const fetch402 = wrapFetch(fetch, wallet);

<span class="highlight">// 3. Make requests — payment is automatic</span>
const response = await fetch402('https://anybrowse.dev/scrape', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://example.com' })
});
const { markdown } = await response.json();</pre>
    <a href="https://anybrowse.dev/docs/x402?retry=1" class="btn">View full guide &amp; retry →</a>
    <p style="font-size:13px;color:#999">Questions? Reply to this email and we'll help you get set up.</p>
  </div>
  <div class="footer">anybrowse.dev · <a href="https://anybrowse.dev/docs/x402" style="color:#767676">x402 docs</a></div>
</div>
</body>
</html>`;

  return { subject, text, html };
}
