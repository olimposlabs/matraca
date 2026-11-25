import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { createDatabase } from '../server/db.js';
import { requireRuntimeDatabase } from '../server/db-runtime.js';
import { startPostgresCluster } from './db-start.js';
import { localDatabaseConnection, localDatabaseNames } from '../server/local-database-config.js';
import { provisionLocalDatabase } from './provision-local-db.js';

const dockerHost = startPostgresCluster();
const temporary = await mkdtemp(join(tmpdir(), 'matraca-runtime-check-'));
const profiles = ['pilot', 'other'].map(name => join(temporary, name));
const bootstrap = createDatabase(localDatabaseConnection('bootstrap'));
function postgresUtility(name: string, databaseUrl: string, args: string[], input?: Buffer) {
  const url = new URL(databaseUrl);
  return execFileSync('docker', [dockerHost, 'exec', '--interactive', '--env', 'PGPASSWORD',
    'matraca-secure-db-postgres-1', name, '-h', '127.0.0.1', '-U', url.username, '-d', url.pathname.slice(1), ...args],
  { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, input, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'] });
}
try {
  const primary = await provisionLocalDatabase(profiles[0]);
  const migrationTarget = await provisionLocalDatabase(profiles[1]);
  for (const task of ['db:migrate', 'db:seed']) execFileSync('npm', ['run', task], {
    env: { ...process.env, DATABASE_URL: primary.runtimeUrl, MATRACA_MIGRATION_DATABASE_URL: primary.migrationUrl },
    stdio: 'inherit', timeout: 30000,
  });
  for (const task of ['db:migrate', 'db:seed']) {
    const rejected = spawnSync('npm', ['run', task], {
      env: { ...process.env, APP_MODE: 'nonlocal-validation', MATRACA_MIGRATION_DATABASE_URL: primary.migrationUrl },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(rejected.status, 1);
    assert.ok(rejected.stderr.includes('APP_MODE=local'));
  }
  const previous = createDatabase(primary.migrationUrl);
  try {
    await previous.query("UPDATE orgs SET name='Histórico sintético a preservar' WHERE slug='matraca'");
  } finally { await previous.close(); }
  const backup = postgresUtility('pg_dump', primary.migrationUrl, ['--schema=public', '--format=custom', '--no-owner', '--no-acl']);
  postgresUtility('pg_restore', migrationTarget.migrationUrl, ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error'], backup);
  const migrated = await provisionLocalDatabase(profiles[1]);
  const targetDb = createDatabase(migrated.runtimeUrl);
  try {
    await requireRuntimeDatabase(targetDb, migrated.runtimeUrl);
    assert.equal((await targetDb.query("SELECT name FROM orgs WHERE slug='matraca'")).rows[0].name, 'Histórico sintético a preservar');
  } finally { await targetDb.close(); }
  const replacement = await provisionLocalDatabase(profiles[1], { rotateRuntime: true });
  const restarted = await provisionLocalDatabase(profiles[1]);
  assert.ok(restarted.runtimeUrl === replacement.runtimeUrl);
  const obsolete = createDatabase(migrated.runtimeUrl);
  try { await assert.rejects(() => obsolete.query('SELECT 1'), { code: '28P01' }); }
  finally { await obsolete.close(); }
  const rotated = createDatabase(replacement.runtimeUrl);
  try { await requireRuntimeDatabase(rotated, replacement.runtimeUrl); } finally { await rotated.close(); }
  const app = await createApp({ databaseUrl: primary.runtimeUrl, storageRoot: join(temporary, 'objects') });
  const owner = createDatabase(primary.migrationUrl);
  const current = await app.db.pool.connect();
  try {
    await requireRuntimeDatabase(app.db, primary.runtimeUrl);
    await assert.rejects(() => requireRuntimeDatabase(owner, primary.migrationUrl), /papel de runtime/u);
    const alteredRole = new URL(localDatabaseConnection('bootstrap'));
    alteredRole.pathname = new URL(primary.runtimeUrl).pathname;
    alteredRole.searchParams.set('options', `-c role=${primary.runtimeRole}`);
    const privilegedSession = createDatabase(alteredRole.href);
    try { await assert.rejects(() => requireRuntimeDatabase(privilegedSession, alteredRole.href), /papel de runtime/u); }
    finally { await privilegedSession.close(); }
    assert.equal((await app.inject({ method: 'GET', url: '/api/context', headers: { host: 'localhost' } })).statusCode, 200);
    await assert.rejects(() => app.db.query('CREATE SCHEMA synthetic_restricted_check'), { code: '42501' });
    await assert.rejects(() => app.db.query('SELECT name FROM schema_migrations LIMIT 1'), { code: '42501' });
    const foreignUrl = new URL(primary.runtimeUrl);
    foreignUrl.pathname = '/' + localDatabaseNames(profiles[1]).name;
    const foreign = createDatabase(foreignUrl.href);
    try { await assert.rejects(() => foreign.query('SELECT 1'), { code: '42501' }); }
    finally { await foreign.close(); }
    await current.query('BEGIN');
    const pid = (await current.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const active = await app.db.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND xact_start IS NOT NULL AND state<>'idle'", [pid]);
    assert.equal(active.rowCount, 1, 'O faturamento enxerga transações da API e do worker no papel de runtime.');
    await current.query('ROLLBACK');
    process.stdout.write('Papéis isolados, restauração de backup sintético, rotação de credencial, API e visibilidade do faturamento conferidas.\n');
  } finally { current.release(true); await app.close(); await owner.close(); }
} finally {
  try {
    for (const profile of profiles) {
      const names = localDatabaseNames(profile);
      await bootstrap.query(`DROP DATABASE IF EXISTS ${names.name}`);
      await bootstrap.query(`DROP ROLE IF EXISTS ${names.runtime},${names.migration}`);
    }
  } finally { await bootstrap.close(); await rm(temporary, { recursive: true, force: true }); }
}
