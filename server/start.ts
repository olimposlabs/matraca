import { createApp } from './app.js';
import { configuration } from './config.js';
import { MockEvaluationProvider } from './evaluation/provider.js';
import { startEvaluationWorker } from './evaluation/worker.js';
const app = await createApp();
await app.listen({ host: '127.0.0.1', port: configuration().port });
process.stdout.write(`Matraca API local disponível na porta ${configuration().port}\n`);
const stopWorker = startEvaluationWorker(app.db, new MockEvaluationProvider());
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void stopWorker().then(() => app.close()).then(() => process.exit(0), () => process.exit(1));
  });
}
