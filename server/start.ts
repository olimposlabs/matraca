import { createApp } from './app.js';
import { configuration } from './config.js';
const app = await createApp();
await app.listen({ host: '127.0.0.1', port: configuration().port });
process.stdout.write(`Matraca API local disponível na porta ${configuration().port}\n`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
