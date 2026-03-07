/**
 * mailer.ts — Lightweight SMTP email sender using Node.js built-in TLS
 *
 * Sends email via Gmail SMTP (smtp.gmail.com:587, STARTTLS).
 * No external dependencies — uses Node's built-in `net` and `tls` modules.
 *
 * Env vars (all optional with defaults):
 *   SMTP_HOST    — default: smtp.gmail.com
 *   SMTP_PORT    — default: 587
 *   SMTP_USER    — Gmail address
 *   SMTP_PASS    — Gmail app password (16 chars, spaces optional)
 *   SMTP_FROM    — From address (defaults to SMTP_USER)
 */

import * as net from "net";
import * as tls from "tls";
import { createReadStream, existsSync, readFileSync } from "fs";
import { createHash } from "crypto";

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = (process.env.SMTP_PASS || "").replace(/\s/g, "");
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

// Whether SMTP is configured
export function isMailerEnabled(): boolean {
  return !!(SMTP_USER && SMTP_PASS);
}

/**
 * Send a plain-text + HTML email via Gmail SMTP STARTTLS.
 * Fires and forgets — rejects are caught and logged, never thrown.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  if (!isMailerEnabled()) {
    console.log(`[mailer] SMTP not configured — skipping email to ${opts.to}`);
    return;
  }

  const { to, subject, text, html } = opts;
  const from = SMTP_FROM;
  const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@anybrowse.dev>`;
  const date = new Date().toUTCString();

  // Build MIME message
  const boundary = `----=_Part_${Date.now().toString(36)}`;
  let message: string;

  if (html) {
    message = [
      `From: anybrowse <${from}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      `Message-ID: ${msgId}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      text,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      html,
      ``,
      `--${boundary}--`,
    ].join("\r\n");
  } else {
    message = [
      `From: anybrowse <${from}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      `Message-ID: ${msgId}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      text,
    ].join("\r\n");
  }

  return new Promise((resolve, reject) => {
    let step = 0;
    let socket: net.Socket | tls.TLSSocket = net.createConnection(SMTP_PORT, SMTP_HOST);
    let upgraded = false;

    const authPlain = Buffer.from(`\0${SMTP_USER}\0${SMTP_PASS}`).toString("base64");

    const commands = [
      () => write(`EHLO anybrowse.dev\r\n`),
      () => write(`STARTTLS\r\n`),
      () => upgradeTls(),
      () => write(`EHLO anybrowse.dev\r\n`),
      () => write(`AUTH PLAIN ${authPlain}\r\n`),
      () => write(`MAIL FROM:<${from}>\r\n`),
      () => write(`RCPT TO:<${to}>\r\n`),
      () => write(`DATA\r\n`),
      () => write(`${message}\r\n.\r\n`),
      () => write(`QUIT\r\n`),
    ];

    function write(data: string) {
      socket.write(data);
    }

    function upgradeTls() {
      upgraded = true;
      const tlsSocket = tls.connect({ socket: socket as net.Socket, host: SMTP_HOST });
      tlsSocket.on("secure", () => {
        socket = tlsSocket;
        socket.on("data", onData);
        next();
      });
      tlsSocket.on("error", (err) => {
        console.error("[mailer] TLS error:", err.message);
        reject(err);
      });
    }

    function next() {
      if (step < commands.length) {
        commands[step++]();
      }
    }

    function onData(data: Buffer) {
      const response = data.toString();
      const code = parseInt(response.slice(0, 3), 10);

      // After STARTTLS, skip normal flow — TLS upgrade triggers next()
      if (response.includes("220 ") && !upgraded && step === 1) {
        next(); // send EHLO
        return;
      }

      if (code >= 400) {
        const err = new Error(`[mailer] SMTP error ${code}: ${response.trim()}`);
        console.error(err.message);
        socket.destroy();
        reject(err);
        return;
      }

      if (code === 250 || code === 235 || code === 354 || code === 221 || code === 220) {
        // 354 = go ahead with data body, 221 = bye
        if (code === 221) {
          socket.destroy();
          resolve();
          return;
        }
        next();
      }
    }

    socket.on("data", onData);
    socket.on("error", (err) => {
      console.error("[mailer] Socket error:", err.message);
      reject(err);
    });
    socket.on("close", () => {
      if (step < commands.length - 1) {
        // Closed before QUIT — partial send
        reject(new Error("[mailer] Connection closed prematurely"));
      }
    });

    // Increase timeout to 15s
    socket.setTimeout(15_000, () => {
      console.error("[mailer] SMTP timeout");
      socket.destroy();
      reject(new Error("[mailer] SMTP timeout"));
    });
  });
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
