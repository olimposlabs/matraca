import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';

const hosts = ['localhost', 'parceiro.localhost', 'empresa.localhost', 'backoffice.localhost'] as const;
type Host = typeof hosts[number];
const orgIds = new Map<Host, string>(hosts.map(host => [host, randomUUID()]));
const headers = (host: string) => ({ host, origin: `http://${host}`, 'x-matraca-request': '1' });
interface Mail { link: string; to: string; orgId: string; hostname: string }

/** All application writes use a random PostgreSQL schema and a private temp directory. */
describe('identidade isolada por organização e host', () => {
  let app: FastifyInstance;
  let controlDb: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let databaseUrl: string;
  let root: string;
  const schema = `identity_test_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'matraca-identity-'));
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
    for (const [index, host] of hosts.entries()) {
      await db.query('INSERT INTO orgs (id,slug,name,kind) VALUES ($1,$2,$3,$4)', [
        orgIds.get(host), `test-org-${index}`, `Organização teste ${index}`,
        index === 0 ? 'matraca' : index === 3 ? 'backoffice' : 'partner',
      ]);
      await db.query('INSERT INTO domains (hostname,org_id) VALUES ($1,$2)', [host, orgIds.get(host)]);
    }
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

  async function user(host: Host, options: { email?: string; roles?: string[]; status?: string } = {}) {
    const id = randomUUID();
    const email = options.email ?? `${randomUUID()}@example.test`;
    await db.query('INSERT INTO users (id,org_id,email,name,roles,status) VALUES ($1,$2,$3,$4,$5,$6)', [
      id, orgIds.get(host), email, 'Pessoa de teste', options.roles ?? ['student'], options.status ?? 'active',
    ]);
    return { id, email };
  }

  async function mailbox(host: Host) {
    const path = join(root, 'mailbox', orgIds.get(host)!);
    const files = await readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    return { path, files };
  }

  async function requestLink(host: Host, email: string) {
    const before = await mailbox(host);
    const response = await app.inject({ method: 'POST', url: '/api/auth/request', headers: headers(host), payload: { email } });
    expect(response.statusCode).toBe(202);
    expect(response.body.includes('token=')).toBe(false);
    const after = await mailbox(host);
    const added = after.files.filter(file => !before.files.includes(file));
    expect(added.length).toBe(1);
    const file = join(after.path, added[0]);
    const mail = JSON.parse(await readFile(file, 'utf8')) as Mail;
    expect(mail.orgId).toBe(orgIds.get(host));
    expect(mail.hostname).toBe(host);
    const token = new URL(mail.link).searchParams.get('token');
    expect(Boolean(token)).toBe(true);
    return { token: token!, file, mail };
  }

  function consume(host: Host, token: string) {
    return app.inject({ method: 'GET', url: `/api/auth/consume?token=${encodeURIComponent(token)}`, headers: { host } });
  }

  function cookie(header: string | string[] | number | undefined) {
    const value = Array.isArray(header) ? header[0] : header;
    expect(typeof value).toBe('string');
    return String(value).split(';')[0];
  }

  async function login(host: Host, email: string) {
    const mail = await requestLink(host, email);
    const response = await consume(host, mail.token);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(host === 'backoffice.localhost' ? '/backoffice' : '/app');
    return { cookie: cookie(response.headers['set-cookie']), response, ...mail };
  }

  function session(host: Host, sessionCookie?: string) {
    return app.inject({ method: 'GET', url: '/api/auth/session', headers: { host, ...(sessionCookie ? { cookie: sessionCookie } : {}) } });
  }

  it.each(hosts)('resolve apenas a organização vinculada a %s', async host => {
    const response = await app.inject({ method: 'GET', url: '/api/context', headers: { host } });
    expect(response.statusCode).toBe(200);
    expect(response.json().org.id).toBe(orgIds.get(host));
  });

  it('rejeita host sem organização e sessão anônima', async () => {
    const unknown = await app.inject({ method: 'GET', url: '/api/context', headers: { host: 'desconhecido.localhost' } });
    expect(unknown.statusCode).toBe(404);
    expect((await session('localhost')).statusCode).toBe(401);
  });

  it('cadastro público concede somente student na organização Matraca', async () => {
    const email = `${randomUUID()}@example.test`;
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers('localhost'), payload: { name: 'Aluno novo', email } });
    expect(response.statusCode).toBe(202);
    expect(response.body.includes('token=')).toBe(false);
    const result = await db.query('SELECT org_id,roles FROM users WHERE email=$1', [email]);
    expect(result.rows).toEqual([{ org_id: orgIds.get('localhost'), roles: ['student'] }]);
  });

  it('não aceita cadastro público em parceiro nem elevação de papel por payload', async () => {
    const email = `${randomUUID()}@example.test`;
    const partner = await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers('parceiro.localhost'), payload: { name: 'Intruso', email } });
    expect(partner.statusCode).toBe(403);
    const elevation = await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers('localhost'), payload: { name: 'Intruso', email, roles: ['operator', 'org_admin'], orgId: orgIds.get('parceiro.localhost') } });
    expect(elevation.statusCode).toBe(400);
    expect((await db.query('SELECT id FROM users WHERE email=$1', [email])).rowCount).toBe(0);
  });

  it('pedido de link não revela existência nem suspensão da conta', async () => {
    const active = await user('localhost');
    const suspended = await user('localhost', { status: 'suspended' });
    const bodies: string[] = [];
    for (const email of [active.email, suspended.email, `${randomUUID()}@example.test`]) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/request', headers: headers('localhost'), payload: { email } });
      expect(response.statusCode).toBe(202);
      expect(response.body.includes('token=')).toBe(false);
      bodies.push(response.body);
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('novo cadastro não reativa uma conta suspensa existente', async () => {
    const account = await user('localhost', { status: 'suspended' });
    const before = await mailbox('localhost');
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers('localhost'), payload: { name: 'Outro nome', email: account.email } });
    expect(response.statusCode).toBe(202);
    expect((await db.query('SELECT status,name FROM users WHERE id=$1', [account.id])).rows[0]).toEqual({ status: 'suspended', name: 'Pessoa de teste' });
    expect((await mailbox('localhost')).files.length).toBe(before.files.length);
  });

  it('consumir convite ativa o usuário e preserva os papéis atribuídos', async () => {
    const account = await user('parceiro.localhost', { status: 'invited', roles: ['teacher'] });
    const signedIn = await login('parceiro.localhost', account.email);
    expect((await db.query('SELECT status FROM users WHERE id=$1', [account.id])).rows[0].status).toBe('active');
    expect((await session('parceiro.localhost', signedIn.cookie)).json().user.roles).toEqual(['teacher']);
  });

  it('mesmo e-mail em três organizações tem contas e sessões independentes', async () => {
    const email = `${randomUUID()}@example.test`;
    const orgHosts: Host[] = ['localhost', 'parceiro.localhost', 'empresa.localhost'];
    for (const host of orgHosts) {
      const account = await user(host, { email });
      const signedIn = await login(host, email);
      const own = await session(host, signedIn.cookie);
      expect(own.statusCode).toBe(200);
      expect(own.json().user.id).toBe(account.id);
      expect(own.json().org.id).toBe(orgIds.get(host));
      for (const other of hosts.filter(value => value !== host)) {
        expect((await session(other, signedIn.cookie)).statusCode).toBe(401);
      }
    }
  });

  it('operador autentica separadamente no backoffice', async () => {
    const operator = await user('backoffice.localhost', { roles: ['operator'] });
    const signedIn = await login('backoffice.localhost', operator.email);
    expect((await session('backoffice.localhost', signedIn.cookie)).json().user.roles).toEqual(['operator']);
    expect((await session('localhost', signedIn.cookie)).statusCode).toBe(401);
  });

  it.each([
    { host: 'backoffice.localhost' as Host, roles: ['student'] },
    { host: 'parceiro.localhost' as Host, roles: ['operator'] },
  ])('papéis incompatíveis com $host não recebem link de acesso', async ({ host, roles }) => {
    const account = await user(host, { roles });
    const before = await mailbox(host);
    const response = await app.inject({ method: 'POST', url: '/api/auth/request', headers: headers(host), payload: { email: account.email } });
    expect(response.statusCode).toBe(202);
    expect((await mailbox(host)).files.length).toBe(before.files.length);
  });

  it('token apresentado em outro host falha sem consumir o acesso no host correto', async () => {
    const account = await user('localhost');
    const mail = await requestLink('localhost', account.email);
    const wrong = await consume('parceiro.localhost', mail.token);
    expect(wrong.headers.location).toBe('/login?error=invalid_link');
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect((await consume('localhost', mail.token)).headers.location).toBe('/app');
  });

  it('token consumido não pode ser usado novamente', async () => {
    const account = await user('localhost');
    const signedIn = await login('localhost', account.email);
    const replay = await consume('localhost', signedIn.token);
    expect(replay.headers.location).toBe('/login?error=invalid_link');
    expect(replay.headers['set-cookie']).toBeUndefined();
  });

  it('duas requisições simultâneas consomem o token uma única vez', async () => {
    const account = await user('localhost');
    const mail = await requestLink('localhost', account.email);
    const responses = await Promise.all([consume('localhost', mail.token), consume('localhost', mail.token)]);
    expect(responses.map(response => response.headers.location).sort()).toEqual(['/app', '/login?error=invalid_link']);
    expect(responses.filter(response => response.headers['set-cookie']).length).toBe(1);
    expect((await db.query('SELECT id FROM sessions WHERE user_id=$1', [account.id])).rowCount).toBe(1);
  });

  it('token expirado não cria sessão', async () => {
    const account = await user('localhost');
    const mail = await requestLink('localhost', account.email);
    await db.query("UPDATE auth_tokens SET created_at=now()-interval '30 minutes', expires_at=now()-interval '1 minute' WHERE user_id=$1", [account.id]);
    expect((await consume('localhost', mail.token)).headers.location).toBe('/login?error=invalid_link');
    expect((await db.query('SELECT id FROM sessions WHERE user_id=$1', [account.id])).rowCount).toBe(0);
  });

  it('suspensão posterior à emissão do link impede criar sessão', async () => {
    const account = await user('localhost');
    const mail = await requestLink('localhost', account.email);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [account.id]);
    expect((await consume('localhost', mail.token)).headers.location).toBe('/login?error=invalid_link');
    expect((await db.query('SELECT id FROM sessions WHERE user_id=$1', [account.id])).rowCount).toBe(0);
  });

  it('cookie é restrito ao host, HTTP-only e protegido contra uso entre sites', async () => {
    const account = await user('localhost');
    const signedIn = await login('localhost', account.email);
    const raw = String(signedIn.response.headers['set-cookie']);
    expect(/httponly/i.test(raw)).toBe(true);
    expect(/samesite=(lax|strict)/i.test(raw)).toBe(true);
    expect(/(?:^|;)\s*domain=/i.test(raw)).toBe(false);
    expect(/path=\//i.test(raw)).toBe(true);
  });

  it('suspender usuário revoga imediatamente o acesso da sessão existente', async () => {
    const account = await user('parceiro.localhost');
    const signedIn = await login('parceiro.localhost', account.email);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [account.id]);
    expect((await session('parceiro.localhost', signedIn.cookie)).statusCode).toBe(401);
  });

  it('suspender organização bloqueia as sessões existentes', async () => {
    const account = await user('empresa.localhost');
    const signedIn = await login('empresa.localhost', account.email);
    await db.query("UPDATE orgs SET status='suspended' WHERE id=$1", [orgIds.get('empresa.localhost')]);
    try {
      expect((await session('empresa.localhost', signedIn.cookie)).statusCode).toBe(401);
    } finally {
      await db.query("UPDATE orgs SET status='active' WHERE id=$1", [orgIds.get('empresa.localhost')]);
    }
  });

  it('papéis atuais são lidos do banco a cada consulta da sessão', async () => {
    const account = await user('parceiro.localhost', { roles: ['org_admin'] });
    const signedIn = await login('parceiro.localhost', account.email);
    await db.query('UPDATE users SET roles=$1 WHERE id=$2', [['student'], account.id]);
    const current = await session('parceiro.localhost', signedIn.cookie);
    expect(current.statusCode).toBe(200);
    expect(current.json().user.roles).toEqual(['student']);
  });

  it('sessão expirada e logout impedem reutilização do cookie', async () => {
    const account = await user('localhost');
    const expired = await login('localhost', account.email);
    await db.query("UPDATE sessions SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 minute' WHERE user_id=$1", [account.id]);
    expect((await session('localhost', expired.cookie)).statusCode).toBe(401);
    const fresh = await login('localhost', account.email);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers('localhost'), cookie: fresh.cookie } });
    expect(logout.statusCode).toBeLessThan(300);
    expect(logout.headers['set-cookie']).toBeDefined();
    expect((await session('localhost', fresh.cookie)).statusCode).toBe(401);
  });

  it('sessão persiste após recriar a aplicação com o mesmo banco', async () => {
    const account = await user('localhost');
    const signedIn = await login('localhost', account.email);
    const restarted = await createApp({ databaseUrl, storageRoot: join(root, 'objects') });
    try {
      const response = await restarted.inject({ method: 'GET', url: '/api/auth/session', headers: { host: 'localhost', cookie: signedIn.cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.id).toBe(account.id);
    } finally { await restarted.close(); }
  });

  it('mutações exigem header explícito e rejeitam origem externa ou malformada', async () => {
    const email = `${randomUUID()}@example.test`;
    const attempts = [
      { host: 'localhost' },
      { ...headers('localhost'), origin: 'https://evil.example' },
      { ...headers('localhost'), origin: 'not-an-origin' },
      { ...headers('localhost'), origin: 'http://parceiro.localhost' },
    ];
    for (const attempt of attempts) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/request', headers: attempt, payload: { email } });
      expect(response.statusCode).toBe(403);
    }
  });

  it('token fica somente na caixa privada; banco guarda hash e arquivos têm permissões restritas', async () => {
    const account = await user('localhost');
    const mail = await requestLink('localhost', account.email);
    const stored = await db.query('SELECT token_hash FROM auth_tokens WHERE user_id=$1', [account.id]);
    expect(stored.rows[0].token_hash === mail.token).toBe(false);
    expect(stored.rows[0].token_hash === createHash('sha256').update(mail.token).digest('hex')).toBe(true);
    expect((await stat(mail.file)).mode & 0o777).toBe(0o600);
    expect((await stat((await mailbox('localhost')).path)).mode & 0o777).toBe(0o700);
    const exposed = await app.inject({ method: 'GET', url: '/api/mailbox', headers: { host: 'localhost' } });
    expect(exposed.statusCode).toBe(404);
  });

  it('repetir pedidos além do limite não produz mais links nem revela o bloqueio', async () => {
    const account = await user('localhost');
    const before = await mailbox('localhost');
    const bodies = new Set<string>();
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/request', headers: headers('localhost'), payload: { email: account.email } });
      expect(response.statusCode).toBe(202);
      bodies.add(response.body);
    }
    const after = await mailbox('localhost');
    expect(after.files.filter(file => !before.files.includes(file)).length).toBe(5);
    expect(bodies.size).toBe(1);
  });
});
