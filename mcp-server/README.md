# @anybrowse/mcp-server

MCP server for [anybrowse](https://anybrowse.dev) — web scraping, crawling, and search via a simple API.

## Quick Start (Zero Setup)

anybrowse has a built-in MCP endpoint. Just add this to your MCP client config:

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

**That is it.** No API key needed. Free tier: 5 requests/min, 100 requests/day.

Works with Claude Code, Cursor, Windsurf, and any MCP-compatible client.

---

## Self-Hosted Option

Clone and run this template if you want to:

- Add custom logic, caching, or middleware
- Remove rate limits via x402 payments
- Run behind your own infrastructure

### Install

```bash
npm install
npm run build
```

### Configure

| Variable | Description | Default |
|----------|-------------|---------|
| `ANYBROWSE_API_URL` | API base URL | `https://anybrowse.dev` |
| `ANYBROWSE_API_KEY` | API key (optional, for paid tiers) | — |

### Run

```bash
npm start
```

### Add to MCP Client

Claude Code (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "anybrowse": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": {
        "ANYBROWSE_API_KEY": "your-key-here"
      }
    }
  }
}
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "anybrowse": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"]
    }
  }
}
```

---

## Tools

### `scrape`

Convert a URL to clean Markdown.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | URL to scrape |
| `format` | string | no | `markdown` (default), `text`, or `html` |

### `crawl`

Search Google for a query, then scrape each result page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `maxResults` | number | no | Results to scrape (default: 3, max: 10) |
| `format` | string | no | `markdown` (default), `text`, or `html` |

### `search`

Search Google and return structured results (no scraping).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `maxResults` | number | no | Results to return (default: 5, max: 20) |

---

## License

MIT
