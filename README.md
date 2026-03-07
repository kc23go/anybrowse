# anybrowse

**URL → Clean Markdown. For AI agents.**

anybrowse.dev converts any URL to LLM-ready Markdown. Built for AI agents, MCP clients, and developers who need reliable web content extraction.

## Why anybrowse?

- **84% scrape success rate** — including Cloudflare-protected sites, JavaScript SPAs, government portals
- **Real-time web search** — powered by Brave Search API, not browser-based scraping
- **MCP-native** — works directly in Claude Code, Cursor, Windsurf with zero config
- **Pay as you go** — 10 free scrapes/day. Credit packs from $5. No subscription required.
- **CAPTCHA solving** — automatic reCAPTCHA and Cloudflare Turnstile solving

## Quick Start

### MCP (Claude Code, Cursor, Windsurf)

Add to your MCP config:

```json
{
  "mcpServers": {
    "anybrowse": {
      "type": "streamable-http",
      "url": "https://anybrowse.dev/mcp"
    }
  }
}
```

Then ask your agent: "Scrape https://techcrunch.com and summarize the top stories"

### REST API

```bash
curl -X POST https://anybrowse.dev/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://techcrunch.com"}'
```

### Python SDK

```bash
pip install anybrowse
```

```python
from anybrowse import AnybrowseClient
client = AnybrowseClient()
result = client.scrape("https://techcrunch.com")
print(result.markdown)
```

### JavaScript/TypeScript

```bash
npm install anybrowse
```

```typescript
import { AnybrowseClient } from 'anybrowse';
const client = new AnybrowseClient();
const result = await client.scrape('https://techcrunch.com');
```

## Endpoints

| Endpoint | Description | Price |
|----------|-------------|-------|
| POST /scrape | URL → Markdown | $0.002/call |
| POST /crawl | Multi-page crawl | $0.01/call |
| POST /search | Web search → Markdown | $0.002/call |
| POST /extract | Structured data extraction | $0.01/call |
| POST /batch | Up to 10 URLs parallel | $0.002/URL |

## Pricing

- **Free**: 10 scrapes/day, no API key needed
- **Credit packs**: $5 (3k scrapes) / $20 (15k scrapes) / $50 (50k scrapes)
- **Pro**: $4.99/month, unlimited
- **x402**: Pay per request with USDC on Base (AI agents with wallets)

## Links

- [Docs](https://anybrowse.dev/docs)
- [Pricing](https://anybrowse.dev/pricing)
- [Integrations](https://anybrowse.dev/integrations)
- [MCP Config](https://anybrowse.dev/docs#mcp)
- [x402 Payment Guide](https://anybrowse.dev/docs/x402)

## Tech

Node.js + TypeScript + Fastify + Playwright + SQLite. Deployed on VPS with pm2.

Open source under MIT license.
