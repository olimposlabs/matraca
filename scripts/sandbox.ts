import { execFileSync, spawn } from 'node:child_process';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { startLocalDatabase } from './db-start.js';
import { sandboxPaths } from './sandbox-paths.js';

const { values, positionals } = parseArgs({
  options: { name: { type: 'string' }, port: { type: 'string', default: '5174' }, confirm: { type: 'string' }, examples: { type: 'boolean', default: false } },
  allowPositionals: true,
});
const [action] = positionals;
const name = values.name ?? '';
const port = Number(values.port);
if (!['start', 'reset'].includes(action) || positionals.length !== 1 || !/^[a-z][a-z0-9_]{0,24}$/.test(name)) {
  throw new Error('Use pilot:sandbox -- start|reset --name nome_local. O nome aceita letras minúsculas, números e _.');
}
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5173 || port === 3001) {
  throw new Error('Informe uma porta livre entre 1024 e 65535, fora das portas do ambiente principal.');
}
if (action === 'reset' && values.confirm !== name) throw new Error('Para apagar o sandbox, confirme o nome exato com --confirm.');

const { storage, schema, domainSuffix } = sandboxPaths(name);
const objects = resolve(storage, 'objects');
const clientRoot = resolve(storage, 'client');
startLocalDatabase();
const control = createDatabase(localDatabaseUrl);
const guard = await control.pool.connect();
try {
  const lock = await guard.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,14)) AS locked', [schema]);
  if (!lock.rows[0].locked) throw new Error('Este sandbox está em execução. Encerre o processo antes de iniciar ou resetar.');
  if (action === 'reset') {
    const canonical = await realpath(storage).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return storage;
      throw error;
    });
    if (canonical !== storage) throw new Error('O caminho do sandbox contém um link simbólico. Reset recusado.');
    await guard.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await rm(storage, { recursive: true, force: true });
    process.stdout.write(`Sandbox ${name} removido.\n`);
  } else {
    await guard.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await mkdir(storage, { recursive: true, mode: 0o700 });
    if (await realpath(storage) !== storage) throw new Error('O caminho do sandbox contém um link simbólico.');
    const database = new URL(localDatabaseUrl);
    database.searchParams.set('options', `-c search_path=${schema}`);
    const env = {
      ...process.env, APP_MODE: 'local', DATABASE_URL: database.toString(), STORAGE_ROOT: objects,
      PORT: String(port), APP_PUBLIC_PORT: String(port), APP_CLIENT_ROOT: clientRoot,
      APP_PARTNER_DOMAIN_SUFFIX: domainSuffix,
    };
    for (const task of ['db:migrate', 'db:seed']) execFileSync('npm', ['run', task], { env, stdio: 'inherit' });
    if (values.examples) execFileSync('npm', ['run', 'db:seed:examples', '--', '--invoice'], { env, stdio: 'inherit' });
    const domains = [domainSuffix, `parceiro.${domainSuffix}`, `backoffice.${domainSuffix}`];
    execFileSync('npm', ['run', 'build', '--', '--outDir', clientRoot], { env, stdio: 'inherit' });
    for (const hostname of domains) process.stdout.write(`http://${hostname}:${port}\n`);
    process.stdout.write(`Caixa de e-mail local: ${resolve(storage, 'mailbox')}\n`);
    const child = spawn('npm', ['start'], { env, stdio: 'inherit', detached: true });
    const stop = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const code = await new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', exit => resolveExit(exit ?? 0));
      });
      process.exitCode = code;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
} finally {
  guard.release();
  await control.close();
}
