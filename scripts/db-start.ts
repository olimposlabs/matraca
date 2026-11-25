import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLocalAppMode, clusterSecret, localDatabaseConnection, mainDatabaseProfile, testDatabaseProfile } from '../server/local-database-config.js';
import { parseArgs } from 'node:util';
import { provisionLocalDatabase } from './provision-local-db.js';

export function startPostgresCluster() {
  assertLocalAppMode();
  localDatabaseConnection('bootstrap', mainDatabaseProfile, true);
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  const endpoint = process.env.DOCKER_HOST ?? execFileSync('docker', ['context', 'inspect',
    '--format={{.Endpoints.docker.Host}}', ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : [])],
  { env: environment, encoding: 'utf8', timeout: 10000 }).trim();
  if (!/^unix:\/\/\/[^\r\n]+$/u.test(endpoint)) throw new Error('O PostgreSQL local exige Docker no socket Unix.');
  const host = `--host=${endpoint}`;
  try { execFileSync('docker', [host, 'image', 'inspect', 'postgres:17-alpine'], { env: environment, stdio: 'ignore', timeout: 10000 }); }
  catch {
    const directory = mkdtempSync(join(tmpdir(), 'matraca-public-docker-'));
    try {
      writeFileSync(join(directory, 'config.json'), '{}\n', { mode: 0o600 });
      execFileSync('docker', ['--config', directory, host, 'pull', 'postgres:17-alpine'], { env: environment, stdio: 'inherit', timeout: 180000 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  execFileSync('docker', [host, 'compose', 'up', '-d', '--wait', '--pull', 'never'], {
    env: { ...environment, MATRACA_POSTGRES_BOOTSTRAP_FILE: clusterSecret }, stdio: 'inherit', timeout: 90000,
  });
  return host;
}

export async function startLocalDatabase({ rotateRuntime = false } = {}) {
  startPostgresCluster();
  const main = await provisionLocalDatabase(mainDatabaseProfile, { rotateRuntime });
  await provisionLocalDatabase(testDatabaseProfile);
  return main;
}
if (process.argv[1]?.endsWith('db-start.ts')) {
  try {
    const { values } = parseArgs({ options: { 'rotate-runtime': { type: 'boolean' } } });
    await startLocalDatabase({ rotateRuntime: values['rotate-runtime'] });
  }
  catch { process.stderr.write('Não foi possível preparar os bancos locais. Confira Docker e as permissões do armazenamento privado.\n'); process.exitCode = 1; }
}
