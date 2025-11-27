# Browser.cash Crawler Demo

A minimal, high-performance crawler API powered by [Browser.cash](https://browser.cash).

This project demonstrates two core capabilities:
1.  **SERP Proxy:** Forwards Google search requests to an upstream `browserserp` service.
2.  **Crawler:** Fetches SERP results and then scrapes each page using Browser.cash remote browser sessions (CDP) to convert content to Markdown.

## Features

- **POST /serp/search**: Search Google (via proxy).
- **POST /crawl**: Search + Scrape URLs to Markdown.
- **Zero Persistence**: No database; purely functional endpoints.
- **Remote Browser Isolation**: Each scrape uses a fresh, isolated browser session for maximum stealth.

## Requirements

- Node.js 18+
- A running `browserserp` service on port `8080` (for SERP results).
- A Browser.cash API Key.

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```

2.  Configure environment:
    Create a `.env` file:
    ```bash
    BROWSER_API_KEY=your_key_here
    PORT=8085
    SERP_SERVICE_URL=http://localhost:8080
    ```

3.  Start the server:
    ```bash
    npm run dev
    ```

## API Usage

### 1. Search (SERP)
Returns raw Google search results.

```bash
curl -X POST http://localhost:8085/serp/search \
  -H "Content-Type: application/json" \
  -d '{"q":"browser automation","count":3}'
```

### 2. Crawl (Search + Scrape)
Searches Google, then visits top results and converts them to Markdown.

```bash
curl -X POST http://localhost:8085/crawl \
  -H "Content-Type: application/json" \
  -d '{"q":"browser automation","count":2}'
```

## Architecture

- `src/index.ts`: Fastify server bootstrap.
- `src/serp.ts`: Proxies requests to the upstream SERP service.
- `src/crawl.ts`: Orchestrates the crawl workflow:
  1.  Calls `runSerpQuery`.
  2.  Provisions remote browser sessions via `@browsercash/sdk`.
  3.  Connects via `playwright-core` (CDP).
  4.  Extracts HTML and converts to Markdown with `turndown`.
