import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { createApp } from '../server/app.js';
import { createDatabase } from '../server/db.js';
import { testDatabaseUrl } from '../server/local-database-config.js';

function checkDocument(headers: OutgoingHttpHeaders, dev = false) {
  assert.equal(headers['x-frame-options'], 'DENY');
  const policy = String(headers['content-security-policy'] ?? '');
  const directives = new Map(policy.split('; ').map(part => {
    const [name, ...sources] = part.split(' ');
    return [name, sources];
  }));
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('media-src'), ["'self'", 'blob:']);
  if (dev) assert.match(directives.get('script-src')?.[1] ?? '', /^'sha256-[A-Za-z0-9+/]+=*'$/u);
  else assert.deepEqual(directives.get('script-src'), ["'self'"]);
}

const schema = `web_security_${randomUUID().replaceAll('-', '')}`;
const baseUrl = testDatabaseUrl();
const control = createDatabase(baseUrl);
const source = new URL(baseUrl);
source.searchParams.set('options', `-c search_path=${schema}`);
const app = await createApp({ databaseUrl: source.href });
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  await app.db.query(await readFile(new URL('../server/migrations/002_identity.sql', import.meta.url), 'utf8'));
  await app.db.query(`INSERT INTO orgs(slug,name,kind) VALUES
    ('matraca','Matraca','matraca'),('partner','Parceiro sintético','partner'),('backoffice','Operação sintética','backoffice');
    INSERT INTO domains(hostname,org_id) SELECT hostname,o.id FROM orgs o JOIN (VALUES
      ('localhost','matraca'),('partner.matraca.localhost','partner'),('backoffice.matraca.localhost','backoffice')
    ) AS fixture(hostname,slug) ON fixture.slug=o.slug`);
  for (const [host, path] of [
    ['localhost', '/'],
    ['partner.matraca.localhost', '/app/recordings'],
    ['backoffice.matraca.localhost', '/backoffice'],
  ]) {
    const response = await app.inject({ method: 'GET', url: path, headers: { host, accept: 'text/html' } });
    assert.equal(response.statusCode, 200, `Documento de ${path}`);
    assert.match(response.body, /<script type="module"[^>]+src="\/assets\//u);
    checkDocument(response.headers);
  }
} finally {
  await app.close();
  try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
  finally { await control.close(); }
}

const vite = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: true } });
try {
  await vite.listen();
  const { port } = vite.httpServer!.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /Content Security Policy/u.test(message.text())) errors.push(message.text());
    });
    let connected = false;
    page.on('websocket', socket => socket.on('framereceived', frame => {
      if (String(frame.payload).includes('"type":"connected"')) connected = true;
    }));
    await page.route('**/api/**', async route => {
      if (new URL(route.request().url()).pathname === '/api/context') {
        await route.fulfill({ json: { org: { id: 'fixture', slug: 'matraca', name: 'Matraca', kind: 'matraca', branding: {}, settings: {} } } });
      } else await route.fulfill({ status: 401, json: { error: 'Fixture sem sessão' } });
    });
    const response = await page.goto(base);
    assert.ok(response);
    checkDocument(response.headers(), true);
    await expect(page.locator('#root').getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect.poll(() => connected).toBe(true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
} finally { await vite.close(); }
process.stdout.write('CSP e bloqueio de frames no build. Vite carregou React e conectou HMR com a política restrita.\n');
