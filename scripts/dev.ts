import { spawn, execFileSync } from 'node:child_process';
import { startLocalDatabase } from './db-start.js';
try {
  if (!process.env.DATABASE_URL) startLocalDatabase();
  for (const script of ['db:migrate', 'db:seed']) execFileSync('npm', ['run', script], { stdio: 'inherit' });
} catch { process.stderr.write('Não foi possível preparar o banco local. Confira Docker ou DATABASE_URL.\n'); process.exit(1); }
const children = ['dev:api', 'dev:web'].map(script => spawn('npm', ['run', script], { stdio: 'inherit', detached: true }));
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
