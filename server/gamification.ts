import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireIdentity, type AuthIdentity } from './auth.js';
import { gamificationPolicySchema, learnerTotals, rankedLearners, readGamificationPolicy } from './gamification-core.js';
import { grantCreditsInTransaction } from './wallet.js';

class GamificationError extends Error {
  constructor(readonly statusCode: 400 | 403 | 404 | 409, message: string) { super(message); }
}

const pagination = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
const leaderboardQuery = z.object({
  ...pagination,
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  groupId: z.uuid().optional(),
}).strict();
const policyInput = z.object({
  expectedRevision: z.number().int().min(0),
  policy: gamificationPolicySchema,
}).strict();
const campaignInput = z.object({
  clientKey: z.uuid(),
  title: z.string().trim().min(1).max(140),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  groupId: z.uuid().nullable().default(null),
  prizes: z.array(z.object({
    position: z.number().int().min(1).max(100),
    credits: z.number().int().min(1).max(10_000),
  }).strict()).min(1).max(100),
}).strict().refine(input =>
  Date.parse(input.endsAt) > Date.parse(input.startsAt)
  && new Set(input.prizes.map(item => item.position)).size === input.prizes.length);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GamificationError(400, 'Confira período, valores e campos da gamificação.');
  return result.data;
}

function localYear() {
  return Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'America/Sao_Paulo' }).format(new Date()));
}

async function learnerGroups(client: PoolClient, orgId: string, studentId: string) {
  const result = await client.query<{ id: string; name: string; typeName: string }>(
    `WITH RECURSIVE owned(id,parent_id) AS (
       SELECT g.id,g.parent_id FROM education_groups g JOIN group_memberships m ON m.group_id=g.id AND m.org_id=g.org_id
       WHERE g.org_id=$1 AND m.user_id=$2 AND m.ended_at IS NULL AND g.status='active'
       UNION
       SELECT p.id,p.parent_id FROM education_groups p JOIN owned c ON p.id=c.parent_id
       WHERE p.org_id=$1 AND p.status='active'
     )
     SELECT g.id,g.name,t.name AS "typeName" FROM owned JOIN education_groups g ON g.id=owned.id
     JOIN group_types t ON t.id=g.type_id AND t.org_id=g.org_id ORDER BY t.position,lower(g.name),g.id`,
    [orgId, studentId],
  );
  return result.rows;
}

interface Campaign {
  id: string;
  title: string;
  groupId: string | null;
  startsAt: Date;
  endsAt: Date;
  closedAt: Date | null;
  prizes: { position: number; credits: number }[];
  canClose: boolean;
}
const campaignColumns = `id,title,group_id AS "groupId",starts_at AS "startsAt",ends_at AS "endsAt",
  closed_at AS "closedAt",prizes,(ends_at<=clock_timestamp()) AS "canClose"`;

async function campaignById(client: PoolClient, orgId: string, id: string, lock = false): Promise<Campaign> {
  const result = await client.query<Campaign>(
    `SELECT ${campaignColumns} FROM prize_campaigns WHERE id=$1 AND org_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, orgId],
  );
  if (!result.rows[0]) throw new GamificationError(404, 'Campanha não encontrada.');
  return result.rows[0];
}

async function managerScope(request: FastifyRequest, central: boolean) {
  const role = central ? 'operator' : 'org_admin';
  const actor = await requireIdentity(request, [role]);
  if (central && actor.org.kind !== 'backoffice') throw new GamificationError(403, 'Acesso exclusivo do backoffice.');
  const orgId = central ? parse(z.object({ orgId: z.uuid() }).passthrough(), request.params).orgId : actor.org.id;
  return { actor, orgId, role } as const;
}

async function withManager<T>(request: FastifyRequest, central: boolean, write: boolean, task: (client: PoolClient, orgId: string, actor: AuthIdentity) => Promise<T>) {
  const scope = await managerScope(request, central);
  return request.server.db.transaction(async client => {
    if (write) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [scope.orgId]);
    else await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actor = write ? await requireIdentity(request, [scope.role], client) : scope.actor;
    if (actor.user.id !== scope.actor.user.id || actor.org.id !== scope.actor.org.id) throw new GamificationError(403, 'Sua sessão mudou.');
    const org = await client.query(
      `SELECT id FROM orgs WHERE id=$1 AND kind<>'backoffice' AND status='active' ${write ? 'FOR SHARE' : ''}`, [scope.orgId],
    );
    if (!org.rowCount) throw new GamificationError(404, 'Organização não encontrada.');
    return task(client, scope.orgId, actor);
  });
}

async function campaignRanking(client: PoolClient, orgId: string, campaign: Campaign, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  if (campaign.closedAt) {
    const count = await client.query<{ total: number }>('SELECT count(*)::int AS total FROM ranking_snapshots WHERE campaign_id=$1', [campaign.id]);
    const items = await client.query(
      `SELECT s.position,s.student_id AS "studentId",s.student_name AS name,s.points::double precision AS points,
       s.reached_at AS "reachedAt",p.credits,p.entry_id AS "entryId"
       FROM ranking_snapshots s LEFT JOIN ranking_prizes p ON p.campaign_id=s.campaign_id AND p.student_id=s.student_id
       WHERE s.campaign_id=$1 AND s.org_id=$2 ORDER BY s.position LIMIT $3 OFFSET $4`,
      [campaign.id, orgId, pageSize, offset],
    );
    return { items: items.rows, total: count.rows[0].total, page, pageSize };
  }
  const args = [orgId, campaign.startsAt, campaign.endsAt, campaign.groupId];
  const count = await client.query<{ total: number }>(`${rankedLearners} SELECT count(*)::int AS total FROM ranked`, args);
  const items = await client.query(
    `${rankedLearners} SELECT position,student_id AS "studentId",name,points::double precision AS points,reached_at AS "reachedAt"
     FROM ranked ORDER BY position LIMIT $5 OFFSET $6`, [...args, pageSize, offset],
  );
  return { items: items.rows, total: count.rows[0].total, page, pageSize };
}

export async function registerGamification(app: FastifyInstance) {
  app.get('/api/gamification', async request => {
    const actor = await requireIdentity(request, ['student']);
    return app.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const totals = await learnerTotals(client, actor.org.id, actor.user.id);
      const badges = await client.query(
        `SELECT badge_id AS id,name,condition,earned_at AS "earnedAt"
         FROM earned_badges WHERE org_id=$1 AND student_id=$2 ORDER BY earned_at,badge_id`, [actor.org.id, actor.user.id],
      );
      const leaderboardEnabled = actor.org.settings.leaderboardEnabled !== false;
      const groups = leaderboardEnabled ? await learnerGroups(client, actor.org.id, actor.user.id) : [];
      return { totals, badges: badges.rows, leaderboardEnabled, groups, year: localYear() };
    });
  });

  app.get('/api/gamification/leaderboard', async request => {
    const actor = await requireIdentity(request, ['student']);
    if (actor.org.settings.leaderboardEnabled === false) throw new GamificationError(403, 'O ranking está desativado nesta organização.');
    const { year = localYear(), groupId, page, pageSize } = parse(leaderboardQuery, request.query);
    return app.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      if (groupId && !(await learnerGroups(client, actor.org.id, actor.user.id)).some(group => group.id === groupId)) {
        throw new GamificationError(404, 'Grupo não encontrado no seu escopo.');
      }
      const bounds = await client.query<{ start: Date; end: Date }>(
        `SELECT $1::date::timestamp AT TIME ZONE 'America/Sao_Paulo' AS start,
                $2::date::timestamp AT TIME ZONE 'America/Sao_Paulo' AS end`,
        [`${year}-01-01`, `${year + 1}-01-01`],
      );
      const args = [actor.org.id, bounds.rows[0].start, bounds.rows[0].end, groupId ?? null];
      const ranks = await client.query<{ items: unknown[]; total: number; own: unknown }>(
        `${rankedLearners}, leaderboard_rows AS (
          SELECT position,student_id AS "studentId",name,points::double precision AS points,reached_at AS "reachedAt" FROM ranked
        ) SELECT (SELECT count(*)::int FROM leaderboard_rows) AS total,
           (SELECT to_jsonb(v) FROM leaderboard_rows v WHERE v."studentId"=$5) AS own,
           COALESCE((SELECT jsonb_agg(p ORDER BY p.position) FROM
             (SELECT * FROM leaderboard_rows ORDER BY position LIMIT $6 OFFSET $7) p),'[]'::jsonb) AS items`,
        [...args, actor.user.id, pageSize, (page - 1) * pageSize],
      );
      return { ...ranks.rows[0], page, pageSize, year, groupId: groupId ?? null };
    });
  });

  for (const central of [false, true]) {
    const base = central ? '/api/backoffice/gamification/:orgId' : '/api/gamification/manage';
    app.get(`${base}/policy`, request => withManager(request, central, false, async (client, orgId) => {
      const settings = await readGamificationPolicy(client, orgId);
      const groups = await client.query("SELECT id,name FROM education_groups WHERE org_id=$1 AND status='active' ORDER BY lower(name),id", [orgId]);
      return { ...settings, groups: groups.rows };
    }));

    app.put(`${base}/policy`, request => {
      const input = parse(policyInput, request.body);
      return withManager(request, central, true, async (client, orgId) => {
        const current = await readGamificationPolicy(client, orgId);
        if (current.revision !== input.expectedRevision) throw new GamificationError(409, 'As regras mudaram. Recarregue antes de salvar.');
        const updated = await client.query(
          `INSERT INTO gamification_policies(org_id,policy) VALUES ($1,$2)
           ON CONFLICT(org_id) DO UPDATE SET policy=EXCLUDED.policy,revision=gamification_policies.revision+1,
             updated_at=clock_timestamp() RETURNING policy,revision`, [orgId, input.policy],
        );
        return updated.rows[0];
      });
    });

    app.get(`${base}/campaigns`, request => {
      const { page, pageSize } = parse(z.object(pagination).strict(), request.query);
      return withManager(request, central, false, async (client, orgId) => {
        const total = await client.query<{ total: number }>('SELECT count(*)::int AS total FROM prize_campaigns WHERE org_id=$1', [orgId]);
        const items = await client.query(
          `SELECT ${campaignColumns} FROM prize_campaigns WHERE org_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,
          [orgId, pageSize, (page - 1) * pageSize],
        );
        return { items: items.rows, total: total.rows[0].total, page, pageSize };
      });
    });

    app.post(`${base}/campaigns`, async (request, reply) => {
      const input = parse(campaignInput, request.body);
      const campaign = await withManager(request, central, true, async (client, orgId, actor) => {
        if (input.groupId && !(await client.query(
          "SELECT id FROM education_groups WHERE id=$1 AND org_id=$2 AND status='active'", [input.groupId, orgId],
        )).rowCount) throw new GamificationError(404, 'Grupo não encontrado.');
        const prizes = [...input.prizes].sort((a, b) => a.position - b.position);
        const existing = await client.query<Campaign & { sameIntent: boolean }>(
          `SELECT ${campaignColumns},(group_id IS NOT DISTINCT FROM $3::uuid AND title=$4 AND starts_at=$5
            AND ends_at=$6 AND prizes=$7::jsonb) AS "sameIntent" FROM prize_campaigns WHERE org_id=$1 AND client_key=$2`,
          [orgId, input.clientKey, input.groupId, input.title, input.startsAt, input.endsAt, JSON.stringify(prizes)],
        );
        if (existing.rows[0]) {
          if (!existing.rows[0].sameIntent) throw new GamificationError(409, 'Esta solicitação já foi usada com outros valores.');
          const { sameIntent, ...campaign } = existing.rows[0];
          return sameIntent ? campaign : null;
        }
        const result = await client.query(
          `INSERT INTO prize_campaigns(org_id,client_key,group_id,title,starts_at,ends_at,prizes,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${campaignColumns}`,
          [orgId, input.clientKey, input.groupId, input.title, input.startsAt, input.endsAt, JSON.stringify(prizes), actor.user.id],
        );
        return result.rows[0];
      });
      return reply.code(201).send({ campaign });
    });

    app.get(`${base}/campaigns/:id`, request => {
      const { id } = parse(z.object({ id: z.uuid() }).passthrough(), request.params);
      const { page, pageSize } = parse(z.object(pagination).strict(), request.query);
      return withManager(request, central, false, async (client, orgId) => {
        const campaign = await campaignById(client, orgId, id);
        const ranking = await campaignRanking(client, orgId, campaign, page, pageSize);
        return { campaign, ranking };
      });
    });

    app.post(`${base}/campaigns/:id/close`, request => {
      const { id } = parse(z.object({ id: z.uuid() }).passthrough(), request.params);
      return withManager(request, central, true, async (client, orgId, actor) => {
        const campaign = await campaignById(client, orgId, id, true);
        if (!campaign.closedAt) {
          if (!campaign.canClose) throw new GamificationError(409, 'A campanha ainda está em andamento.');
          await client.query(
            `${rankedLearners} INSERT INTO ranking_snapshots(campaign_id,org_id,position,student_id,student_name,points,reached_at)
             SELECT $5,$1,position,student_id,name,points,reached_at FROM ranked`,
            [orgId, campaign.startsAt, campaign.endsAt, campaign.groupId, id],
          );
          const prizes = new Map(campaign.prizes.map(item => [item.position, item.credits]));
          const winners = await client.query<{ position: number; student_id: string }>(
            'SELECT position,student_id FROM ranking_snapshots WHERE campaign_id=$1 AND position=ANY($2::int[]) ORDER BY student_id',
            [id, [...prizes.keys()]],
          );
          for (const winner of winners.rows) {
            const credits = prizes.get(winner.position)!;
            const entry = await grantCreditsInTransaction(client, {
              orgId, userId: winner.student_id, amount: credits, source: 'leaderboard', sourceRef: id,
              eventKey: `campaign:${id}:${winner.student_id}`, reason: `Prêmio: ${campaign.title}`, actorUserId: actor.user.id,
            });
            await client.query(
              'INSERT INTO ranking_prizes(campaign_id,org_id,student_id,entry_id,credits) VALUES ($1,$2,$3,$4,$5)',
              [id, orgId, winner.student_id, entry.id, credits],
            );
          }
          await client.query('UPDATE prize_campaigns SET closed_at=clock_timestamp() WHERE id=$1 AND org_id=$2', [id, orgId]);
        }
        const closed = await campaignById(client, orgId, id);
        return { campaign: closed, ranking: await campaignRanking(client, orgId, closed, 1, 25) };
      });
    });
  }
}
