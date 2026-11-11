import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import sharp, { type OutputInfo } from 'sharp';
import { z } from 'zod';
import { requireIdentity, type AuthIdentity, type IdentityOrg } from './auth.js';

const label = (maximum: number) => z.string().trim().min(1).max(maximum).refine(
  (value) => !/[<>]/u.test(value) && [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }), 'Use texto simples sem marcação.',
);
const color = z.string().regex(/^#[0-9a-f]{6}$/i).transform((value) => value.toLowerCase());
const brandingSchema = z.object({
  displayName: label(80), primary: color, background: color, surface: color, text: color, muted: color,
  font: z.enum(['sans', 'serif']), creditSingular: label(32), creditPlural: label(40),
  logoKey: z.string().regex(/^branding\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/).optional(),
}).strict().superRefine((brand, ctx) => {
  for (const foreground of ['text', 'muted'] as const) {
    for (const background of ['background', 'surface'] as const) {
      if (contrast(brand[foreground], brand[background]) < 4.5) {
        ctx.addIssue({ code: 'custom', path: [foreground], message: 'Contraste de texto insuficiente.' });
      }
    }
  }
  if (contrast(brand.primary, '#ffffff') < 4.5) {
    ctx.addIssue({ code: 'custom', path: ['primary'], message: 'A cor principal precisa contrastar com texto branco.' });
  }
});
const settingsSchema = z.object({
  coursesEnabled: z.boolean().optional(), strictJourney: z.boolean().optional(),
  leaderboardEnabled: z.boolean().optional(), diagnosticEnabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const revisionSchema = z.number().int().min(0).max(2_147_483_646);
const publishSchema = z.object({ branding: brandingSchema, expectedRevision: revisionSchema }).strict();
const restoreSchema = z.object({ revision: revisionSchema, expectedRevision: revisionSchema }).strict();
const reservedSlugs = new Set([
  'matraca', 'backoffice', 'www', 'api', 'admin', 'app', 'login', 'auth', 'assets', 'static',
  'mail', 'inbox', 'support', 'suporte', 'localhost', 'cdn', 'status', 'dev', 'test', 'staging',
]);
const createSchema = z.object({
  name: label(160), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/)
    .refine((slug) => !reservedSlugs.has(slug)),
  adminName: label(120), adminEmail: z.string().trim().max(254).email().transform((value) => value.toLowerCase()),
}).strict();
const updateSchema = z.object({
  name: label(160).optional(), status: z.enum(['active', 'suspended']).optional(), settings: settingsSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export type BrandingInput = z.infer<typeof brandingSchema>;
export type PublishedBranding = BrandingInput & { _revision: number };
export const DEFAULT_BRANDING: Omit<BrandingInput, 'displayName'> = {
  primary: '#b8442b', background: '#faf8f2', surface: '#ffffff', text: '#1f2925', muted: '#59665f',
  font: 'sans', creditSingular: 'crédito', creditPlural: 'créditos',
};
const DEFAULT_SETTINGS = { coursesEnabled: true, strictJourney: false, leaderboardEnabled: true, diagnosticEnabled: true };
const LOGO_LIMIT = 2 * 1024 * 1024;
interface QueryClient {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
}
interface OrgRow extends IdentityOrg {
  status: 'active' | 'suspended'; hostname?: string; user_count?: number;
}
interface LogoAsset { key: string; content_type: string; width: number; height: number; bytes: number }

export class OrganizationError extends Error {
  constructor(public readonly statusCode: 400 | 403 | 404 | 409 | 413 | 415, message: string) {
    super(message);
    this.name = 'OrganizationError';
  }
}

export async function registerOrganizations(app: FastifyInstance): Promise<void> {
  const port = Number(process.env.APP_PUBLIC_PORT ?? 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('APP_PUBLIC_PORT inválida.');
  const domainSuffix = process.env.APP_PARTNER_DOMAIN_SUFFIX ?? 'matraca.localhost';
  if (!/^(?:[a-z0-9][a-z0-9-]{0,24}\.)?matraca\.localhost$/.test(domainSuffix)) {
    throw new Error('APP_PARTNER_DOMAIN_SUFFIX inválido.');
  }
  await app.register(multipart);

  app.get('/api/backoffice/orgs', async (request) => {
    await operator(request);
    const rows = await app.db.query<OrgRow>(`${orgSelect} ORDER BY o.name,o.id`);
    return { orgs: rows.rows.map((row) => orgView(row, port)) };
  });
  app.post('/api/backoffice/orgs', async (request, reply) => {
    const actor = await operator(request);
    const data = validate(createSchema, request.body);
    const id = randomUUID();
    const adminId = randomUUID();
    const hostname = `${data.slug}.${domainSuffix}`;
    const branding = { ...DEFAULT_BRANDING, displayName: data.name.slice(0, 80), _revision: 0 };
    try {
      const result = await app.db.transaction(async (client) => {
        await client.query(
          `INSERT INTO orgs (id,slug,name,kind,settings,branding) VALUES ($1,$2,$3,'partner',$4,$5)`,
          [id, data.slug, data.name, DEFAULT_SETTINGS, branding],
        );
        await client.query('INSERT INTO domains (hostname,org_id) VALUES ($1,$2)', [hostname, id]);
        await client.query(
          `INSERT INTO users (id,org_id,email,name,roles,status) VALUES ($1,$2,$3,$4,ARRAY['org_admin'],'invited')`,
          [adminId, id, data.adminEmail, data.adminName],
        );
        await client.query('INSERT INTO org_branding_history (org_id,revision,branding,actor_user_id) VALUES ($1,0,$2,$3)',
          [id, branding, actor.user.id]);
        await audit(client, actor, id, 'organization_created');
        return manage(client, id, port);
      });
      return reply.code(201).send({ ...result, admin: { id: adminId, name: data.adminName, email: data.adminEmail }, portalUrl: `http://${hostname}:${port}` });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new OrganizationError(409, 'Já existe uma organização ou domínio com esse identificador.');
      }
      throw error;
    }
  });

  app.get('/api/org/manage', async (request) => {
    const identity = await requireIdentity(request, ['org_admin']);
    return manage(app.db, identity.org.id, port);
  });
  app.get('/api/backoffice/orgs/:id', async (request) => {
    await operator(request);
    return manage(app.db, targetId(request), port);
  });

  app.patch('/api/org/settings', async (request) => {
    const actor = await requireIdentity(request, ['org_admin']);
    const settings = validate(settingsSchema, request.body);
    return updateOrganization(app, actor, actor.org.id, { settings }, port);
  });
  app.patch('/api/backoffice/orgs/:id', async (request) => {
    const actor = await operator(request);
    return updateOrganization(app, actor, targetId(request), validate(updateSchema, request.body), port);
  });

  for (const central of [false, true]) {
    const prefix = central ? '/api/backoffice/orgs/:id' : '/api/org';
    app.put(`${prefix}/branding`, async (request) => {
      const actor = central ? await operator(request) : await requireIdentity(request, ['org_admin']);
      const id = central ? targetId(request) : actor.org.id;
      const data = validate(publishSchema, request.body);
      return publishBranding(app, actor, id, data.expectedRevision, data.branding, port);
    });
    app.post(`${prefix}/branding/restore`, async (request) => {
      const actor = central ? await operator(request) : await requireIdentity(request, ['org_admin']);
      const id = central ? targetId(request) : actor.org.id;
      const data = validate(restoreSchema, request.body);
      return publishBranding(app, actor, id, data.expectedRevision, { restoreRevision: data.revision }, port);
    });
    app.post(`${prefix}/logo`, async (request, reply) => {
      const actor = central ? await operator(request) : await requireIdentity(request, ['org_admin']);
      const id = central ? targetId(request) : actor.org.id;
      await requireOrg(app.db, id);
      const asset = await uploadLogo(app, request, actor, id);
      return reply.code(201).send(asset);
    });
  }

  app.get('/api/branding/logo', async (request, reply) => {
    const current = request.identityContext;
    if (!current || current.status !== 'active') throw new OrganizationError(404, 'Logo não encontrado.');
    const found = await app.db.query<LogoAsset>(
      `SELECT a.key,a.content_type,a.width,a.height,a.bytes FROM logo_assets a
       JOIN orgs o ON o.id=a.org_id AND o.branding->>'logoKey'=a.key
       WHERE a.org_id=$1 AND o.status='active'`, [current.org.id],
    );
    const asset = found.rows[0];
    if (!asset) throw new OrganizationError(404, 'Logo não encontrado.');
    try { await app.storage.info(asset.key); }
    catch { throw new OrganizationError(404, 'Logo não encontrado.'); }
    return reply.type('image/webp').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', 'inline; filename="logo.webp"').send(app.storage.read(asset.key));
  });
}

const orgSelect = `SELECT o.*,
  (SELECT d.hostname FROM domains d WHERE d.org_id=o.id
    ORDER BY (d.hostname='matraca.localhost' OR d.hostname LIKE '%.matraca.localhost') DESC, length(d.hostname) DESC, d.hostname LIMIT 1) AS hostname,
  (SELECT count(*)::integer FROM users u WHERE u.org_id=o.id) AS user_count FROM orgs o`;

async function operator(request: FastifyRequest): Promise<AuthIdentity> {
  const identity = await requireIdentity(request, ['operator']);
  if (identity.org.kind !== 'backoffice') throw new OrganizationError(403, 'Acesso exclusivo do backoffice.');
  return identity;
}
function targetId(request: FastifyRequest): string {
  return validate(z.object({ id: z.uuid() }).strict(), request.params).id;
}
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new OrganizationError(400, 'Configuração inválida. Confira campos, cores e contraste.');
  return parsed.data;
}
function normalizedBranding(org: OrgRow): PublishedBranding {
  const { _revision, ...branding } = org.branding;
  return { ...DEFAULT_BRANDING, displayName: org.name.slice(0, 80), ...branding,
    _revision: typeof _revision === 'number' && Number.isSafeInteger(_revision) && _revision >= 0 ? _revision : 0 } as PublishedBranding;
}
function orgView(org: OrgRow, port: number) {
  return { id: org.id, slug: org.slug, name: org.name, kind: org.kind, status: org.status,
    settings: { ...DEFAULT_SETTINGS, ...org.settings }, branding: normalizedBranding(org),
    hostname: org.hostname ?? null, portalUrl: org.hostname ? `http://${org.hostname}:${port}` : null,
    userCount: org.user_count ?? 0 };
}
async function requireOrg(client: QueryClient, id: string, lock = false): Promise<OrgRow> {
  const found = await client.query<OrgRow>(`SELECT * FROM orgs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!found.rows[0]) throw new OrganizationError(404, 'Organização não encontrada.');
  return found.rows[0];
}
async function manage(client: QueryClient, id: string, port: number) {
  const found = await client.query<OrgRow>(`${orgSelect} WHERE o.id=$1`, [id]);
  if (!found.rows[0]) throw new OrganizationError(404, 'Organização não encontrada.');
  const history = await client.query<{ revision: number; branding: PublishedBranding; created_at: Date; actor_user_id: string | null }>(
    'SELECT revision,branding,created_at,actor_user_id FROM org_branding_history WHERE org_id=$1 ORDER BY revision DESC LIMIT 100', [id],
  );
  return { org: orgView(found.rows[0], port), brandingHistory: history.rows.map((row) => ({
    revision: row.revision, branding: row.branding, createdAt: row.created_at.toISOString(), actorId: row.actor_user_id,
  })) };
}

async function updateOrganization(
  app: FastifyInstance, actor: AuthIdentity, id: string,
  data: z.infer<typeof updateSchema>, port: number,
) {
  return app.db.transaction(async (client) => {
    const org = await requireOrg(client, id, true);
    if (org.kind === 'backoffice' && data.status === 'suspended') {
      throw new OrganizationError(400, 'O backoffice não pode suspender o próprio acesso.');
    }
    await client.query('UPDATE orgs SET name=$2,status=$3,settings=$4,updated_at=now() WHERE id=$1',
      [id, data.name ?? org.name, data.status ?? org.status, { ...org.settings, ...data.settings }]);
    await audit(client, actor, id, 'organization_updated');
    return manage(client, id, port);
  });
}

async function publishBranding(
  app: FastifyInstance, actor: AuthIdentity, id: string, expectedRevision: number,
  action: BrandingInput | { restoreRevision: number }, port: number,
) {
  return app.db.transaction(async (client) => {
    const org = await requireOrg(client, id, true);
    const previous = normalizedBranding(org);
    if (previous._revision !== expectedRevision) {
      throw new OrganizationError(409, 'A marca foi alterada por outra pessoa. Recarregue antes de publicar.');
    }
    await client.query(
      'INSERT INTO org_branding_history (org_id,revision,branding) VALUES ($1,$2,$3) ON CONFLICT (org_id,revision) DO NOTHING',
      [id, previous._revision, previous],
    );
    let candidate: BrandingInput;
    if ('restoreRevision' in action) {
      const history = await client.query<{ branding: PublishedBranding }>(
        'SELECT branding FROM org_branding_history WHERE org_id=$1 AND revision=$2', [id, action.restoreRevision],
      );
      if (!history.rows[0]) throw new OrganizationError(404, 'Versão de marca não encontrada nesta organização.');
      const restored = { ...history.rows[0].branding };
      delete (restored as Partial<PublishedBranding>)._revision;
      candidate = validate(brandingSchema, restored);
    } else candidate = action;
    if (candidate.logoKey) {
      const logo = await client.query('SELECT id FROM logo_assets WHERE org_id=$1 AND key=$2', [id, candidate.logoKey]);
      if (!logo.rowCount) throw new OrganizationError(400, 'O logo não pertence a esta organização.');
    }
    const branding = { ...candidate, _revision: previous._revision + 1 };
    await client.query('UPDATE orgs SET branding=$2,updated_at=now() WHERE id=$1', [id, branding]);
    await client.query('INSERT INTO org_branding_history (org_id,revision,branding,actor_user_id) VALUES ($1,$2,$3,$4)',
      [id, branding._revision, branding, actor.user.id]);
    await audit(client, actor, id, 'restoreRevision' in action ? 'branding_restored' : 'branding_published', branding._revision);
    return manage(client, id, port);
  });
}

async function uploadLogo(app: FastifyInstance, request: FastifyRequest, actor: AuthIdentity, orgId: string) {
  if (!request.isMultipart()) throw new OrganizationError(415, 'Envie um arquivo PNG, JPEG ou WebP.');
  let original: Buffer | undefined;
  let declaredType: string | undefined;
  for await (const part of request.parts({ limits: { fileSize: LOGO_LIMIT, files: 1, fields: 0, parts: 1 } })) {
    if (part.type !== 'file' || part.fieldname !== 'file') {
      throw new OrganizationError(400, 'Envie somente o campo de arquivo file.');
    }
    declaredType = part.mimetype;
    original = await part.toBuffer();
    if (part.file.truncated) throw new OrganizationError(413, 'Logo excede o limite de 2 MiB.');
  }
  if (!original || original.length === 0) throw new OrganizationError(400, 'O arquivo de logo está vazio.');
  if (original.length > LOGO_LIMIT) throw new OrganizationError(413, 'Logo excede o limite de 2 MiB.');
  const format = imageFormat(original);
  if (!format || declaredType !== `image/${format === 'jpeg' ? 'jpeg' : format}`) {
    throw new OrganizationError(415, 'O conteúdo deve corresponder a uma imagem PNG, JPEG ou WebP.');
  }
  let encoded: { data: Buffer; info: OutputInfo };
  try {
    const image = sharp(original, { limitInputPixels: 16_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height ||
      metadata.width > 4096 || metadata.height > 4096 || (metadata.pages ?? 1) > 1) {
      throw new OrganizationError(400, 'Use uma imagem estática de até 4096 pixels por dimensão.');
    }
    encoded = await image.rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof OrganizationError) throw error;
    throw new OrganizationError(400, 'Não foi possível validar a imagem.');
  }
  if (encoded.data.length > LOGO_LIMIT) throw new OrganizationError(413, 'Logo normalizado excede 2 MiB.');
  const id = randomUUID();
  const key = `branding/${orgId}/${id}`;
  await app.storage.put(key, Readable.from(encoded.data));
  try {
    await app.db.transaction(async (client) => {
      await client.query('INSERT INTO logo_assets (id,org_id,key,content_type,width,height,bytes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, orgId, key, 'image/webp', encoded.info.width, encoded.info.height, encoded.data.length, actor.user.id]);
      await audit(client, actor, orgId, 'logo_uploaded');
    });
  } catch (error) {
    await app.storage.remove(key).catch(() => {});
    throw error;
  }
  return { logoKey: key, contentType: 'image/webp', width: encoded.info.width, height: encoded.info.height, bytes: encoded.data.length };
}

function imageFormat(bytes: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
async function audit(client: PoolClient, actor: AuthIdentity, orgId: string, event: string, revision?: number) {
  await client.query('INSERT INTO audit_events (org_id,actor_user_id,event_type,metadata) VALUES ($1,$2,$3,$4)',
    [actor.org.id, actor.user.id, event, { targetOrgId: orgId, ...(revision === undefined ? {} : { revision }) }]);
}
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const values = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const left = luminance(a), right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}
