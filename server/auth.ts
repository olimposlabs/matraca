import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { z } from 'zod';
import { grantInitialCreditInTransaction } from './wallet.js';
import { localHostname } from './config.js';
import { readOperationPolicy } from './operation-policy.js';
import { loginRateOrigin } from './request-origin.js';

export type IdentityRole = 'student' | 'teacher' | 'school' | 'org_admin' | 'operator';
export type OrganizationKind = 'matraca' | 'partner' | 'backoffice';
export interface IdentityOrg {
  id: string;
  slug: string;
  name: string;
  kind: OrganizationKind;
  settings: Record<string, unknown>;
  branding: Record<string, unknown>;
}
export interface AuthIdentity {
  user: { id: string; name: string; email: string; roles: IdentityRole[]; orgId: string };
  org: IdentityOrg;
}
interface IdentityContext {
  org: IdentityOrg;
  hostname: string;
  status: 'active' | 'suspended';
}
interface OrgRow extends IdentityOrg { status: IdentityContext['status']; hostname: string }
interface UserRow {
  id: string;
  email: string;
  name: string;
  roles: IdentityRole[];
  status: 'invited' | 'active' | 'suspended';
}
export interface LocalMail {
  id: string;
  orgId: string;
  hostname: string;
  to: string;
  subject: string;
  purpose: 'login' | 'invite';
  createdAt: string;
  expiresAt: string;
  link: string;
}

declare module 'fastify' {
  interface FastifyRequest { identityContext: IdentityContext | null }
}

export class IdentityError extends Error {
  constructor(public readonly statusCode: 400 | 401 | 403 | 404, message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

const COOKIE = 'matraca_session';
const INTENT_COOKIE_PREFIX = 'matraca_login_intent_';
const INTENT_SECONDS = 15 * 60;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const tokenSchema = z.object({ token: z.string().regex(TOKEN_PATTERN) }).strict();
const ACCEPTED = { message: 'Se o acesso estiver disponível, você receberá um link na caixa de e-mail local.' };
const email = z.string().trim().max(254).email().transform((value) => value.toLowerCase());
const requestSchema = z.object({ email }).strict();
const registerSchema = z.object({ email, name: z.string().trim().min(1).max(120) }).strict();

export function mailboxRoot(storageRoot: string): string {
  return join(dirname(storageRoot), 'mailbox');
}

export async function registerIdentity(app: FastifyInstance): Promise<void> {
  const publicPort = Number(process.env.APP_PUBLIC_PORT ?? 5173);
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
    throw new Error('APP_PUBLIC_PORT deve ser uma porta local válida.');
  }
  app.decorateRequest('identityContext', null);
  app.addHook('onRequest', async (request) => {
    if (request.url.split('?')[0] === '/api/health') return;
    request.identityContext = await resolveContext(request);
    if (!request.identityContext) throw new IdentityError(404, 'Organização não encontrada.');
  });

  app.get('/api/context', async (request) => ({ org: context(request).org }));
  const cleanRates = setInterval(() => {
    void app.db.query("DELETE FROM auth_rate_limits WHERE window_started_at<=clock_timestamp()-interval '15 minutes'").catch(() => {});
  }, 60_000);
  cleanRates.unref();
  app.addHook('onClose', async () => { clearInterval(cleanRates); });

  app.post('/api/auth/register', async (request, reply) => {
    assertMutation(request);
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError(400, 'Informe nome e e-mail válidos.');
    const current = context(request);
    if (current.org.kind !== 'matraca' || current.status !== 'active') {
      throw new IdentityError(403, 'O cadastro desta organização é feito por convite.');
    }
    const intent = randomBytes(32).toString('base64url');
    let admitted = false;
    let written: string | undefined;
    try {
      await app.db.transaction(async (client) => {
        if (!await permitRequest(client, current.hostname, loginRateOrigin(request), true)) return;
        admitted = true;
        const organization = await client.query(
          "SELECT id FROM orgs WHERE id=$1 AND kind='matraca' AND status='active' FOR SHARE",
          [current.org.id],
        );
        if (!organization.rowCount) return;
        const created = await client.query<{ id: string }>(
          `INSERT INTO users (org_id,email,name,roles,status) VALUES ($1,$2,$3,ARRAY['student'],'invited')
           ON CONFLICT (org_id,email) DO NOTHING RETURNING id`,
          [current.org.id, parsed.data.email, parsed.data.name],
        );
        if (created.rowCount) {
          await audit(client, current.org.id, created.rows[0].id, 'identity_registered', current.hostname);
        }
        written = await issueLink(client, current, parsed.data.email, mailboxRoot(app.storage.root), publicPort, intent);
      });
    } catch (error) {
      if (written) await unlink(written).catch(() => {});
      throw error;
    }
    if (admitted) setLoginIntent(request, reply, intent);
    return reply.code(202).send(ACCEPTED);
  });

  app.post('/api/auth/request', async (request, reply) => {
    assertMutation(request);
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError(400, 'Informe um e-mail válido.');
    const current = context(request);
    const intent = randomBytes(32).toString('base64url');
    let admitted = false;
    let written: string | undefined;
    try {
      await app.db.transaction(async (client) => {
        if (!await permitRequest(client, current.hostname, loginRateOrigin(request), false)) return;
        admitted = true;
        written = await issueLink(client, current, parsed.data.email, mailboxRoot(app.storage.root), publicPort, intent);
      });
    } catch (error) {
      if (written) await unlink(written).catch(() => {});
      throw error;
    }
    if (admitted) setLoginIntent(request, reply, intent);
    return reply.code(202).send(ACCEPTED);
  });


  // Navigating or prefetching a link cannot change authentication state.
  app.get('/api/auth/consume', async (request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    const parsed = tokenSchema.safeParse(request.query);
    if (!parsed.success) return reply.redirect('/login?error=invalid_link', 303);
    return reply.redirect(`/login/confirm#${parsed.data.token}`, 303);
  });

  app.post('/api/auth/preview', async (request, reply) => {
    assertMutation(request);
    reply.header('Referrer-Policy', 'no-referrer');
    const { token, intents } = loginProof(request);
    const current = context(request);
    const user = await matchingToken(app.db, current, token, intents);
    if (!user) throw invalidLink();
    return { email: user.email };
  });

  app.post('/api/auth/consume', async (request, reply) => {
    assertMutation(request);
    reply.header('Referrer-Policy', 'no-referrer');
    const { token, intents } = loginProof(request);
    const current = context(request);
    const sessionToken = randomBytes(32).toString('base64url');
    const accepted = await app.db.transaction(async (client) => {
      const user = await matchingToken(client, current, token, intents, true);
      if (!user) return false;
      const consumed = await client.query(
        'UPDATE auth_tokens SET used_at=clock_timestamp() WHERE id=$1 AND used_at IS NULL AND expires_at>clock_timestamp() RETURNING id',
        [user.token_id],
      );
      if (!consumed.rowCount) return false;
      if (user.status === 'invited') {
        await client.query("UPDATE users SET status='active',updated_at=now() WHERE id=$1 AND org_id=$2", [user.id, current.org.id]);
      }
      if (user.roles.includes('student')) await grantInitialCreditInTransaction(client, { orgId: current.org.id, userId: user.id });
      await client.query(
        `INSERT INTO sessions (org_id,user_id,hostname,token_hash,expires_at)
         VALUES ($1,$2,$3,$4,clock_timestamp()+interval '7 days')`,
        [current.org.id, user.id, current.hostname, hash(sessionToken)],
      );
      const previous = request.cookies[COOKIE];
      if (previous && TOKEN_PATTERN.test(previous)) {
        await client.query(
          'UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND org_id=$2 AND hostname=$3 AND revoked_at IS NULL',
          [hash(previous), current.org.id, current.hostname],
        );
      }
      await audit(client, current.org.id, user.id, 'session_started', current.hostname);
      return user.intent_hash;
    });
    if (!accepted) throw invalidLink();
    const options = browserCookie(request);
    reply.setCookie(COOKIE, sessionToken, { ...options, maxAge: SESSION_SECONDS });
    reply.clearCookie(intents.get(accepted)!, options);
    return { destination: current.org.kind === 'backoffice' ? '/backoffice' : '/app' };
  });

  app.get('/api/auth/session', async (request) => requireIdentity(request));

  app.post('/api/auth/logout', async (request, reply) => {
    assertMutation(request);
    const current = context(request);
    const token = request.cookies[COOKIE];
    if (token && TOKEN_PATTERN.test(token)) {
      await app.db.transaction(async (client) => {
        const revoked = await client.query<{ user_id: string }>(
          `UPDATE sessions SET revoked_at=now()
           WHERE token_hash=$1 AND org_id=$2 AND hostname=$3 AND revoked_at IS NULL RETURNING user_id`,
          [hash(token), current.org.id, current.hostname],
        );
        if (revoked.rows[0]) await audit(client, current.org.id, revoked.rows[0].user_id, 'session_ended', current.hostname);
      });
    }
    reply.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: request.protocol === 'https' });
    return reply.code(204).send();
  });
}

/** Rechecks the live domain mapping, organization, user status and roles. No cache. */
export async function getIdentity(request: FastifyRequest, client?: PoolClient): Promise<AuthIdentity | null> {
  const token = request.cookies[COOKIE];
  const hostname = localHostname(request.headers.host);
  if (!token || !TOKEN_PATTERN.test(token) || !hostname) return null;
  const query = <Row extends QueryResultRow>(sql: string, parameters: unknown[]) =>
    client ? client.query<Row>(sql, parameters) : request.server.db.query<Row>(sql, parameters);
  const found = await query<OrgRow & {
    user_id: string; user_name: string; email: string; roles: IdentityRole[];
  }>(
    `SELECT o.id,o.slug,o.name,o.kind,o.settings,o.branding,o.status,d.hostname,
            u.id AS user_id,u.name AS user_name,u.email,u.roles
     FROM sessions s JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id
     JOIN orgs o ON o.id=s.org_id JOIN domains d ON d.hostname=s.hostname AND d.org_id=s.org_id
     WHERE s.token_hash=$1 AND s.hostname=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
       AND u.status='active' AND u.archived_at IS NULL AND o.status='active'
       ${client ? 'FOR SHARE OF u,o' : ''}`,
    [hash(token), hostname],
  );
  const row = found.rows[0];
  if (!row || !realmAllows(row.kind, row.roles)) return null;
  if (client && !(await client.query(`SELECT id FROM sessions WHERE token_hash=$1 AND hostname=$2
    AND org_id=$3 AND user_id=$4 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
  [hash(token), hostname, row.id, row.user_id])).rowCount) return null;
  return {
    user: { id: row.user_id, name: row.user_name, email: row.email, roles: row.roles, orgId: row.id },
    org: publicOrg(row),
  };
}

export async function requireIdentity(
  request: FastifyRequest,
  allowedRoles?: readonly IdentityRole[],
  client?: PoolClient,
): Promise<AuthIdentity> {
  const identity = await getIdentity(request, client);
  if (!identity) throw new IdentityError(401, 'Entre na sua conta para continuar.');
  if (allowedRoles && !identity.user.roles.some((role) => allowedRoles.includes(role))) {
    throw new IdentityError(403, 'Você não tem permissão para esta ação.');
  }
  return identity;
}

async function resolveContext(request: FastifyRequest): Promise<IdentityContext | null> {
  const hostname = localHostname(request.headers.host);
  if (!hostname) return null;
  const found = await request.server.db.query<OrgRow>(
    `SELECT o.id,o.slug,o.name,o.kind,o.status,o.settings,o.branding,d.hostname
     FROM domains d JOIN orgs o ON o.id=d.org_id WHERE d.hostname=$1`, [hostname],
  );
  const row = found.rows[0];
  return row ? { org: publicOrg(row), hostname: row.hostname, status: row.status } : null;
}

function context(request: FastifyRequest): IdentityContext {
  if (!request.identityContext) throw new IdentityError(404, 'Organização não encontrada.');
  return request.identityContext;
}

function publicOrg(row: IdentityOrg): IdentityOrg {
  return { id: row.id, slug: row.slug, name: row.name, kind: row.kind, settings: row.settings, branding: row.branding };
}

function assertMutation(request: FastifyRequest): void {
  if (request.headers['x-matraca-request'] !== '1') {
    throw new IdentityError(403, 'Origem da solicitação não confirmada.');
  }
  if (request.headers.origin) {
    const expected = `${request.protocol}://${request.headers.host}`;
    if (request.headers.origin !== expected) throw new IdentityError(403, 'Origem não permitida.');
  }
}

function realmAllows(kind: OrganizationKind, roles: IdentityRole[]): boolean {
  return kind === 'backoffice'
    ? roles.length === 1 && roles[0] === 'operator'
    : !roles.includes('operator');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}


function browserCookie(request: FastifyRequest) {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: request.protocol === 'https' };
}

function intentCookies(request: FastifyRequest) {
  return Object.entries(request.cookies).filter((entry): entry is [string, string] => {
    const [name, value] = entry;
    return name.startsWith(INTENT_COOKIE_PREFIX) && typeof value === 'string' && TOKEN_PATTERN.test(value);
  });
}

function setLoginIntent(request: FastifyRequest, reply: FastifyReply, intent: string) {
  const name = INTENT_COOKIE_PREFIX + hash(intent).slice(0, 12);
  const options = browserCookie(request);
  reply.setCookie(name, intent, { ...options, maxAge: INTENT_SECONDS });
}

function invalidLink() {
  return new IdentityError(400, 'Abra o link no navegador em que solicitou o acesso ou solicite um novo link.');
}

function loginProof(request: FastifyRequest) {
  const parsed = tokenSchema.safeParse(request.body);
  const intents = new Map(intentCookies(request).slice(-128).map(([name, value]) => [hash(value), name]));
  if (!parsed.success || intents.size === 0) throw invalidLink();
  return { token: parsed.data.token, intents };
}

interface TokenClient {
  query<T extends QueryResultRow>(sql: string, values: unknown[]): Promise<QueryResult<T>>;
}
async function matchingToken(client: TokenClient, current: IdentityContext, token: string, intents: Map<string, string>, lock = false) {
  const matched = await client.query<UserRow & { token_id: string; intent_hash: string }>(
    `SELECT u.id,u.email,u.name,u.roles,u.status,t.id AS token_id,t.intent_hash
     FROM auth_tokens t JOIN users u ON u.id=t.user_id AND u.org_id=t.org_id
     JOIN orgs o ON o.id=t.org_id
     JOIN domains d ON d.hostname=t.hostname AND d.org_id=t.org_id
     WHERE t.token_hash=$1 AND t.intent_hash=ANY($2::text[]) AND t.org_id=$3 AND t.hostname=$4
       AND t.used_at IS NULL AND t.expires_at>clock_timestamp() AND t.purpose IN ('login','invite')
       AND u.status IN ('invited','active') AND u.archived_at IS NULL AND o.status='active'
     ${lock ? 'FOR SHARE OF o FOR UPDATE OF u' : ''}`,
    [hash(token), [...intents.keys()], current.org.id, current.hostname],
  );
  const user = matched.rows[0];
  return user && realmAllows(current.org.kind, user.roles) ? user : null;
}

async function takeAuthBudget(client: PoolClient, scope: string, key: string, maximum: number): Promise<boolean> {
  const limited = await client.query(
    `INSERT INTO auth_rate_limits(key_hash,attempts) VALUES($1,1)
     ON CONFLICT(key_hash) DO UPDATE SET
       attempts=CASE WHEN auth_rate_limits.window_started_at<=clock_timestamp()-interval '15 minutes'
         THEN 1 ELSE auth_rate_limits.attempts+1 END,
       window_started_at=CASE WHEN auth_rate_limits.window_started_at<=clock_timestamp()-interval '15 minutes'
         THEN clock_timestamp() ELSE auth_rate_limits.window_started_at END
     WHERE auth_rate_limits.window_started_at<=clock_timestamp()-interval '15 minutes' OR auth_rate_limits.attempts<$2
     RETURNING attempts`, [hash(`${scope}\0${key}`), maximum],
  );
  return limited.rowCount === 1;
}

async function permitRequest(client: PoolClient, hostname: string, source: string, signup: boolean): Promise<boolean> {
  return await takeAuthBudget(client, 'origin', source, 96)
    && await takeAuthBudget(client, 'host-origin', `${hostname}\0${source}`, 48)
    && (!signup || await takeAuthBudget(client, 'signup-origin', `${hostname}\0${source}`, 12));
}

async function issueLink(
  client: PoolClient,
  current: IdentityContext,
  address: string,
  mailRoot: string,
  publicPort: number,
  intent: string,
): Promise<string | undefined> {
  if (current.org.kind !== 'backoffice') {
    const { config } = await readOperationPolicy(client, current.org.id);
    if (config.mailMode === 'suppressed') return undefined;
    if (config.mailMode === 'failure') throw new Error('Falha simulada na entrega do e-mail local.');
  }
  const matched = await client.query<UserRow>(
    `SELECT u.id,u.email,u.name,u.roles,u.status FROM users u JOIN orgs o ON o.id=u.org_id
     WHERE u.org_id=$1 AND u.email=$2 AND u.status IN ('invited','active') AND u.archived_at IS NULL AND o.status='active'
     FOR SHARE OF o FOR UPDATE OF u`, [current.org.id, address],
  );
  const user = matched.rows[0];
  if (!user || !realmAllows(current.org.kind, user.roles)) return undefined;
  if (!await takeAuthBudget(client, 'recipient', `${current.hostname}\0${user.id}`, 5)) return undefined;
  const raw = randomBytes(32).toString('base64url');
  const purpose = user.status === 'invited' ? 'invite' : 'login';
  const created = await client.query<{ expires_at: Date; created_at: Date }>(
    `INSERT INTO auth_tokens (org_id,user_id,hostname,token_hash,purpose,expires_at,intent_hash)
     VALUES ($1,$2,$3,$4,$5,now()+interval '15 minutes',$6) RETURNING expires_at,created_at`,
    [current.org.id, user.id, current.hostname, hash(raw), purpose, hash(intent)],
  );
  const id = randomUUID();
  const mail: LocalMail = {
    id, orgId: current.org.id, hostname: current.hostname, to: user.email,
    subject: `Seu acesso a ${current.org.name}`, purpose,
    createdAt: created.rows[0].created_at.toISOString(), expiresAt: created.rows[0].expires_at.toISOString(),
    link: `http://${current.hostname}:${publicPort}/api/auth/consume?token=${raw}`,
  };
  const directory = join(mailRoot, current.org.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(mailRoot, 0o700);
  await chmod(directory, 0o700);
  const destination = join(directory, `${id}.json`);
  try {
    await writeFile(destination, `${JSON.stringify(mail)}\n`, { flag: 'wx', mode: 0o600 });
    await audit(client, current.org.id, user.id, 'login_link_issued', current.hostname);
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
  return destination;
}

async function audit(client: PoolClient, orgId: string, userId: string, event: string, hostname: string): Promise<void> {
  await client.query('INSERT INTO audit_events (org_id,actor_user_id,event_type,metadata) VALUES ($1,$2,$3,$4)',
    [orgId, userId, event, JSON.stringify({ hostname })]);
}
