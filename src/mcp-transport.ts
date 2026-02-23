import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { INTERNAL_BYPASS_TOKEN } from "./payment-gate.js";

/**
 * MCP (Model Context Protocol) Streamable HTTP Transport
 *
 * Implements the MCP JSON-RPC 2.0 transport over HTTP POST /mcp
 * Supports: initialize, tools/list, tools/call
 *
 * This lets Claude Code, Cursor, Windsurf, and any MCP-compatible client
 * use anybrowse as a tool directly.
 */

const SERVER_NAME = "anybrowse";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-03-26";

// --- Rate Limiting for Tool Discovery ---
// Prevents enumeration attacks while keeping MCP public
const DISCOVERY_RATE_LIMIT = 10; // requests per minute per IP
const discoveryRateLimits = new Map<string, number[]>();

function checkDiscoveryRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const windowStart = now - 60000; // 1 minute window
  
  let calls = discoveryRateLimits.get(ip) || [];
  calls = calls.filter(t => t > windowStart);
  
  if (calls.length >= DISCOVERY_RATE_LIMIT) {
    const oldest = calls[0];
    return { 
      allowed: false, 
      retryAfter: Math.ceil((oldest + 60000 - now) / 1000)
    };
  }
  
  calls.push(now);
  discoveryRateLimits.set(ip, calls);
  return { allowed: true };
}

// Cleanup old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, calls] of discoveryRateLimits) {
    const recent = calls.filter(t => now - t < 60000);
    if (recent.length === 0) {
      discoveryRateLimits.delete(ip);
    } else {
      discoveryRateLimits.set(ip, recent);
    }
  }
}, 600000);

// --- MCP Rate Limiting ---
// Prevents unlimited free scraping via the MCP endpoint
const MCP_CALLS_PER_MINUTE = 5;
const MCP_CALLS_PER_DAY = 100;
const MCP_WINDOW_MS = 60_000;
const MCP_DAY_MS = 86_400_000;

interface RateLimitEntry {
  calls: number[];
  dailyCalls: number;
  dailyReset: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Clean up stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.dailyReset) {
      rateLimitMap.delete(ip);
    }
  }
}, 600_000);

function checkMcpRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now > entry.dailyReset) {
    entry = { calls: [], dailyCalls: 0, dailyReset: now + MCP_DAY_MS };
    rateLimitMap.set(ip, entry);
  }

  // Remove calls outside the 1-minute window
  entry.calls = entry.calls.filter((t) => now - t < MCP_WINDOW_MS);

  // Check daily limit
  if (entry.dailyCalls >= MCP_CALLS_PER_DAY) {
    return { allowed: false, retryAfter: Math.ceil((entry.dailyReset - now) / 1000) };
  }

  // Check per-minute limit
  if (entry.calls.length >= MCP_CALLS_PER_MINUTE) {
    const oldest = entry.calls[0];
    return { allowed: false, retryAfter: Math.ceil((oldest + MCP_WINDOW_MS - now) / 1000) };
  }

  entry.calls.push(now);
  entry.dailyCalls++;
  return { allowed: true };
}

// --- End Rate Limiting ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: string | number | null;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: string | number | null;
}

const TOOLS = [
  {
    name: "scrape",
    description:
      "Convert any URL to clean, LLM-optimized Markdown. Uses real Chrome browsers with full JavaScript rendering. Handles SPAs, dynamic content, and PDFs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to scrape (must start with http:// or https://)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "crawl",
    description:
      "Search Google for a query and scrape the top results to Markdown. Returns structured results with title, URL, and full page content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        q: {
          type: "string",
          description: "The search query",
        },
        count: {
          type: "number",
          description: "Number of results to scrape (1-20, default 3)",
        },
      },
      required: ["q"],
    },
  },
  {
    name: "search",
    description:
      "Google search results as structured JSON. Returns titles, URLs, and descriptions without scraping the pages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        q: {
          type: "string",
          description: "The search query",
        },
        count: {
          type: "number",
          description: "Number of results (1-20, default 5)",
        },
      },
      required: ["q"],
    },
  },
];

function makeError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", error: { code, message, data }, id };
}

function makeResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", result, id };
}

async function handleRequest(
  rpc: JsonRpcRequest,
  app: FastifyInstance,
  clientIp: string
): Promise<JsonRpcResponse | null> {
  const id = rpc.id ?? null;

  if (rpc.id === undefined || rpc.id === null) {
    return null;
  }

  switch (rpc.method) {
    case "initialize":
      return makeResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });

    case "notifications/initialized":
      return null;

    case "tools/list": {
      // Rate limit tool discovery (not tool calls)
      const rateCheck = checkDiscoveryRateLimit(clientIp);
      if (!rateCheck.allowed) {
        console.log(`[mcp] Discovery rate limited ${clientIp}`);
        return makeError(id, -32000, 
          `Rate limit exceeded for tool discovery. Retry after ${rateCheck.retryAfter}s`, {
          retryAfter: rateCheck.retryAfter
        });
      }
      return makeResult(id, { tools: TOOLS });
    }

    case "tools/call": {
      // Rate limit tool calls (actual scraping) — not metadata requests
      const rateCheck = checkMcpRateLimit(clientIp);
      if (!rateCheck.allowed) {
        console.log(`[mcp] Rate limited ${clientIp} (retry in ${rateCheck.retryAfter}s)`);
        return makeError(id, -32000, "Rate limit exceeded. Use x402 payment endpoints for higher throughput. Retry after " + rateCheck.retryAfter + "s", {
          retryAfter: rateCheck.retryAfter,
          hint: "For unlimited access, use POST /scrape with x402 payment header",
        });
      }

      const params = rpc.params as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (!params?.name) {
        return makeError(id, -32602, "Missing tool name");
      }
      return await executeToolCall(id, params.name, params.arguments ?? {}, app);
    }

    case "ping":
      return makeResult(id, {});

    default:
      return makeError(id, -32601, "Method not found: " + rpc.method);
  }
}

async function executeToolCall(
  id: string | number | null,
  toolName: string,
  args: Record<string, unknown>,
  app: FastifyInstance
): Promise<JsonRpcResponse> {
  try {
    let path: string;
    let body: Record<string, unknown>;

    switch (toolName) {
      case "scrape":
        path = "/scrape";
        body = { url: args.url };
        break;
      case "crawl":
        path = "/crawl";
        body = { q: args.q, count: args.count };
        break;
      case "search":
        path = "/serp/search";
        body = { q: args.q, count: args.count };
        break;
      default:
        return makeError(id, -32602, "Unknown tool: " + toolName);
    }

    // Inject request internally — bypasses x402 with secret token
    const response = await app.inject({
      method: "POST",
      url: path,
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-internal-token": INTERNAL_BYPASS_TOKEN,
      },
    });

    const result = JSON.parse(response.body);

    if (response.statusCode >= 400) {
      return makeResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: true,
      });
    }

    return makeResult(id, {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeResult(id, {
      content: [{ type: "text", text: "Error: " + message }],
      isError: true,
    });
  }
}

export async function registerMcpRoute(app: FastifyInstance): Promise<void> {
  app.post("/mcp", async (req: FastifyRequest, reply: FastifyReply) => {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("application/json")) {
      return reply.status(400).send({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Content-Type must be application/json" },
        id: null,
      });
    }

    // Get client IP (from nginx X-Real-IP or direct connection)
    const clientIp = req.ip || "unknown";
    const body = req.body;

    // Handle batch requests (limit batch size to 10)
    if (Array.isArray(body)) {
      if (body.length > 10) {
        return reply.status(400).send({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Batch size exceeds maximum of 10" },
          id: null,
        });
      }

      const responses: JsonRpcResponse[] = [];
      for (const rpc of body) {
        const resp = await handleRequest(rpc as JsonRpcRequest, app, clientIp);
        if (resp) responses.push(resp);
      }
      if (responses.length === 0) {
        return reply.status(204).send();
      }
      return reply.send(responses);
    }

    // Handle single request
    const rpc = body as JsonRpcRequest;
    if (!rpc || rpc.jsonrpc !== "2.0" || !rpc.method) {
      return reply.send(
        makeError(
          (rpc as any)?.id ?? null,
          -32600,
          "Invalid JSON-RPC 2.0 request"
        )
      );
    }

    const response = await handleRequest(rpc, app, clientIp);
    if (!response) {
      return reply.status(204).send();
    }

    reply.send(response);
  });

  app.get("/mcp", async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(405).send({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Use POST for MCP requests. GET is not supported for this transport.",
      },
      id: null,
    });
  });

  app.delete("/mcp", async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({ ok: true });
  });

  console.log("[mcp] MCP transport registered at POST /mcp (rate limited: " + MCP_CALLS_PER_MINUTE + "/min, " + MCP_CALLS_PER_DAY + "/day per IP)");
}
