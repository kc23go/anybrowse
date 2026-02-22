# Anybrowse Python SDK

Minimal Python client for the [Anybrowse](https://anybrowse.dev) web scraping and search API.

Paid endpoints use **x402 micropayments** (USDC on Base). You can use the SDK without a wallet — you will just receive the 402 payment info instead of content.

## Installation

```bash
# Basic (no payment support)
pip install .

# With x402 payment support
pip install ".[payment]"
```

## Quick Start

### Without Payment (inspect 402 requirements)

```python
from anybrowse import AnybrowseClient

client = AnybrowseClient()

# Returns payment_required info since no wallet is configured
result = client.scrape("https://example.com")
print(result)
# {"error": "payment_required", "status": 402, "payment_info": {...}}
```

### With x402 Payment

```python
from anybrowse import AnybrowseClient

client = AnybrowseClient(private_key="0xYOUR_PRIVATE_KEY")

# Scrape a page
page = client.scrape("https://example.com")
print(page["title"])
print(page["markdown"][:200])

# Search the web (SERP only, no scraping)
results = client.search("python web scraping", count=5)
for r in results["results"]:
    print(f"{r[title]} - {r[url]}")

# Crawl: search + scrape multiple pages
data = client.crawl("latest AI news", count=3)
for page in data["results"]:
    print(f"{page[title]}: {len(page[markdown])} chars")
```

## API Reference

### `AnybrowseClient(base_url, private_key, timeout)`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `base_url` | `str` | `https://anybrowse.dev` | API base URL |
| `private_key` | `str \| None` | `None` | Hex-encoded Ethereum private key for x402 payments |
| `timeout` | `int` | `30` | Request timeout in seconds |

### Methods

#### `scrape(url) -> dict`

Scrape a single URL. Returns `{url, title, markdown, status}`.

#### `crawl(query, count=3) -> dict`

Search and scrape multiple pages. Returns `{query, results: [{url, title, markdown, status}]}`.

#### `search(query, count=5) -> dict`

SERP search (no scraping). Returns `{results: [{url, title, description}]}`.

## x402 Payment Flow

1. Client sends request to paid endpoint
2. Server returns `402` with payment requirements (amount, asset, payee)
3. SDK signs an EIP-712 `TransferWithAuthorization` for USDC on Base
4. SDK retries request with `X-PAYMENT` header containing the signed payload
5. Server verifies payment via Coinbase facilitator and returns content

**Network:** Base (chain ID 8453)
**Asset:** USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
**Facilitator:** Coinbase (`https://api.cdp.coinbase.com/platform/v2/x402`)

## Examples

See the `examples/` directory:

- `basic_scrape.py` — Simple scrape without payment
- `search_and_crawl.py` — Search then crawl workflow
- `with_payment.py` — Full x402 payment flow

## License

MIT
