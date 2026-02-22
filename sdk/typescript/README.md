# @anybrowse/sdk

TypeScript SDK for the [Anybrowse](https://anybrowse.dev) web scraping, crawling, and search API.

Paid endpoints (`/scrape`, `/crawl`, `/serp/search`) use **x402 micropayments** (USDC on Base).  
The MCP endpoint (`/mcp`) is free.

## Installation

```bash
npm install @anybrowse/sdk
```

> Requires Node.js 18+ (uses native `fetch`).

## Quick Start

```typescript
import { AnybrowseClient } from "@anybrowse/sdk";

const client = new AnybrowseClient();

// Scrape a page
const page = await client.scrape("https://example.com");
console.log(page.title);
console.log(page.markdown);

// Crawl for a topic
const crawl = await client.crawl("typescript best practices", 3);
for (const result of crawl.results) {
  console.log(`${result.title} — ${result.url}`);
}

// SERP search
const serp = await client.search("anybrowse api", 5);
for (const result of serp.results) {
  console.log(`${result.title}: ${result.description}`);
}
```

## API Reference

### `new AnybrowseClient(options?)`

| Option      | Type                  | Default                   | Description                             |
|-------------|-----------------------|---------------------------|-----------------------------------------|
| `baseUrl`   | `string`              | `https://anybrowse.dev`   | API base URL                            |
| `payment`   | `X402PaymentConfig`   | —                         | x402 payment config (wallet private key)|
| `headers`   | `Record<string,string>` | —                       | Custom headers for every request        |

### Methods

#### `scrape(url: string): Promise<ScrapeResult>`

Scrape a single URL and return its content as markdown.

```typescript
interface ScrapeResult {
  url: string;
  title: string;
  markdown: string;
  status: number;
}
```

#### `crawl(query: string, count?: number): Promise<CrawlResult>`

Search and scrape multiple pages. Default count is 3.

```typescript
interface CrawlResult {
  query: string;
  results: Array<{
    url: string;
    title: string;
    markdown: string;
    status: number;
  }>;
}
```

#### `search(query: string, count?: number): Promise<SearchResult>`

Lightweight SERP search returning snippets. Default count is 5.

```typescript
interface SearchResult {
  results: Array<{
    url: string;
    title: string;
    description: string;
  }>;
}
```

### Static Properties

#### `AnybrowseClient.paymentNetwork`

Returns the x402 payment network constants:

```typescript
{
  chainId: 8453,                                          // Base
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",   // USDC
  payTo: "0x8D76E8FB38541d70dF74b14660c39b4c5d737088",   // Recipient
}
```

## x402 Payments

Paid endpoints return HTTP `402 Payment Required` when a micropayment is needed. The SDK throws a `PaymentRequiredError` with the server-provided payment details.

```typescript
import { AnybrowseClient, PaymentRequiredError } from "@anybrowse/sdk";

const client = new AnybrowseClient();

try {
  const result = await client.scrape("https://example.com");
} catch (err) {
  if (err instanceof PaymentRequiredError) {
    console.log("Payment required:", err.paymentDetails);
    // Sign and submit payment, then retry
  }
}
```

See `examples/with-payment.ts` for a full payment flow example.

## Error Handling

| Error Class            | HTTP Status | When                       |
|------------------------|-------------|----------------------------|
| `PaymentRequiredError` | 402         | x402 micropayment needed   |
| `AnybrowseError`       | any         | Any other non-2xx response |

Both error classes expose `.status` and `.body` properties.

## License

MIT
