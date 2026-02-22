import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.ANYBROWSE_API_URL || "https://anybrowse.dev";

interface ApiResponse {
  content?: string;
  results?: Array<{ title: string; url: string; snippet: string }>;
  error?: string;
}

async function callApi(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<ApiResponse> {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v \!== undefined) filtered[k] = String(v);
  }

  const url = `${API_BASE}${endpoint}?${new URLSearchParams(filtered)}`;
  const headers: Record<string, string> = { Accept: "application/json" };

  if (process.env.ANYBROWSE_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.ANYBROWSE_API_KEY}`;
  }

  const res = await fetch(url, { headers });

  if (\!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }

  return res.json() as Promise<ApiResponse>;
}

const server = new McpServer({
  name: "anybrowse",
  version: "1.0.0",
});

// --- Tool: scrape ---
server.tool(
  "scrape",
  "Convert a URL to clean Markdown. Extracts the main content from any webpage.",
  {
    url: z.string().url().describe("The URL to scrape"),
    format: z
      .enum(["markdown", "text", "html"])
      .optional()
      .describe("Output format (default: markdown)"),
  },
  async ({ url, format }) => {
    const data = await callApi("/scrape", { url, format });
    return {
      content: [{ type: "text" as const, text: data.content || "" }],
    };
  }
);

// --- Tool: crawl ---
server.tool(
  "crawl",
  "Search Google for a query, then scrape each result page into Markdown. Returns combined content from top results.",
  {
    query: z.string().describe("Search query to find and scrape pages for"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Max results to scrape (default: 3, max: 10)"),
    format: z
      .enum(["markdown", "text", "html"])
      .optional()
      .describe("Output format (default: markdown)"),
  },
  async ({ query, maxResults, format }) => {
    const data = await callApi("/crawl", {
      query,
      maxResults,
      format,
    });
    return {
      content: [{ type: "text" as const, text: data.content || "" }],
    };
  }
);

// --- Tool: search ---
server.tool(
  "search",
  "Search Google and return structured results (title, URL, snippet). Does not scrape the pages.",
  {
    query: z.string().describe("Search query"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Max results to return (default: 5, max: 20)"),
  },
  async ({ query, maxResults }) => {
    const data = await callApi("/search", { query, maxResults });
    const results = data.results || [];
    const formatted = results
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
    return {
      content: [
        {
          type: "text" as const,
          text: formatted || "No results found.",
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("anybrowse MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
