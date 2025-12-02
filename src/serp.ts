import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';
const SERP_SERVICE_URL = process.env.SERP_SERVICE_URL || 'http://localhost:8080';

interface SerpResult {
  url?: string;
  title?: string;
  description?: string;
}

interface SerpResponse {
  web?: { results?: SerpResult[] };
  results?: SerpResult[];
}

interface SerpRequestBody {
  q?: string;
  count?: number;
}

/**
 * Query the upstream SERP service for search results
 */
export async function runSerpQuery(query: string, count = 5): Promise<SerpResult[]> {
  const response = await fetch(`${SERP_SERVICE_URL}/api/v1/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, count }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SERP service failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as SerpResponse;
  return data.web?.results ?? data.results ?? [];
}

/**
 * Register SERP proxy routes
 */
export async function registerSerpRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /serp/search
   * Proxy search requests to upstream SERP service
   */
  app.post('/serp/search', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as SerpRequestBody;
    const query = (body?.q ?? '').toString().trim();
    const count = Math.max(1, Math.min(20, Number(body?.count ?? 5)));

    if (!query) {
      return reply.status(400).send({ error: 'q_required' });
    }

    try {
      const results = await runSerpQuery(query, count);
      return reply.send({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (DEBUG_LOG) {
        console.error('[serp] error:', err);
      }

      return reply.status(500).send({
        error: 'serp_failed',
        message,
      });
    }
  });
}
