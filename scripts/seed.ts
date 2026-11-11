import { createDatabase } from '../server/db.js';
import { configuration } from '../server/config.js';
const db = createDatabase(configuration().databaseUrl);
try {
  await db.query("INSERT INTO app_metadata (key,value) VALUES ('demo', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ name: 'Matraca', mode: 'local', createdBy: 'seed' })]);
  process.stdout.write('Seed local conferido, sem sobrescrever dados existentes.\n');
} finally { await db.close(); }
