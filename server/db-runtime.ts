import { createHash } from 'node:crypto';
import type { Database } from './db.js';

/** Services use a login granted application DML on one database. Administrative logins are kept out of the API. */
export async function requireRuntimeDatabase(db: Database, databaseUrl: string) {
  let password: string;
  try { password = decodeURIComponent(new URL(databaseUrl).password); }
  catch { throw new Error('A conexão PostgreSQL do runtime é inválida.'); }
  const knownDemoPassword = '686182b231c6a07cbce84d2d9017b29a5c20be739e43d3756e6267928f6e1a49';
  if (createHash('sha256').update(password).digest('hex') === knownDemoPassword) {
    throw new Error('A credencial antiga de demonstração precisa ser substituída antes de iniciar a API.');
  }
  const result = await db.query<{ restricted: boolean }>(`
    SELECT NOT EXISTS (
      SELECT 1 FROM pg_roles r
      WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
        (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR
         r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_monitor','pg_read_all_stats',
          'pg_read_server_files','pg_write_server_files','pg_execute_server_program'))
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'MEMBER')
    ) AND to_regclass('schema_migrations') IS NOT NULL AND NOT has_database_privilege(current_database(),'CREATE')
      AND NOT has_schema_privilege(current_schema(),'CREATE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c WHERE c.relname='schema_migrations'
        AND c.relnamespace=current_schema()::regnamespace
        AND has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
      ) AS restricted
  `);
  if (!result.rows[0]?.restricted) {
    throw new Error('A API exige um papel de runtime do PostgreSQL sem privilégios administrativos.');
  }
}
