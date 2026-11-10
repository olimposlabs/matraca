import pg, { type PoolClient, type QueryResultRow } from 'pg';
export type Database = ReturnType<typeof createDatabase>;
export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 2000, statement_timeout: 10000 });
  pool.on('error', () => process.stderr.write('Conexão ociosa com banco local foi encerrada. A próxima operação tentará reconectar.\n'));
  return {
    pool,
    query: <T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) => pool.query<T>(text, values),
    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
