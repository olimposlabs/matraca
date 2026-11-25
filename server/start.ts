import { createApp } from './app.js';
import { configuration } from './config.js';
import { MockEvaluationProvider } from './evaluation/provider.js';
import { startEvaluationWorker } from './evaluation/worker.js';
import { evaluationConfiguration, loadOpenAIKey } from './evaluation/openai-config.js';
import { createOpenAIProvider } from './evaluation/openai-runtime.js';
import { verifiedMediaExecutor } from './media/executor.js';
import { requireRuntimeDatabase } from './db-runtime.js';
const evaluation = evaluationConfiguration();
const databaseUrl = configuration().databaseUrl;
const app = await createApp({ databaseUrl, clientRoot: process.env.APP_CLIENT_ROOT, evaluationProvider: evaluation.kind, liveLimits: evaluation.liveLimits });
const provider = await (async () => {
  try {
    await requireRuntimeDatabase(app.db, databaseUrl);
    if (evaluation.kind === 'mock') return new MockEvaluationProvider();
    const executor = await verifiedMediaExecutor();
    const apiKey = await loadOpenAIKey();
    return createOpenAIProvider(app.db, app.storage, {
      apiKey, executor, audioModel: evaluation.audioModel, reportModel: evaluation.reportModel, instance: evaluation.liveLimits,
    });
  } catch (error) {
    await app.close();
    throw error;
  }
})();
await app.listen({ host: '127.0.0.1', port: configuration().port });
process.stdout.write(`Matraca API local disponível na porta ${configuration().port}. Avaliações: ${evaluation.kind}.\n`);
const stopWorker = startEvaluationWorker(app.db, provider);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void stopWorker().then(() => app.close()).then(() => process.exit(0), () => process.exit(1));
  });
}
