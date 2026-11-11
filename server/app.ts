import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { configuration, localHostname } from './config.js';
import { createDatabase } from './db.js';
import { LocalStorage } from './storage.js';
import { registerIdentity } from './auth.js';
import { registerOrganizations } from './organizations.js';
import { registerEducation } from './education.js';
import { registerCredits } from './credits.js';
import { registerCourses } from './courses.js';
import { registerCourseAssets } from './course-assets.js';
import { registerCourseManagementReads } from './course-management-read.js';
import { registerRecordings } from './recordings.js';
import { registerEvaluations } from './evaluation/routes.js';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export async function createApp(options: { databaseUrl?: string; storageRoot?: string; clientRoot?: string } = {}) {
  const config = configuration(options);
  const db = createDatabase(config.databaseUrl);
  const storage = new LocalStorage(config.storageRoot);
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 1024 * 1024 });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as { statusCode?: number; message?: string };
    const status = failure.statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: failure.message ?? 'Solicitação inválida' });
    return reply.code(500).send({ error: 'Não foi possível concluir a operação. Tente novamente.' });
  });
  app.decorate('db', db);
  app.decorate('storage', storage);
  app.addHook('onClose', async () => db.close());
  app.addHook('onRequest', async (request, reply) => {
    if (!localHostname(request.headers.host)) return reply.code(400).send({ error: 'Domínio não permitido' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-matraca-request'] !== '1') {
      return reply.code(403).send({ error: 'Solicitação não autorizada' });
    }
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
  await registerIdentity(app);
  await registerOrganizations(app);
  await registerEducation(app);
  await registerCredits(app);
  await registerCourses(app);
  await registerCourseAssets(app);
  await registerCourseManagementReads(app);
  await registerRecordings(app);
  await registerEvaluations(app);
  const clientRoot = resolve(options.clientRoot ?? 'dist/client');
  if (existsSync(resolve(clientRoot, 'index.html'))) {
    await app.register(staticFiles, { root: clientRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && request.headers.accept?.includes('text/html')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Página ou recurso não encontrado.' });
    });
  }
  return app;
}

declare module 'fastify' {
  interface FastifyInstance { db: ReturnType<typeof createDatabase>; storage: LocalStorage }
}
