import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';

const defaultBranding = {
  displayName: 'Escola de teste', primary: '#4932a0', background: '#f4f2fc',
  surface: '#ffffff', text: '#14112b', muted: '#514b63', font: 'sans',
  creditSingular: 'Ficha', creditPlural: 'Fichas',
};
// Synthetic one-pixel PNG; contains no user media.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMQkdP4DwAB/gFaYeIFNgAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCegFAH/9k=', 'base64');
const webp = Buffer.from('UklGRi4AAABXRUJQVlA4ICIAAABwAQCdASoBAAEAAUAmJZQCdAFAAAD++3sItRJUvJ+iMAAA', 'base64');
interface Actor { host: string; orgId: string; userId: string; cookie: string }
const slug = () => `escola-${randomUUID().slice(0, 8)}`;
const requestHeaders = (actor: Actor) => ({ host: actor.host, origin: `http://${actor.host}`, cookie: actor.cookie, 'x-matraca-request': '1' });

describe('organizações, branding e publicação isolada', () => {
  let app: FastifyInstance;
  let controlDb: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let databaseUrl: string;
  let root: string;
  let operator: Actor;
  const schema = `organizations_test_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'matraca-organizations-'));
    const baseUrl = process.env.DATABASE_URL ?? localDatabaseUrl;
    controlDb = createDatabase(baseUrl);
    await controlDb.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(baseUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = isolatedUrl.toString();
    db = createDatabase(databaseUrl);
    const migrations = new URL('../server/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await db.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    operator = await tenant('operator', 'backoffice');
    app = await createApp({ databaseUrl, storageRoot: join(root, 'objects') });
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (controlDb) {
      try { await controlDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await controlDb.close(); }
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function tenant(role = 'org_admin', kind = 'partner'): Promise<Actor> {
    const id = randomUUID();
    const uniqueSlug = slug();
    const host = kind === 'backoffice' ? 'backoffice.localhost' : `${uniqueSlug}.localhost`;
    const branding = JSON.stringify({ ...defaultBranding, _revision: 0 });
    await db.query('INSERT INTO orgs (id,slug,name,kind,branding) VALUES ($1,$2,$3,$4,$5)', [id, uniqueSlug, 'Organização sintética', kind, branding]);
    await db.query('INSERT INTO domains (hostname,org_id) VALUES ($1,$2)', [host, id]);
    await db.query('INSERT INTO org_branding_history (org_id,revision,branding) VALUES ($1,0,$2)', [id, branding]);
    return actor(id, host, role);
  }

  async function actor(orgId: string, host: string, role: string): Promise<Actor> {
    const userId = randomUUID();
    await db.query("INSERT INTO users (id,org_id,email,name,roles,status) VALUES ($1,$2,$3,$4,$5,'active')", [userId, orgId, `${randomUUID()}@example.test`, 'Administrador teste', [role]]);
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO sessions (org_id,user_id,hostname,token_hash,expires_at) VALUES ($1,$2,$3,$4,now()+interval '1 hour')", [orgId, userId, host, createHash('sha256').update(token).digest('hex')]);
    return { orgId, host, userId, cookie: `matraca_session=${token}` };
  }

  async function manage(current: Actor) {
    const response = await app.inject({ method: 'GET', url: '/api/org/manage', headers: requestHeaders(current) });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  function publish(current: Actor, expectedRevision: number, branding: Record<string, unknown> = defaultBranding, url = '/api/org/branding') {
    return app.inject({ method: 'PUT', url, headers: requestHeaders(current), payload: { expectedRevision, branding } });
  }

  function upload(current: Actor, bytes = png, type = 'image/png') {
    const boundary = `matraca-${randomUUID()}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.png"\r\nContent-Type: ${type}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({ method: 'POST', url: '/api/org/logo', headers: { ...requestHeaders(current), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  }

  it('somente operador no backoffice pode listar e provisionar organizações', async () => {
    const admin = await tenant();
    expect((await app.inject({ method: 'GET', url: '/api/backoffice/orgs', headers: requestHeaders(admin) })).statusCode).toBe(403);
    const allowed = await app.inject({ method: 'GET', url: '/api/backoffice/orgs', headers: requestHeaders(operator) });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().orgs.some((org: { id: string }) => org.id === admin.orgId)).toBe(true);
    const deniedCreate = await app.inject({ method: 'POST', url: '/api/backoffice/orgs', headers: requestHeaders(admin), payload: { name: 'Outra', slug: slug(), adminName: 'Pessoa', adminEmail: 'person@example.test' } });
    expect(deniedCreate.statusCode).toBe(403);
  });

  it('backoffice não suspende a própria organização nem perde a sessão do operador', async () => {
    const response = await app.inject({ method: 'PATCH', url: `/api/backoffice/orgs/${operator.orgId}`, headers: requestHeaders(operator), payload: { status: 'suspended' } });
    expect(response.statusCode).toBe(400);
    expect((await db.query('SELECT status FROM orgs WHERE id=$1', [operator.orgId])).rows[0].status).toBe('active');
    const identity = await app.inject({ method: 'GET', url: '/api/auth/session', headers: requestHeaders(operator) });
    expect(identity.statusCode).toBe(200);
    expect(identity.json().user.roles).toEqual(['operator']);
    expect((await app.inject({ method: 'GET', url: '/api/backoffice/orgs', headers: requestHeaders(operator) })).statusCode).toBe(200);
  });

  it('provisionamento cria organização e administrador com login no próprio host', async () => {
    const createdSlug = slug();
    const email = `${randomUUID()}@example.test`;
    const response = await app.inject({ method: 'POST', url: '/api/backoffice/orgs', headers: requestHeaders(operator), payload: { name: 'Escola nova', slug: createdSlug, adminName: 'Gestor novo', adminEmail: email } });
    expect(response.statusCode).toBe(201);
    const created = response.json();
    const host = `${createdSlug}.matraca.localhost`;
    expect(created.org.hostname).toBe(host);
    const context = await app.inject({ method: 'GET', url: '/api/context', headers: { host } });
    expect(context.json().org.id).toBe(created.org.id);
    const linkRequest = await app.inject({ method: 'POST', url: '/api/auth/request', headers: { host, origin: `http://${host}`, 'x-matraca-request': '1' }, payload: { email } });
    expect(linkRequest.statusCode).toBe(202);
    const inbox = join(root, 'mailbox', created.org.id);
    const files = await readdir(inbox);
    expect(files.length).toBe(1);
    const mail = JSON.parse(await readFile(join(inbox, files[0]), 'utf8'));
    const token = new URL(mail.link).searchParams.get('token');
    const consumed = await app.inject({ method: 'GET', url: `/api/auth/consume?token=${encodeURIComponent(token!)}`, headers: { host } });
    expect(consumed.headers.location).toBe('/app');
    const cookie = String(consumed.headers['set-cookie']).split(';')[0];
    const identity = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { host, cookie } });
    expect(identity.statusCode).toBe(200);
    expect(identity.json().user.roles).toEqual(['org_admin']);
    expect(identity.json().org.id).toBe(created.org.id);
    expect((await app.inject({ method: 'GET', url: '/api/auth/session', headers: { host: operator.host, cookie } })).statusCode).toBe(401);
  });

  it.each(['matraca', 'backoffice', 'www', 'api', 'admin', '-escola', 'Maiuscula'])('rejeita slug reservado ou inválido %s', async reserved => {
    const response = await app.inject({ method: 'POST', url: '/api/backoffice/orgs', headers: requestHeaders(operator), payload: { name: 'Inválida', slug: reserved, adminName: 'Pessoa', adminEmail: `${randomUUID()}@example.test` } });
    expect(response.statusCode).toBe(400);
  });

  it('colisão de slug retorna409 sem criar administrador órfão', async () => {
    const createdSlug = slug();
    const initial = { name: 'Primeira', slug: createdSlug, adminName: 'Pessoa', adminEmail: `${randomUUID()}@example.test` };
    expect((await app.inject({ method: 'POST', url: '/api/backoffice/orgs', headers: requestHeaders(operator), payload: initial })).statusCode).toBe(201);
    const email = `${randomUUID()}@example.test`;
    const duplicate = await app.inject({ method: 'POST', url: '/api/backoffice/orgs', headers: requestHeaders(operator), payload: { ...initial, adminEmail: email } });
    expect(duplicate.statusCode).toBe(409);
    expect((await db.query('SELECT id FROM users WHERE email=$1', [email])).rowCount).toBe(0);
    expect((await db.query('SELECT id FROM orgs WHERE slug=$1', [createdSlug])).rowCount).toBe(1);
  });

  it('administrador não acessa outra organização pela API central; operador pode administrá-la', async () => {
    const first = await tenant();
    const second = await tenant();
    const url = `/api/backoffice/orgs/${second.orgId}`;
    expect((await app.inject({ method: 'GET', url, headers: requestHeaders(first) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url, headers: requestHeaders(first), payload: { name: 'Intrusão' } })).statusCode).toBe(403);
    const changed = await app.inject({ method: 'PATCH', url, headers: requestHeaders(operator), payload: { name: 'Nome autorizado', settings: { coursesEnabled: false } } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().org.name).toBe('Nome autorizado');
    expect(changed.json().org.settings.coursesEnabled).toBe(false);
    const current = await manage(second);
    const branding = await publish(operator, current.org.branding._revision, defaultBranding, `${url}/branding`);
    expect(branding.statusCode).toBe(200);
    expect(branding.json().brandingHistory.some((entry: { actorId: string }) => entry.actorId === operator.userId)).toBe(true);
    const immutable = await app.inject({ method: 'PATCH', url, headers: requestHeaders(operator), payload: { slug: 'outro-dominio', kind: 'backoffice' } });
    expect(immutable.statusCode).toBe(400);
  });

  it.each(['student', 'teacher', 'school'])('papel %s não gerencia branding nem configurações da organização', async role => {
    const current = await tenant(role);
    expect((await app.inject({ method: 'GET', url: '/api/org/manage', headers: requestHeaders(current) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/api/org/settings', headers: requestHeaders(current), payload: { coursesEnabled: false } })).statusCode).toBe(403);
    expect((await publish(current, 0)).statusCode).toBe(403);
    expect((await upload(current)).statusCode).toBe(403);
  });

  it('flags persistem no próprio contexto e rejeitam campos não configuráveis', async () => {
    const first = await tenant();
    const second = await tenant();
    const before = await manage(second);
    const flags = { coursesEnabled: false, strictJourney: true, leaderboardEnabled: false, diagnosticEnabled: true };
    const response = await app.inject({ method: 'PATCH', url: '/api/org/settings', headers: requestHeaders(first), payload: flags });
    expect(response.statusCode).toBe(200);
    expect(response.json().org.settings).toMatchObject(flags);
    expect((await manage(first)).org.settings).toMatchObject(flags);
    expect((await manage(second)).org.settings).toEqual(before.org.settings);
    const forbidden = await app.inject({ method: 'PATCH', url: '/api/org/settings', headers: requestHeaders(first), payload: { kind: 'backoffice', coursesEnabled: true } });
    expect(forbidden.statusCode).toBe(400);
  });

  it('publicação persiste, aparece no contexto público e não altera outro tenant', async () => {
    const first = await tenant();
    const second = await tenant();
    const before = await manage(second);
    const current = await manage(first);
    const published = await publish(first, current.org.branding._revision);
    expect(published.statusCode).toBe(200);
    expect(published.json().org.branding).toMatchObject(defaultBranding);
    expect((await manage(second)).org.branding).toEqual(before.org.branding);
    const restarted = await createApp({ databaseUrl, storageRoot: join(root, 'objects') });
    try {
      const context = await restarted.inject({ method: 'GET', url: '/api/context', headers: { host: first.host } });
      expect(context.json().org.branding).toMatchObject(defaultBranding);
    } finally { await restarted.close(); }
  });

  it('restauração cria nova revisão e mantém o histórico anterior', async () => {
    const current = await tenant();
    const baseline = await manage(current);
    const first = (await publish(current, baseline.org.branding._revision)).json();
    const firstRevision = first.org.branding._revision;
    const second = await publish(current, firstRevision, { ...defaultBranding, displayName: 'Segundo nome' });
    expect(second.statusCode).toBe(200);
    const restored = await app.inject({ method: 'POST', url: '/api/org/branding/restore', headers: requestHeaders(current), payload: { revision: firstRevision, expectedRevision: second.json().org.branding._revision } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().org.branding.displayName).toBe(defaultBranding.displayName);
    expect(restored.json().org.branding._revision).toBe(second.json().org.branding._revision + 1);
    expect(restored.json().brandingHistory.some((entry: { revision: number; branding: { displayName: string } }) => entry.revision === firstRevision && entry.branding.displayName === defaultBranding.displayName)).toBe(true);
    const stale = await app.inject({ method: 'POST', url: '/api/org/branding/restore', headers: requestHeaders(current), payload: { revision: firstRevision, expectedRevision: second.json().org.branding._revision } });
    expect(stale.statusCode).toBe(409);
    expect((await manage(current)).org.branding._revision).toBe(restored.json().org.branding._revision);
  });

  it('duas publicações com mesma revisão geram um sucesso e um409', async () => {
    const current = await tenant();
    const baseline = await manage(current);
    const revision = baseline.org.branding._revision;
    const results = await Promise.all([
      publish(current, revision, { ...defaultBranding, displayName: 'Nome A' }),
      publish(current, revision, { ...defaultBranding, displayName: 'Nome B' }),
    ]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const after = await manage(current);
    expect(after.org.branding._revision).toBe(revision + 1);
    expect(after.brandingHistory.length).toBe(baseline.brandingHistory.length + 1);
  });

  it.each([
    { primary: 'url(https://evil.example/logo)' },
    { primary: '#fff; background: url(https://evil.example)' },
    { background: '#ffffff', text: '#ffffff' },
    { muted: '#fafafa' },
    { font: 'url(https://evil.example/font)' },
    { customCss: 'body{display:none}' },
    { _revision: 999 },
  ])('rejeita branding inseguro ou sem contraste %#', async invalid => {
    const current = await tenant();
    const baseline = await manage(current);
    const response = await publish(current, baseline.org.branding._revision, { ...defaultBranding, ...invalid });
    expect(response.statusCode).toBe(400);
    expect((await manage(current)).org.branding).toEqual(baseline.org.branding);
  });

  it('logo é validado, preparado e só se torna público após publicação', async () => {
    const first = await tenant();
    const second = await tenant();
    const baseline = await manage(first);
    const staged = await upload(first);
    expect(staged.statusCode).toBe(201);
    const logo = staged.json();
    expect(logo.contentType).toBe('image/webp');
    expect(logo.width).toBeGreaterThan(0);
    const getLogo = (host: string) => app.inject({ method: 'GET', url: '/api/branding/logo', headers: { host } });
    expect((await getLogo(first.host)).statusCode).toBe(404);
    expect((await manage(first)).org.branding._revision).toBe(baseline.org.branding._revision);
    expect((await publish(first, baseline.org.branding._revision, { ...defaultBranding, logoKey: logo.logoKey })).statusCode).toBe(200);
    const publicLogo = await getLogo(first.host);
    expect(publicLogo.statusCode).toBe(200);
    expect(publicLogo.headers['content-type']).toContain('image/webp');
    expect(publicLogo.headers['x-content-type-options']).toBe('nosniff');
    expect(publicLogo.rawPayload.length).toBeGreaterThan(0);
    expect((await getLogo(second.host)).statusCode).toBe(404);
    const secondState = await manage(second);
    const stolen = await publish(second, secondState.org.branding._revision, { ...defaultBranding, logoKey: logo.logoKey });
    expect([400, 403, 404]).toContain(stolen.statusCode);
    expect((await getLogo(second.host)).statusCode).toBe(404);
    const suspended = await app.inject({ method: 'PATCH', url: `/api/backoffice/orgs/${first.orgId}`, headers: requestHeaders(operator), payload: { status: 'suspended' } });
    expect(suspended.statusCode).toBe(200);
    expect((await getLogo(first.host)).statusCode).toBe(404);
  });

  it('SVG, conteúdo disfarçado, MIME incompatível e upload acima2MiB são rejeitados', async () => {
    const current = await tenant();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await upload(current, svg, 'image/svg+xml')).statusCode).toBe(415);
    expect([400, 415]).toContain((await upload(current, svg, 'image/png')).statusCode);
    expect((await upload(current, png.subarray(0, 32), 'image/png')).statusCode).toBe(400);
    expect((await upload(current, png, 'image/jpeg')).statusCode).toBe(415);
    expect((await upload(current, Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]))).statusCode).toBe(413);
    expect((await db.query('SELECT id FROM logo_assets WHERE org_id=$1', [current.orgId])).rowCount).toBe(0);
  });

  it.each([{ bytes: jpeg, type: 'image/jpeg' }, { bytes: webp, type: 'image/webp' }])('aceita logo sintético $type e normaliza para WebP', async ({ bytes, type }) => {
    const current = await tenant();
    const response = await upload(current, bytes, type);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ contentType: 'image/webp', width: 1, height: 1 });
  });

  it('multipart permite imagem válida acima1MiB e abaixo do limite2MiB', async () => {
    const current = await tenant();
    const largePng = await sharp(randomBytes(650 * 650 * 3), { raw: { width: 650, height: 650, channels: 3 } }).png().toBuffer();
    expect(largePng.length).toBeGreaterThan(1024 * 1024);
    expect(largePng.length).toBeLessThan(2 * 1024 * 1024);
    const response = await upload(current, largePng);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ contentType: 'image/webp', width: 650, height: 650 });
  });
});
