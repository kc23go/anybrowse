# anybrowse

**Convert any URL to clean, LLM-ready Markdown.**

Real Chrome browsers with full JavaScript rendering. Pay per request with USDC on Base via [x402](https://www.x402.org/) — no API key, no signup.

## MCP Server (Free)

Connect any MCP-compatible client to `https://anybrowse.dev/mcp` (Streamable HTTP transport).

**Quick config for Claude Desktop / Cline / Cursor:**

```json
{
  "mcpServers": {
    "anybrowse": {
      "url": "https://anybrowse.dev/mcp"
    }
  }
}
```

### Tools

| Tool | Description |
|------|-------------|
| `scrape` | Convert any URL to clean, LLM-optimized Markdown. Handles SPAs, dynamic content, and PDFs. |
| `crawl` | Search Google for a query and scrape the top results to Markdown. |
| `search` | Google search results as structured JSON (titles, URLs, snippets). |

## HTTP API (x402 Pay-Per-Use)

| Endpoint | Price | Description |
|----------|-------|-------------|
| `POST /scrape` | $0.003 USDC | URL → Markdown |
| `POST /crawl` | $0.005 USDC | Search + scrape top results |
| `POST /serp/search` | $0.002 USDC | Google SERP as JSON |

### Example

```bash
curl -X POST https://anybrowse.dev/scrape \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <x402_payment_proof>" \
  -d '{"url": "https://example.com"}'
```

Response:
```json
{
  "url": "https://example.com",
  "title": "Example Domain",
  "markdown": "# Example Domain\n\nThis domain is for use in illustrative examples...",
  "status": "ok"
}
```

## Payment

Payments use the [x402 protocol](https://www.x402.org/) with USDC on Base. Any x402-compatible client or agent wallet can pay automatically. The facilitator is Coinbase CDP (`https://api.cdp.coinbase.com/platform/v2/x402`).

No API key. No signup. No rate limits beyond what you pay for.

## Discovery

- **Agent card**: [https://anybrowse.dev/.well-known/agent-card.json](https://anybrowse.dev/.well-known/agent-card.json)
- **OpenAPI spec**: [https://anybrowse.dev/openapi.json](https://anybrowse.dev/openapi.json)
- **x402 discovery**: [https://anybrowse.dev/.well-known/x402](https://anybrowse.dev/.well-known/x402)
- **Health**: [https://anybrowse.dev/health](https://anybrowse.dev/health)

## Links

- **Website**: [https://anybrowse.dev](https://anybrowse.dev)
- **MCP endpoint**: `https://anybrowse.dev/mcp`
- **Protocols**: A2A, x402, MCP
- **Network**: Base (USDC)
- **Wallet**: `0x8D76E8FB38541d70dF74b14660c39b4c5d737088`
