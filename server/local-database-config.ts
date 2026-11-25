import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const localPostgresPort = 54339;
export const clusterSecret = resolve(homedir(), '.local', 'share', 'matraca-postgres', 'bootstrap.password');
export const mainDatabaseProfile = resolve('.data', 'postgres-main');
export const testDatabaseProfile = resolve('.data', 'postgres-tests');

export function assertLocalAppMode() {
  if (process.env.APP_MODE && process.env.APP_MODE !== 'local') {
    throw new Error('Este piloto permite apenas APP_MODE=local.');
  }
}

type Role = 'bootstrap' | 'migration' | 'runtime';
export function localDatabaseNames(profile: string) {
  const id = createHash('sha256').update(resolve(profile)).digest('hex').slice(0, 20);
  return { name: `matraca_${id}`, migration: `matraca_migrate_${id}`, runtime: `matraca_app_${id}` };
}

function credentialPath(role: Role, profile: string) {
  return role === 'bootstrap' ? clusterSecret : resolve(profile, `${role}.password`);
}

function privatePassword(path: string, create: boolean) {
  if (create) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
  }
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const state = fstatSync(descriptor);
      if (!state.isFile() || state.mode & 0o077 || state.size !== 65) throw new Error('Invalid credential file');
      const value = readFileSync(descriptor, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('Invalid credential value');
      return value;
    } finally { closeSync(descriptor); }
  } catch {
    throw new Error('Credencial local indisponível. Execute npm run db:start.');
  }
}

export function localDatabaseConnection(role: Role, profile = mainDatabaseProfile, create = false) {
  const names = localDatabaseNames(profile);
  const user = role === 'bootstrap' ? 'matraca_bootstrap' : names[role];
  const database = role === 'bootstrap' ? 'postgres' : names.name;
  const password = privatePassword(credentialPath(role, profile), create);
  return `postgresql://${user}:${password}@127.0.0.1:${localPostgresPort}/${database}`;
}

export function testDatabaseUrl() {
  return process.env.TEST_DATABASE_URL ?? localDatabaseConnection('migration', testDatabaseProfile);
}

export function migrationDatabaseUrl() {
  assertLocalAppMode();
  return process.env.MATRACA_MIGRATION_DATABASE_URL ?? localDatabaseConnection('migration');
}
