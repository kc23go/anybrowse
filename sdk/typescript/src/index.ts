// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScrapeRequest {
  url: string;
}

export interface ScrapeResult {
  url: string;
  title: string;
  markdown: string;
  status: number;
}

export interface CrawlRequest {
  q: string;
  count?: number;
}

export interface CrawlResultItem {
  url: string;
  title: string;
  markdown: string;
  status: number;
}

export interface CrawlResult {
  query: string;
  results: CrawlResultItem[];
}

export interface SearchRequest {
  q: string;
  count?: number;
}

export interface SearchResultItem {
  url: string;
  title: string;
  description: string;
}

export interface SearchResult {
  results: SearchResultItem[];
}

export interface X402PaymentConfig {
  /** Wallet private key for signing USDC payments on Base */
  privateKey: string;
}

export interface AnybrowseClientOptions {
  /** Base URL of the Anybrowse API. Defaults to https://anybrowse.dev */
  baseUrl?: string;
  /** x402 payment configuration for paid endpoints */
  payment?: X402PaymentConfig;
  /** Custom headers to include with every request */
  headers?: Record<string, string>;
}

// ─── x402 Constants ──────────────────────────────────────────────────────────

const X402_NETWORK = {
  chainId: 8453,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  payTo: "0x8D76E8FB38541d70dF74b14660c39b4c5d737088",
} as const;

// ─── Errors ──────────────────────────────────────────────────────────────────

export class AnybrowseError extends Error {
  public readonly status: number;
  public readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "AnybrowseError";
    this.status = status;
    this.body = body;
  }
}

export class PaymentRequiredError extends AnybrowseError {
  public readonly paymentDetails: unknown;

  constructor(message: string, paymentDetails?: unknown) {
    super(message, 402, paymentDetails);
    this.name = "PaymentRequiredError";
    this.paymentDetails = paymentDetails;
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class AnybrowseClient {
  private readonly baseUrl: string;
  private readonly payment?: X402PaymentConfig;
  private readonly headers: Record<string, string>;

  constructor(options: AnybrowseClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://anybrowse.dev").replace(/\/+$/, "");
    this.payment = options.payment;
    this.headers = options.headers ?? {};
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Scrape a single URL and return its content as markdown.
   */
  async scrape(url: string): Promise<ScrapeResult> {
    const body: ScrapeRequest = { url };
    return this.post<ScrapeResult>("/scrape", body);
  }

  /**
   * Crawl the web for a query and return multiple pages as markdown.
   * @param query  Search query
   * @param count  Number of results (default: 3)
   */
  async crawl(query: string, count?: number): Promise<CrawlResult> {
    const body: CrawlRequest = { q: query, ...(count !== undefined && { count }) };
    return this.post<CrawlResult>("/crawl", body);
  }

  /**
   * Search the web (SERP) and return lightweight result snippets.
   * @param query  Search query
   * @param count  Number of results (default: 5)
   */
  async search(query: string, count?: number): Promise<SearchResult> {
    const body: SearchRequest = { q: query, ...(count !== undefined && { count }) };
    return this.post<SearchResult>("/serp/search", body);
  }

  // ── Network helpers ──────────────────────────────────────────────────────

  /**
   * Returns the x402 payment network constants used by paid endpoints.
   */
  static get paymentNetwork() {
    return { ...X402_NETWORK };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headers,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    // x402 Payment Required — the server demands a micropayment
    if (response.status === 402) {
      const details = await this.safeJson(response);
      throw new PaymentRequiredError(
        `Payment required for ${path}. Configure x402 payment or use a payment-enabled client.`,
        details,
      );
    }

    if (!response.ok) {
      const details = await this.safeJson(response);
      throw new AnybrowseError(
        `Request to ${path} failed with status ${response.status}`,
        response.status,
        details,
      );
    }

    return (await response.json()) as T;
  }

  private async safeJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
}

// ── Default export ───────────────────────────────────────────────────────────

export default AnybrowseClient;
