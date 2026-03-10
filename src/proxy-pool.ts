// proxy-pool.ts
// Manages US + DE proxy pools with round-robin rotation
// Loads proxy data from proxies.json (excluded from git)

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export interface Proxy {
  host: string;
  port: number;
  user: string;
  pass: string;
  country: 'US' | 'DE';
}

interface ProxyData {
  us: Proxy[];
  de: Proxy[];
}

// Load proxy data from proxies.json (sibling file, excluded from git)
function loadProxies(): ProxyData {
  try {
    return require('./proxies.json') as ProxyData;
  } catch {
    console.warn('[proxy-pool] proxies.json not found — using hardcoded fallback DE proxies');
    return {
      us: [],
      de: [
        { host: '95.134.166.82',  port: 12323, user: '14a3696c76e38', pass: 'a7b82257a0', country: 'DE' },
        { host: '95.134.166.221', port: 12323, user: '14a3696c76e38', pass: 'a7b82257a0', country: 'DE' },
        { host: '95.134.166.36',  port: 12323, user: '14a3696c76e38', pass: 'a7b82257a0', country: 'DE' },
        { host: '95.134.166.225', port: 12323, user: '14a3696c76e38', pass: 'a7b82257a0', country: 'DE' },
        { host: '95.134.167.6',   port: 12323, user: '14a3696c76e38', pass: 'a7b82257a0', country: 'DE' },
      ],
    };
  }
}

const proxyData = loadProxies();

const US_POOL: Proxy[] = proxyData.us;
const DE_POOL: Proxy[] = proxyData.de;

let usIndex = 0;
let deIndex = 0;

/**
 * Returns proxy URL string: http://user:pass@host:port
 */
export function getProxyUrl(proxy: Proxy): string {
  return `http://${proxy.user}:${proxy.pass}@${proxy.host}:${proxy.port}`;
}

/**
 * Returns next US proxy (round-robin).
 * Falls back to a DE proxy if no US proxies are configured.
 */
export function getUsProxy(): Proxy {
  if (US_POOL.length > 0) {
    const proxy = US_POOL[usIndex % US_POOL.length];
    usIndex++;
    return proxy;
  }
  // Fallback: no US proxies, use DE
  console.warn('[proxy-pool] No US proxies configured — falling back to DE proxy');
  return getDeProxy();
}

/**
 * Returns next DE proxy (round-robin).
 * Falls back to a US proxy if no DE proxies are configured.
 */
export function getDeProxy(): Proxy {
  if (DE_POOL.length > 0) {
    const proxy = DE_POOL[deIndex % DE_POOL.length];
    deIndex++;
    return proxy;
  }
  // Fallback: no DE proxies, use US
  if (US_POOL.length > 0) {
    console.warn('[proxy-pool] No DE proxies configured — falling back to US proxy');
    const proxy = US_POOL[usIndex % US_POOL.length];
    usIndex++;
    return proxy;
  }
  throw new Error('[proxy-pool] No proxies configured in either US or DE pool');
}

/**
 * Smart selection: use DE proxy for .de / .eu / .at / .ch domains,
 * US proxy for .com / .us / .net / .org / .io and everything else.
 * Falls back gracefully if the preferred pool is empty.
 */
export function getProxyForUrl(url: string): Proxy {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const isDeTarget =
      hostname.endsWith('.de') ||
      hostname.endsWith('.eu') ||
      hostname.endsWith('.at') ||
      hostname.endsWith('.ch');

    if (isDeTarget && DE_POOL.length > 0) return getDeProxy();
    if (!isDeTarget && US_POOL.length > 0) return getUsProxy();
    // Cross-pool fallback
    if (DE_POOL.length > 0) return getDeProxy();
    return getUsProxy();
  } catch {
    // Unparseable URL — default to US, then DE
    if (US_POOL.length > 0) return getUsProxy();
    return getDeProxy();
  }
}

/**
 * Pool sizes (for diagnostics)
 */
export function getPoolSizes(): { us: number; de: number } {
  return { us: US_POOL.length, de: DE_POOL.length };
}
