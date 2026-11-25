import { configuration } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { drainLiveEvaluations } from '../server/evaluation/worker.js';

const db = createDatabase(configuration().databaseUrl);
try {
  const cancelled = await drainLiveEvaluations(db);
  process.stdout.write(`Avaliações reais encerradas: ${cancelled}.\n`);
} finally { await db.close(); }
