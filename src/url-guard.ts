import { resolve } from "dns/promises";

/**
 * SSRF protection: block requests to internal/private/reserved IPs and cloud metadata.
 * Must be called before page.goto() or any fetch to user-supplied URLs.
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
 * Check if an IP is in a private/reserved range
 */
function isPrivateIP(ip: string): boolean {
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
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fe80:")) return true;
  if (ip.startsWith("fc00:") || ip.startsWith("fd")) return true;

  return false;
}

/**
 * Validate a URL is safe to scrape (not targeting internal resources).
 * Resolves the hostname to check the actual IP.
 * Throws an error if the URL is blocked.
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

  // Check against blocked hostnames
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`Blocked host: ${hostname}`);
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
