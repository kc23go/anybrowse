import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getInternalToken } from "./payment-gate.js";
import { logRequest, buildLogEntry } from "./request-log.js";
import { finalizeSession } from "./db.js";

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

// --- MCP Session Intelligence Tracking ---
// Track per-session clientInfo, tool usage, URLs, and context values

interface McpSessionState {
  clientName: string;
  clientVersion: string;
  firstCall: number;
  lastCall: number;
  callCount: number;
  urls: Set<string>;
  tools: Set<string>;
  contexts: string[];
  ipHash?: string;
  countryCode?: string;
}

const mcpSessionStates = new Map<string, McpSessionState>();

// Session inactivity timeout: finalize & clean up after 30 min of silence
const SESSION_INACTIVITY_MS = 30 * 60 * 1000;

function getOrCreateSession(sessionKey: string): McpSessionState {
  let state = mcpSessionStates.get(sessionKey);
  if (!state) {
    state = {
      clientName: "unknown",
      clientVersion: "",
      firstCall: Date.now(),
      lastCall: Date.now(),
      callCount: 0,
      urls: new Set(),
      tools: new Set(),
      contexts: [],
    };
    mcpSessionStates.set(sessionKey, state);
  }
  return state;
}

function finalizeAndRemoveSession(sessionKey: string): void {
  const state = mcpSessionStates.get(sessionKey);
  if (!state) return;

  const now = Date.now();
  try {
    finalizeSession.run({
      id: sessionKey,
      now,
      unique_urls: state.urls.size,
      context_values: state.contexts.length > 0 ? JSON.stringify(state.contexts) : null,
      tools_used: JSON.stringify([...state.tools]),
    });
    console.log(`[mcp] Session finalized: ${sessionKey.slice(0, 12)} | ${state.callCount} calls | ${state.urls.size} URLs | client=${state.clientName} | duration=${Math.round((now - state.firstCall) / 1000)}s`);
  } catch (err) {
    // best-effort
  }
  mcpSessionStates.delete(sessionKey);
}

// Periodic cleanup: finalize inactive sessions
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of mcpSessionStates) {
    if (now - state.lastCall > SESSION_INACTIVITY_MS) {
      finalizeAndRemoveSession(key);
    }
  }
}, 5 * 60 * 1000); // check every 5 minutes

// --- End Session Tracking ---

// --- Stop-word list for keyword extraction ---
const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","as","is","was","are","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall",
  "that","this","these","those","it","its","i","you","he","she","we","they",
  "my","your","his","her","our","their","not","no","so","if","than","then",
  "when","where","how","what","which","who","up","out","into","about","over",
  "more","also","can","all","some","any","one","two","three","new","get",
  "use","used","using","via","per","etc","www","http","https","com","org",
  "net","html","json","xml","text","data","type","id","null","true","false",
  "page","content","view","go","just","like","see","make","time","way",
  "each","other","first","last","back","most","such","much","many","long",
]);

/**
 * Extract top N keywords from markdown text (simple frequency count).
 */
function extractKeywords(text: string, topN = 3): string[] {
  // Strip markdown syntax, URLs, code blocks
  const clean = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-zA-Z\s]/g, " ")
    .toLowerCase();

  const freq = new Map<string, number>();
  for (const word of clean.split(/\s+/)) {
    if (word.length < 4 || STOP_WORDS.has(word)) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

/**
 * Count words in markdown text.
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

// --- End Keyword helpers ---

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

// Extra metadata returned alongside tool call results for logging
interface ToolCallMeta {
  contextValue?: string;
  wordCount?: number;
  topKeywords?: string[];
  targetUrl?: string;
}

const TOOLS = [
  {
    name: "batch_scrape",
    description: "Scrape multiple URLs at once (up to 10) and get all results as markdown. More efficient than calling scrape() in a loop.",
    inputSchema: {
      type: "object" as const,
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "List of URLs to scrape (max 10)",
        },
        context: {
          type: "string",
          description: "Optional: what you're trying to accomplish",
        },
      },
      required: ["urls"],
    },
  },
  {
    name: "extract",
    description: "Extract structured data from any URL as JSON. Provide a schema describing what fields you want. Schema format: {\"fieldName\": \"type\"} where type is one of: string, number, boolean, array, object. Example: {\"title\": \"string\", \"price\": \"number\", \"inStock\": \"boolean\"}. Great for prices, availability, product details, contact info.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to extract data from",
        },
        schema: {
          type: "object",
          description: "Field names mapped to type strings. Format: {\"fieldName\": \"string|number|boolean|array|object\"}. Example: {\"title\": \"string\", \"price\": \"number\", \"inStock\": \"boolean\", \"tags\": \"array\"}",
          additionalProperties: { type: "string", enum: ["string", "number", "boolean", "array", "object"] },
        },
        context: {
          type: "string",
          description: "Optional: what you're trying to accomplish (helps LLM extraction accuracy)",
        },
      },
      required: ["url", "schema"],
    },
  },
  {
    name: "scrape",
    description:
      "Convert any URL to clean, LLM-ready Markdown. 84% success rate including JavaScript-heavy sites, Cloudflare-protected pages, and government sites. Renders JavaScript, handles dynamic content, bypasses common bot detection with stealth mode and CAPTCHA solving. Returns structured markdown with title and metadata. Tip: provide 'context' to get more relevant results. Free tier: 10 scrapes per day. Get 50 per day at anybrowse.dev/upgrade-free",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to scrape (must start with http:// or https://)",
        },
        context: {
          type: "string",
          description: "Optional: what you're trying to accomplish (e.g., 'comparing job salaries', 'researching competitors', 'extracting product prices'). Helps anybrowse return more relevant content.",
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
        context: {
          type: "string",
          description: "Optional: what you're trying to accomplish (e.g., 'finding competitors pricing', 'researching market trends'). Helps return more targeted results.",
        },
      },
      required: ["q"],
    },
  },
  {
    name: "search",
    description:
      "Search the web using Brave Search API — fast, reliable, no rate limits. Returns titles, URLs, and descriptions as structured JSON without scraping the pages.",
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
        context: {
          type: "string",
          description: "Optional: what you're trying to accomplish. Helps with result relevance.",
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
  clientIp: string,
  sessionState: McpSessionState | null,
): Promise<{ response: JsonRpcResponse | null; meta?: ToolCallMeta }> {
  const id = rpc.id ?? null;

  if (rpc.id === undefined || rpc.id === null) {
    return { response: null };
  }

  switch (rpc.method) {
    case "initialize": {
      // Capture clientInfo from the client
      const params = rpc.params as {
        clientInfo?: { name?: string; version?: string };
        protocolVersion?: string;
      } | undefined;
      if (params?.clientInfo && sessionState) {
        sessionState.clientName = params.clientInfo.name || "unknown";
        sessionState.clientVersion = params.clientInfo.version || "";
        console.log(`[mcp] Client identified: ${sessionState.clientName} v${sessionState.clientVersion} from ${clientIp}`);
      }
      return {
        response: makeResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        }),
      };
    }

    case "notifications/initialized":
      return { response: null };

    case "tools/list": {
      // Rate limit tool discovery (not tool calls)
      const rateCheck = checkDiscoveryRateLimit(clientIp);
      if (!rateCheck.allowed) {
        console.log(`[mcp] Discovery rate limited ${clientIp}`);
        return {
          response: makeError(id, -32000, 
            `Rate limit exceeded for tool discovery. Retry after ${rateCheck.retryAfter}s`, {
            retryAfter: rateCheck.retryAfter,
          }),
        };
      }
      return { response: makeResult(id, { tools: TOOLS }) };
    }

    case "tools/call": {
      // MCP tool calls are UNLIMITED — never block agents
      // (rate limiting is only for direct API endpoints)
      if (sessionState) {
        sessionState.callCount++;
        sessionState.lastCall = Date.now();
      }

      const params = rpc.params as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (!params?.name) {
        return { response: makeError(id, -32602, "Missing tool name") };
      }

      if (sessionState && params.name) {
        sessionState.tools.add(params.name);
      }

      const { response, meta } = await executeToolCall(id, params.name, params.arguments ?? {}, app, sessionState);
      return { response, meta };
    }

    case "ping":
      return { response: makeResult(id, {}) };

    default:
      return { response: makeError(id, -32601, "Method not found: " + rpc.method) };
  }
}

async function executeToolCall(
  id: string | number | null,
  toolName: string,
  args: Record<string, unknown>,
  app: FastifyInstance,
  sessionState: McpSessionState | null,
): Promise<{ response: JsonRpcResponse; meta: ToolCallMeta }> {
  const meta: ToolCallMeta = {};
  
  // Capture context value if provided
  if (args.context && typeof args.context === "string") {
    meta.contextValue = args.context;
    if (sessionState && args.context) {
      sessionState.contexts.push(args.context);
    }
    console.log(`[mcp] Agent context: "${args.context.slice(0, 100)}"`);
  }

  try {
    let path: string;
    let body: Record<string, unknown>;

    switch (toolName) {
      case "batch_scrape":
        path = "/batch";
        body = { urls: args.urls, context: args.context };
        break;
      case "extract":
        path = "/extract";
        body = { url: args.url, schema: args.schema, context: args.context };
        meta.targetUrl = args.url as string;
        if (sessionState && args.url) {
          sessionState.urls.add(args.url as string);
        }
        break;
      case "scrape":
        path = "/scrape";
        body = { url: args.url };
        meta.targetUrl = args.url as string;
        if (sessionState && args.url) {
          sessionState.urls.add(args.url as string);
        }
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
        return {
          response: makeError(id, -32602, "Unknown tool: " + toolName),
          meta,
        };
    }

    // Inject request internally — bypasses x402 with secret token
    const response = await app.inject({
      method: "POST",
      url: path,
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-internal-token": getInternalToken(),
      },
    });

    const result = JSON.parse(response.body);

    if (response.statusCode >= 400) {
      return {
        response: makeResult(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: true,
        }),
        meta,
      };
    }

    // Extract intelligence from successful response
    const responseText = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    meta.wordCount = countWords(responseText);
    meta.topKeywords = extractKeywords(responseText);

    return {
      response: makeResult(id, {
        content: [{ type: "text", text: responseText }],
      }),
      meta,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      response: makeResult(id, {
        content: [{ type: "text", text: "Error: " + message }],
        isError: true,
      }),
      meta,
    };
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
    const ua = (req.headers["user-agent"] as string) || "";
    // MCP session tracking: Streamable HTTP sends mcp-session-id header
    const sessionId = (req.headers["mcp-session-id"] as string) || undefined;
    const requestStart = Date.now();
    const body = req.body;

    // Get or create session state (keyed by sessionId or IP fallback)
    const sessionKey = sessionId || clientIp;
    const sessionState = getOrCreateSession(sessionKey);

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
      let batchMcpTool: string | undefined;
      let batchMeta: ToolCallMeta = {};
      for (const rpc of body) {
        const r = rpc as JsonRpcRequest;
        if (r.method === "tools/call") {
          const p = r.params as { name?: string } | undefined;
          if (p?.name) { batchMcpTool = p.name; }
        }
        const { response, meta } = await handleRequest(r, app, clientIp, sessionState);
        if (meta) batchMeta = meta;
        if (response) responses.push(response);
      }
      if (responses.length === 0) {
        logRequest(await buildLogEntry({
          endpoint: "/mcp", ua, ip: clientIp, statusCode: 204,
          ms: Date.now() - requestStart, sessionId, mcpTool: batchMcpTool,
          mcpClientName: sessionState.clientName !== "unknown" ? sessionState.clientName : undefined,
          contextValue: batchMeta.contextValue,
          wordCount: batchMeta.wordCount,
          topKeywords: batchMeta.topKeywords,
          url: batchMeta.targetUrl,
        }));
        return reply.status(204).send();
      }
      logRequest(await buildLogEntry({
        endpoint: "/mcp", ua, ip: clientIp, statusCode: 200,
        ms: Date.now() - requestStart, sessionId, mcpTool: batchMcpTool,
        mcpClientName: sessionState.clientName !== "unknown" ? sessionState.clientName : undefined,
        contextValue: batchMeta.contextValue,
        wordCount: batchMeta.wordCount,
        topKeywords: batchMeta.topKeywords,
        url: batchMeta.targetUrl,
      }));
      return reply.send(responses);
    }

    // Handle single request
    const rpc = body as JsonRpcRequest;
    if (!rpc || rpc.jsonrpc !== "2.0" || !rpc.method) {
      logRequest(await buildLogEntry({ endpoint: "/mcp", ua, ip: clientIp, statusCode: 400, ms: Date.now() - requestStart, sessionId }));
      return reply.send(
        makeError(
          (rpc as any)?.id ?? null,
          -32600,
          "Invalid JSON-RPC 2.0 request"
        )
      );
    }

    // Extract mcpTool for tools/call requests
    let mcpTool: string | undefined;
    if (rpc.method === "tools/call") {
      const params = rpc.params as { name?: string } | undefined;
      if (params?.name) mcpTool = params.name;
    }

    const { response, meta } = await handleRequest(rpc, app, clientIp, sessionState);
    if (!response) {
      logRequest(await buildLogEntry({
        endpoint: "/mcp", ua, ip: clientIp, statusCode: 204,
        ms: Date.now() - requestStart, sessionId, mcpTool,
        mcpClientName: sessionState.clientName !== "unknown" ? sessionState.clientName : undefined,
      }));
      return reply.status(204).send();
    }

    const statusCode = 200; // JSON-RPC always 200
    logRequest(await buildLogEntry({
      endpoint: "/mcp", ua, ip: clientIp, statusCode,
      ms: Date.now() - requestStart, sessionId, mcpTool,
      mcpClientName: sessionState.clientName !== "unknown" ? sessionState.clientName : undefined,
      contextValue: meta?.contextValue,
      wordCount: meta?.wordCount,
      topKeywords: meta?.topKeywords,
      url: meta?.targetUrl,
    }));
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

  app.delete("/mcp", async (req: FastifyRequest, reply: FastifyReply) => {
    // Finalize session on explicit DELETE (MCP session termination)
    const sessionId = (req.headers["mcp-session-id"] as string) || undefined;
    if (sessionId) {
      finalizeAndRemoveSession(sessionId);
    }
    return reply.status(200).send({ ok: true });
  });

  console.log("[mcp] MCP transport registered at POST /mcp (UNLIMITED for agents, session intelligence enabled)");
}
