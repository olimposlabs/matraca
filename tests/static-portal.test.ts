import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { createDatabase } from '../server/db.js';
import { testDatabaseUrl } from '../server/local-database-config.js';

it('serve a interface compilada sem converter erros de API em HTML', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'matraca-static-test-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Portal Matraca sintético</title>');
  const schema = `static_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(testDatabaseUrl());
  const control = createDatabase(url.href);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(url.href);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    for (const name of ['001_foundation.sql','002_identity.sql']) {
      await db.query(await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8'));
    }
    const org = (await db.query("INSERT INTO orgs(slug,name,kind) VALUES('static','Portal de teste','matraca') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO domains(hostname,org_id) VALUES('matraca.localhost',$1)", [org]);
    app = await createApp({ databaseUrl: url.href, clientRoot: directory });
    const page = await app.inject({ url: '/app', headers: { host: 'matraca.localhost', accept: 'text/html' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Portal Matraca sintético');
    const api = await app.inject({ url: '/api/missing', headers: { host: 'matraca.localhost', accept: 'text/html' } });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/json');
    const unknown = await app.inject({ url: '/app', headers: { host: 'unknown.matraca.localhost', accept: 'text/html' } });
    expect(unknown.statusCode).toBe(404);
  } finally {
    await app?.close();
    await db.close();
    try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});
