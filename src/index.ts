import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadEnvNumber, loadEnvString } from './env.js';
import { registerSerpRoutes } from './serp.js';
import { registerCrawlRoutes } from './crawl.js';
import { initPool, shutdownPool } from './pool.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true, credentials: true });

  // Health check endpoint
  app.get('/health', async () => ({ ok: true }));

  // Register route handlers
  await registerSerpRoutes(app);
  await registerCrawlRoutes(app);

  // 404 handler
  app.setNotFoundHandler((req, reply) => {
    return reply.status(404).send({ error: 'not_found' });
  });

  return app;
}

async function main() {
  const PORT = loadEnvNumber('PORT', 8085);
  const HOST = loadEnvString('HOST', '0.0.0.0');
  const POOL_SIZE = loadEnvNumber('POOL_SIZE', 1);

  // Pre-warm browser session pool
  if (DEBUG_LOG) {
    console.log(`[crawler] Pre-warming session pool (size=${POOL_SIZE})`);
  }
  await initPool(POOL_SIZE);

  // Start server
  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Server listening on http://${HOST}:${PORT}`);

  // Graceful shutdown
  const shutdown = async () => {
    if (DEBUG_LOG) {
      console.log('[crawler] Shutting down...');
    }
    await app.close();
    await shutdownPool();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[crawler] Fatal error:', err);
  process.exit(1);
});
