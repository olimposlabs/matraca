import { parseArgs } from 'node:util';
import { z } from 'zod';
import { configuration } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { migrationDatabaseUrl } from '../server/local-database-config.js';
import { applyPrivacy, privacyPlan } from '../server/privacy-retention.js';
import { LocalStorage } from '../server/storage.js';

const { values } = parseArgs({ options: {
  org: { type: 'string' }, student: { type: 'string' }, apply: { type: 'string' },
} });
const id = z.uuid().transform(value => value.toLowerCase());
const scope = { orgId: id.optional().parse(values.org), studentId: id.optional().parse(values.student) };
if (scope.studentId && !scope.orgId) throw new Error('Informe também a organização do aluno.');
function localConnection(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('A conexão PostgreSQL local é inválida.'); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || [...url.searchParams.keys()].some(key => key !== 'options')) {
    throw new Error('A retenção aceita apenas conexões PostgreSQL de loopback.');
  }
  return url;
}
const runtime = localConnection(configuration().databaseUrl);
const administrative = localConnection(migrationDatabaseUrl());
const namespace = (url: URL) => [url.hostname, url.port || '5432', url.pathname, url.searchParams.get('options')].join('|');
if (namespace(runtime) !== namespace(administrative)) throw new Error('Confira se a administração e o runtime apontam para o mesmo ambiente.');
const db = createDatabase(administrative.href);
const storage = new LocalStorage(configuration().storageRoot);
try {
  const result = values.apply ? await applyPrivacy(db, storage, scope, values.apply) : await privacyPlan(db, storage, scope);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally { await db.close(); }
