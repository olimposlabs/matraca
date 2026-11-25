import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDatabase } from '../server/db.js';
import { migrationDatabaseUrl } from '../server/local-database-config.js';
const db = createDatabase(migrationDatabaseUrl());
try {
  await db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(64281291)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const name of (await readdir(new URL('../server/migrations/', import.meta.url))).filter(x => x.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (previous.rowCount) { if (previous.rows[0].checksum !== checksum) throw new Error(`Migração já aplicada foi alterada: ${name}`); continue; }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name,checksum) VALUES ($1,$2)', [name, checksum]);
      process.stdout.write(`Migração aplicada ${name}\n`);
    }
    const owner = (await client.query<{ name: string }>('SELECT current_user AS name')).rows[0].name;
    if (/^matraca_migrate_[a-f0-9]{20}$/u.test(owner)) {
      const runtime = owner.replace(/^matraca_migrate_/u, 'matraca_app_');
      await client.query(`REVOKE ALL ON schema_migrations FROM ${runtime}`);
    }
  });
} finally { await db.close(); }
