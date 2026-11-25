import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { startLocalDatabase } from './db-start.js';
import { configuration } from '../server/config.js';
if (process.argv.includes('--openai')) process.env.EVALUATION_PROVIDER = 'openai';
try {
  if (process.env.EVALUATION_PROVIDER !== 'openai') {
    if (!process.env.DATABASE_URL) await startLocalDatabase();
    for (const script of ['db:migrate', 'db:seed']) execFileSync('npm', ['run', script], { stdio: 'inherit' });
  }
} catch { process.stderr.write('Não foi possível preparar o banco local. Confira Docker ou DATABASE_URL.\n'); process.exit(1); }
process.env.MATRACA_DEV_PROXY_SECRET = randomBytes(32).toString('base64url');
const runtimeEnvironment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: configuration().databaseUrl };
delete runtimeEnvironment.MATRACA_MIGRATION_DATABASE_URL;
const webEnvironment: NodeJS.ProcessEnv = { ...runtimeEnvironment };
delete webEnvironment.DATABASE_URL;
delete webEnvironment.OPENAI_API_KEY;
delete webEnvironment.OPENAI_SMOKE_API_KEY;
const children = [spawn('npm', ['run', 'dev:api'], { env: runtimeEnvironment, stdio: 'inherit', detached: true }),
  spawn('npm', ['run', 'dev:web'], { env: webEnvironment, stdio: 'inherit', detached: true })];
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) { try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* processo já finalizado */ } }
  process.exitCode = code;
}
for (const child of children) child.on('exit', code => stop(code ?? 1));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
