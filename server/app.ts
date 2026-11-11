import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { configuration, localHostname } from './config.js';
import { createDatabase } from './db.js';
import { LocalStorage } from './storage.js';

export async function createApp(options: { databaseUrl?: string; storageRoot?: string } = {}) {
  const config = configuration(options);
  const db = createDatabase(config.databaseUrl);
  const storage = new LocalStorage(config.storageRoot);
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 1024 * 1024 });
  await app.register(cookie);
  app.decorate('db', db);
  app.decorate('storage', storage);
  app.addHook('onClose', async () => db.close());
  app.addHook('onRequest', async (request, reply) => {
    if (!localHostname(request.headers.host)) return reply.code(400).send({ error: 'Domínio não permitido' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin) {
      try {
        if (new URL(request.headers.origin).host !== request.headers.host) return reply.code(403).send({ error: 'Origem não permitida' });
      } catch { return reply.code(403).send({ error: 'Origem inválida' }); }
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cache-Control', 'no-store');
  });
  app.get('/api/health', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ok', service: 'matraca', database: 'ok', mode: 'local', version: '0.1.0' };
    } catch { return reply.code(503).send({ status: 'unavailable', service: 'matraca', database: 'unavailable', mode: 'local' }); }
  });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance { db: ReturnType<typeof createDatabase>; storage: LocalStorage }
}
