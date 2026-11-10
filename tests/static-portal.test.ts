import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../server/app.js';

it('serve a interface compilada sem converter erros de API em HTML', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'matraca-static-test-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Portal Matraca sintético</title>');
  const app = await createApp({ clientRoot: directory });
  try {
    const page = await app.inject({ url: '/app', headers: { host: 'matraca.localhost', accept: 'text/html' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Portal Matraca sintético');
    const api = await app.inject({ url: '/api/missing', headers: { host: 'matraca.localhost', accept: 'text/html' } });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/json');
    const unknown = await app.inject({ url: '/app', headers: { host: 'unknown.matraca.localhost', accept: 'text/html' } });
    expect(unknown.statusCode).toBe(404);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
