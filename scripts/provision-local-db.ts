import type { PoolClient } from 'pg';
import { createDatabase } from '../server/db.js';
import { localDatabaseConnection, localDatabaseNames, pendingRoleRotation } from '../server/local-database-config.js';

async function ensureRole(client: PoolClient, profile: string, kind: 'migration' | 'runtime', role: string, rotate = false) {
  // Profile role names and passwords come from hex strings generated locally.
  const attributes = 'LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
  if (exists.rowCount) {
    const rotation = pendingRoleRotation(kind, profile, rotate);
    await client.query(`ALTER ROLE ${role} ${attributes}${rotation ? ` PASSWORD '${rotation.password}'` : ''}`);
    rotation?.commit();
  } else {
    const { password } = new URL(localDatabaseConnection(kind, profile, true));
    await client.query(`CREATE ROLE ${role} ${attributes} PASSWORD '${password}'`);
  }
  return localDatabaseConnection(kind, profile);
}

export async function provisionLocalDatabase(profile: string, { rotateRuntime = false } = {}) {
  const { name, migration, runtime } = localDatabaseNames(profile);
  const bootstrap = localDatabaseConnection('bootstrap');
  const control = createDatabase(bootstrap);
  const client = await control.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,19))', [name]);
    await client.query('REVOKE CONNECT ON DATABASE postgres,template1 FROM PUBLIC');
    const migrationUrl = await ensureRole(client, profile, 'migration', migration);
    const runtimeUrl = await ensureRole(client, profile, 'runtime', runtime, rotateRuntime);
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
