import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { grantInitialCreditInTransaction } from './wallet.js';
import { localHostname } from './config.js';

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
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
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

  app.post('/api/auth/register', async (request, reply) => {
    assertMutation(request);
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError(400, 'Informe nome e e-mail válidos.');
    const current = context(request);
    if (current.org.kind !== 'matraca' || current.status !== 'active') {
      throw new IdentityError(403, 'O cadastro desta organização é feito por convite.');
    }
    let written: string | undefined;
    try {
      await app.db.transaction(async (client) => {
        if (!(await permitRequest(client, current.hostname, parsed.data.email))) return;
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
        written = await issueLink(client, current, parsed.data.email, mailboxRoot(app.storage.root), publicPort);
      });
    } catch (error) {
      if (written) await unlink(written).catch(() => {});
      throw error;
    }
    return reply.code(202).send(ACCEPTED);
  });

  app.post('/api/auth/request', async (request, reply) => {
    assertMutation(request);
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError(400, 'Informe um e-mail válido.');
    const current = context(request);
    let written: string | undefined;
    try {
      await app.db.transaction(async (client) => {
        if (!(await permitRequest(client, current.hostname, parsed.data.email))) return;
        written = await issueLink(client, current, parsed.data.email, mailboxRoot(app.storage.root), publicPort);
      });
    } catch (error) {
      if (written) await unlink(written).catch(() => {});
      throw error;
    }
    return reply.code(202).send(ACCEPTED);
  });

  app.get('/api/auth/consume', async (request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    const parsed = z.object({ token: z.string().regex(TOKEN_PATTERN) }).strict().safeParse(request.query);
    if (!parsed.success) return reply.redirect('/login?error=invalid_link', 302);
    const current = context(request);
    const sessionToken = randomBytes(32).toString('base64url');
    const accepted = await app.db.transaction(async (client) => {
      const matched = await client.query<UserRow & { token_id: string }>(
        `SELECT u.id,u.email,u.name,u.roles,u.status,t.id AS token_id
         FROM auth_tokens t JOIN users u ON u.id=t.user_id AND u.org_id=t.org_id
         JOIN orgs o ON o.id=t.org_id
         JOIN domains d ON d.hostname=t.hostname AND d.org_id=t.org_id
         WHERE t.token_hash=$1 AND t.org_id=$2 AND t.hostname=$3
           AND t.used_at IS NULL AND t.expires_at>now() AND t.purpose IN ('login','invite')
           AND u.status IN ('invited','active') AND o.status='active'
         FOR UPDATE OF t,u`,
        [hash(parsed.data.token), current.org.id, current.hostname],
      );
      const user = matched.rows[0];
      if (!user || !realmAllows(current.org.kind, user.roles)) return false;
      const consumed = await client.query(
        'UPDATE auth_tokens SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id',
        [user.token_id],
      );
      if (!consumed.rowCount) return false;
      await client.query("UPDATE users SET status='active',updated_at=now() WHERE id=$1 AND org_id=$2", [user.id, current.org.id]);
      if (user.roles.includes('student')) await grantInitialCreditInTransaction(client,{orgId:current.org.id,userId:user.id});
      await client.query(
        `INSERT INTO sessions (org_id,user_id,hostname,token_hash,expires_at)
         VALUES ($1,$2,$3,$4,now()+interval '7 days')`,
        [current.org.id, user.id, current.hostname, hash(sessionToken)],
      );
      const previous = request.cookies[COOKIE];
      if (previous && TOKEN_PATTERN.test(previous)) {
        await client.query(
          'UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND org_id=$2 AND hostname=$3 AND revoked_at IS NULL',
          [hash(previous), current.org.id, current.hostname],
        );
      }
      await audit(client, current.org.id, user.id, 'session_started', current.hostname);
      return true;
    });
    if (!accepted) return reply.redirect('/login?error=invalid_link', 302);
    reply.setCookie(COOKIE, sessionToken, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: request.protocol === 'https', maxAge: SESSION_SECONDS,
    });
    return reply.redirect(current.org.kind === 'backoffice' ? '/backoffice' : '/app', 302);
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
export async function getIdentity(request: FastifyRequest): Promise<AuthIdentity | null> {
  const token = request.cookies[COOKIE];
  const hostname = localHostname(request.headers.host);
  if (!token || !TOKEN_PATTERN.test(token) || !hostname) return null;
  const found = await request.server.db.query<OrgRow & {
    user_id: string; user_name: string; email: string; roles: IdentityRole[];
  }>(
    `SELECT o.id,o.slug,o.name,o.kind,o.settings,o.branding,o.status,d.hostname,
            u.id AS user_id,u.name AS user_name,u.email,u.roles
     FROM sessions s JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id
     JOIN orgs o ON o.id=s.org_id JOIN domains d ON d.hostname=s.hostname AND d.org_id=s.org_id
     WHERE s.token_hash=$1 AND s.hostname=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
       AND u.status='active' AND o.status='active'`,
    [hash(token), hostname],
  );
  const row = found.rows[0];
  if (!row || !realmAllows(row.kind, row.roles)) return null;
  return {
    user: { id: row.user_id, name: row.user_name, email: row.email, roles: row.roles, orgId: row.id },
    org: publicOrg(row),
  };
}

export async function requireIdentity(
  request: FastifyRequest,
  allowedRoles?: readonly IdentityRole[],
): Promise<AuthIdentity> {
  const identity = await getIdentity(request);
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

async function permitRequest(client: PoolClient, hostname: string, address: string): Promise<boolean> {
  let permitted = true;
  for (const [scope, key, maximum] of [
    ['host', hostname, 100], ['email', `${hostname}\0${address}`, 5],
  ] as const) {
    const limited = await client.query<{ attempts: number }>(
      `INSERT INTO auth_rate_limits (key_hash,attempts) VALUES ($1,1)
       ON CONFLICT (key_hash) DO UPDATE SET
         attempts=CASE WHEN auth_rate_limits.window_started_at<=now()-interval '15 minutes'
           THEN 1 ELSE auth_rate_limits.attempts+1 END,
         window_started_at=CASE WHEN auth_rate_limits.window_started_at<=now()-interval '15 minutes'
           THEN now() ELSE auth_rate_limits.window_started_at END
       RETURNING attempts`, [hash(`${scope}\0${key}`)],
    );
    if (limited.rows[0].attempts > maximum) permitted = false;
  }
  return permitted;
}

async function issueLink(
  client: PoolClient,
  current: IdentityContext,
  address: string,
  mailRoot: string,
  publicPort: number,
): Promise<string | undefined> {
  const matched = await client.query<UserRow>(
    `SELECT u.id,u.email,u.name,u.roles,u.status FROM users u JOIN orgs o ON o.id=u.org_id
     WHERE u.org_id=$1 AND u.email=$2 AND u.status IN ('invited','active') AND o.status='active'
     FOR UPDATE OF u`, [current.org.id, address],
  );
  const user = matched.rows[0];
  if (!user || !realmAllows(current.org.kind, user.roles)) return undefined;
  const raw = randomBytes(32).toString('base64url');
  const purpose = user.status === 'invited' ? 'invite' : 'login';
  const created = await client.query<{ expires_at: Date; created_at: Date }>(
    `INSERT INTO auth_tokens (org_id,user_id,hostname,token_hash,purpose,expires_at)
     VALUES ($1,$2,$3,$4,$5,now()+interval '15 minutes') RETURNING expires_at,created_at`,
    [current.org.id, user.id, current.hostname, hash(raw), purpose],
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
