import { FastifyInstance } from 'fastify';

const SERP_SERVICE_URL = process.env.SERP_SERVICE_URL || 'http://localhost:8080';

export async function runSerpQuery(q: string, count = 5) {
  const res = await fetch(`${SERP_SERVICE_URL}/api/v1/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, count }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SERP service failed: ${res.status} ${err}`);
  }

  const data = await res.json() as any;
  return data.web?.results || data.results || [];
}

export async function registerSerpRoutes(app: FastifyInstance) {
  app.post('/serp/search', async (req, reply) => {
    const body = (await req.body) as any;
    const q = (body?.q || '').toString().trim();
    const count = Math.max(1, Math.min(20, Number(body?.count ?? 5)));

    if (!q) return reply.status(400).send({ error: 'q_required' });

    try {
      const results = await runSerpQuery(q, count);
      return reply.send({ results });
    } catch (err) {
      console.error('[serp] error:', err);
      return reply.status(500).send({
        error: 'serp_failed',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  });
}


