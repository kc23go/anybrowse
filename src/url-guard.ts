import { resolve } from "dns/promises";
import type { BrowserContext } from "playwright-core";

/**
 * SSRF protection: block requests to internal/private/reserved IPs and cloud metadata.
 * Two layers:
 *   1. Pre-navigation DNS check (validateUrl) — catches obvious cases
 *   2. Playwright route interception (installSsrfRouteBlock) — catches DNS rebinding + redirects
 */

// Blocked hostname patterns
const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::]",
  "[::1]",
  "metadata.google.internal",
  "metadata.google",
]);

// Cloud metadata IP
const METADATA_IP = "169.254.169.254";

/**
 * Normalize IP representations that could bypass simple string checks:
 * - IPv6-mapped IPv4 (::ffff:127.0.0.1)
 * - Octal (0177.0.0.1)
 * - Hex (0x7f000001)
 * - Decimal (2130706433)
 * Returns the normalized IPv4 string, or the original if not a special encoding.
 */
function normalizeIP(ip: string): string {
  // Strip IPv6-mapped IPv4 prefix
  if (ip.startsWith("::ffff:")) {
    return ip.slice(7);
  }

  // Single decimal number (e.g. 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(ip)) {
    const n = parseInt(ip, 10);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }

  // Single hex number (e.g. 0x7f000001)
  if (/^0x[0-9a-fA-F]+$/.test(ip)) {
    const n = parseInt(ip, 16);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }

  // Octal dotted notation (e.g. 0177.0.0.1)
  if (/^0\d/.test(ip) && ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) {
      const octets = parts.map((p) => parseInt(p, 8));
      if (octets.every((o) => o >= 0 && o <= 255)) {
        return octets.join(".");
      }
    }
  }

  return ip;
}

/**
 * Check if an IP is in a private/reserved range
 */
function isPrivateIP(raw: string): boolean {
  const ip = normalizeIP(raw);

  // IPv4 private ranges
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("0.")) return true;
  if (ip === METADATA_IP) return true;

  // Link-local
  if (ip.startsWith("169.254.")) return true;

  // IPv6 loopback and link-local
  if (raw === "::1" || raw === "::") return true;
  if (raw.startsWith("fe80:")) return true;
  if (raw.startsWith("fc00:") || raw.startsWith("fd")) return true;

  return false;
}

/**
 * Extract hostname from a URL, handling edge cases like credentials in URL.
 */
function safeHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Pre-navigation URL validation.
 * Catches obvious blocked hosts and IP literals.
 * NOTE: This alone is NOT sufficient — DNS rebinding and redirects can bypass it.
 * Always pair with installSsrfRouteBlock().
 */
export async function validateUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block credentials in URL (e.g. http://user@evil.com@127.0.0.1)
  if (parsed.username || parsed.password) {
    throw new Error("URLs with credentials are not allowed");
  }

  // Check against blocked hostnames
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`Blocked host: ${hostname}`);
  }

  // Check normalized IP (catches hex, octal, decimal encodings)
  const normalized = normalizeIP(hostname);
  if (normalized !== hostname && isPrivateIP(normalized)) {
    throw new Error(`Blocked private IP (encoded): ${hostname}`);
  }

  // Block IP literals that are private
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIP(hostname)) {
      throw new Error(`Blocked private IP: ${hostname}`);
    }
    return; // IP literal that's public — OK
  }

  // Resolve hostname and check resolved IPs
  try {
    const addresses = await resolve(hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`Blocked: ${hostname} resolves to private IP ${addr}`);
      }
    }
  } catch (err) {
    // If DNS resolution fails, let the scraper handle it
    if (err instanceof Error && err.message.startsWith("Blocked")) {
      throw err;
    }
    // DNS errors (NXDOMAIN etc.) — let the browser handle it
  }
}

// Track contexts that already have SSRF route blocking installed
const ssrfProtectedContexts = new WeakSet<BrowserContext>();

/**
 * Install Playwright route interception that blocks ALL requests (including redirects)
 * to private/reserved IPs. This catches DNS rebinding and HTTP redirect SSRF bypasses.
 *
 * Call this once per BrowserContext, before any page.goto().
 */
export function installSsrfRouteBlock(context: BrowserContext): void {
  if (ssrfProtectedContexts.has(context)) return;

  context.route("**/*", async (route) => {
    const url = route.request().url();
    const hostname = safeHostname(url);

    if (!hostname) {
      return route.abort("blockedbyclient");
    }

    // Block known bad hostnames
    if (BLOCKED_HOSTS.has(hostname)) {
      console.log(`[url-guard] Route blocked (hostname): ${url}`);
      return route.abort("blockedbyclient");
    }

    // Block private IP literals (including encoded forms)
    const normalized = normalizeIP(hostname);
    if (isPrivateIP(normalized)) {
      console.log(`[url-guard] Route blocked (private IP): ${url}`);
      return route.abort("blockedbyclient");
    }

    // For non-IP hostnames, resolve and check
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
      try {
        const addresses = await resolve(hostname);
        for (const addr of addresses) {
          if (isPrivateIP(addr)) {
            console.log(`[url-guard] Route blocked (DNS resolves to private): ${hostname} -> ${addr}`);
            return route.abort("blockedbyclient");
          }
        }
      } catch {
        // DNS failure — let the request proceed and fail naturally
      }
    }

    return route.continue();
  });

  ssrfProtectedContexts.add(context);
}
