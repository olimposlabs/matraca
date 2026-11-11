import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireIdentity, type AuthIdentity } from './auth.js';
import type { EducationQuery } from './permissions.js';

export class CommerceError extends Error {
  constructor(public readonly statusCode: 400 | 403 | 404 | 409, message: string) { super(message); this.name = 'CommerceError'; }
}
export const pagination = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export const parseCommerce = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input); if (!result.success) throw new CommerceError(400, 'Confira os dados comerciais informados.'); return result.data;
};
export const commerceParam = (request: FastifyRequest, name: string) => parseCommerce(z.uuid(), (request.params as Record<string, unknown>)[name]);
export interface CommerceOrg { id: string; kind: 'matraca' | 'partner'; status: 'active' | 'suspended'; settings: Record<string, unknown>; name: string }
export interface CommerceAccess { actor: AuthIdentity; org: CommerceOrg; central: boolean }
export async function commerceOrg(client: EducationQuery, id: string, expected: 'matraca' | 'partner', lock = false) {
  const row = (await client.query<CommerceOrg>(`SELECT id,kind,status,settings,name FROM orgs WHERE id=$1 AND kind=$2 ${lock ? 'FOR SHARE' : ''}`, [id, expected])).rows[0];
  if (!row) throw new CommerceError(404, 'Organização comercial não encontrada.'); return row;
}
export async function commerceAccess(request: FastifyRequest, central: boolean, kind: 'matraca' | 'partner'): Promise<CommerceAccess> {
  const actor = await requireIdentity(request, central ? ['operator'] : kind === 'matraca' ? ['student'] : ['org_admin']);
  if (central && actor.org.kind !== 'backoffice') throw new CommerceError(403, 'Ação exclusiva do backoffice.');
  const org = await commerceOrg(request.server.db, central ? commerceParam(request, 'orgId') : actor.org.id, kind);
  return { actor, org, central };
}
export async function commerceMutation<T>(request: FastifyRequest, access: CommerceAccess, work: (client: PoolClient, access: CommerceAccess) => Promise<T>): Promise<T> {
  try { return await request.server.db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [access.org.id]);
    const actor = await requireIdentity(request, access.central ? ['operator'] : access.org.kind === 'matraca' ? ['student'] : ['org_admin'], client);
    if (actor.org.id !== access.actor.org.id || actor.user.id !== access.actor.user.id || (access.central && actor.org.kind !== 'backoffice')) throw new CommerceError(403, 'O contexto de acesso mudou.');
    const org = await commerceOrg(client, access.org.id, access.org.kind, true);
    return work(client, { actor, org, central: access.central });
  }); } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new CommerceError(409, 'Já existe um registro para esta operação.'); throw error;
  }
}
export async function commerceAudit(client: PoolClient, access: CommerceAccess, event: string, metadata: object) {
  await client.query('INSERT INTO audit_events(org_id,actor_user_id,event_type,metadata) VALUES($1,$2,$3,$4)', [access.actor.org.id, access.actor.user.id, event, { targetOrgId: access.org.id, ...metadata }]);
}
