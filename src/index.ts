import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadEnvNumber, loadEnvString } from './env.js';
import { registerSerpRoutes } from './serp.js';
import { registerCrawlRoutes } from './crawl.js';

async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true, credentials: true });

  // Health
  app.get('/health', async () => ({ ok: true }));

  // Routes
  await registerSerpRoutes(app);
  await registerCrawlRoutes(app);

  // Not found
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: 'not_found' }));

  return app;
}

async function main() {
  const PORT = loadEnvNumber('PORT', 8085);
  const HOST = loadEnvString('HOST', '0.0.0.0');
  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Server listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


