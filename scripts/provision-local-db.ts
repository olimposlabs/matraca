import type { PoolClient } from 'pg';
import { createDatabase } from '../server/db.js';
import { localDatabaseConnection, localDatabaseNames } from '../server/local-database-config.js';

async function ensureRole(client: PoolClient, role: string, url: string) {
  // Profile role names and passwords come from hex strings generated locally.
  const { password } = new URL(url);
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
  const command = exists.rowCount ? 'ALTER ROLE' : 'CREATE ROLE';
  await client.query(`${command} ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
}

export async function provisionLocalDatabase(profile: string) {
  const { name, migration, runtime } = localDatabaseNames(profile);
  const migrationUrl = localDatabaseConnection('migration', profile, true);
  const runtimeUrl = localDatabaseConnection('runtime', profile, true);
  const bootstrap = localDatabaseConnection('bootstrap');
  const control = createDatabase(bootstrap);
  const client = await control.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,19))', [name]);
    await client.query('REVOKE CONNECT ON DATABASE postgres,template1 FROM PUBLIC');
    await ensureRole(client, migration, migrationUrl);
    await ensureRole(client, runtime, runtimeUrl);
    if (!(await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) {
      await client.query(`CREATE DATABASE ${name} OWNER ${migration}`);
    }
    await client.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO ${runtime}`);
    const own = createDatabase(migrationUrl);
    try {
      await own.transaction(async client => {
        await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
        await client.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
        await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}`);
        await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`);
        if ((await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present")).rows[0].present) {
          await client.query(`REVOKE ALL ON public.schema_migrations FROM ${runtime}`);
        }
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
          GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${runtime}`);
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
          GRANT USAGE,SELECT ON SEQUENCES TO ${runtime}`);
      });
    } finally { await own.close(); }
    return { migrationUrl, runtimeUrl, runtimeRole: runtime };
  } finally { client.release(true); await control.close(); }
}
