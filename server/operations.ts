import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireIdentity, type AuthIdentity } from './auth.js';
import { operationPolicySchema, readOperationPolicy } from './operation-policy.js';
import { releaseReservationInTransaction } from './wallet.js';

class OperationsError extends Error {
  constructor(readonly statusCode: 400 | 403 | 404 | 409, message: string) { super(message); }
}

const path = z.object({ orgId: z.uuid() }).passthrough();
const itemPath = path.extend({ id: z.uuid() });
const scopeInput = z.object({
  studentId: z.uuid().optional(),
  schoolId: z.uuid().optional(),
  from: z.iso.date().optional(),
  through: z.iso.date().optional(),
}).strict();
const pagination = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
const base = '/api/backoffice/ops/:orgId';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new OperationsError(400, 'Confira os filtros e os valores operacionais.');
  return result.data;
}

interface Org {
  id: string;
  name: string;
  kind: 'matraca' | 'partner';
  status: string;
}

async function withOperator<T>(request: FastifyRequest, write: boolean, task: (client: PoolClient, org: Org, actor: AuthIdentity) => Promise<T>) {
  const session = await requireIdentity(request, ['operator']);
  if (session.org.kind !== 'backoffice') throw new OperationsError(403, 'Acesso exclusivo do backoffice.');
  const { orgId } = parse(path, request.params);
  return request.server.db.transaction(async client => {
    if (write) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [orgId]);
    else await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actor = write ? await requireIdentity(request, ['operator'], client) : session;
    if (actor.org.kind !== 'backoffice' || actor.user.id !== session.user.id) throw new OperationsError(403, 'Sua sessão mudou.');
    const org = await client.query<Org>(
      `SELECT id,name,kind,status FROM orgs WHERE id=$1 AND kind<>'backoffice' ${write ? 'FOR SHARE' : ''}`, [orgId],
    );
    if (!org.rows[0]) throw new OperationsError(404, 'Organização não encontrada.');
    return task(client, org.rows[0], actor);
  });
}

async function audit(client: PoolClient, actor: AuthIdentity, targetOrgId: string, event: string, metadata: Record<string, unknown> = {}) {
  await client.query('INSERT INTO audit_events(org_id,actor_user_id,event_type,metadata) VALUES ($1,$2,$3,$4)',
    [actor.org.id, actor.user.id, event, { targetOrgId, ...metadata }]);
}

async function period(client: PoolClient, input: z.infer<typeof scopeInput>) {
  const result = await client.query<{ from: string; through: string; start: Date; end: Date; days: number }>(
    `WITH defaults AS (SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS today),
      selected AS (SELECT COALESCE($1::date,date_trunc('month',today)::date) AS start_date,
        COALESCE($2::date,today) AS end_date FROM defaults)
     SELECT start_date::text AS "from",end_date::text AS through,end_date-start_date+1 AS days,
      start_date::timestamp AT TIME ZONE 'America/Sao_Paulo' AS start,
      (end_date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo' AS end FROM selected`,
    [input.from ?? null, input.through ?? null],
  );
  const bounds = result.rows[0];
  if (bounds.days < 1 || bounds.days > 366) throw new OperationsError(400, 'Escolha um período de até 366 dias.');
  return bounds;
}

function eventScope(userColumn: string, dateColumn: string) {
  // Call sites supply only fixed column names. School membership is evaluated at the event timestamp.
  return `($2::uuid IS NULL OR ${userColumn}=$2) AND ($3::uuid IS NULL OR EXISTS (
    SELECT 1 FROM student_schools ss WHERE ss.org_id=$1 AND ss.student_id=${userColumn}
      AND ss.school_id=$3 AND ss.started_at<=${dateColumn} AND (ss.ended_at IS NULL OR ss.ended_at>${dateColumn})
  )) AND ${dateColumn}>=$4 AND ${dateColumn}<$5`;
}

async function metrics(client: PoolClient, orgId: string, input: z.infer<typeof scopeInput>) {
  const bounds = await period(client, input);
  const args = [orgId, input.studentId ?? null, input.schoolId ?? null, bounds.start, bounds.end];
  const upload = await client.query<{ recordings: number; recordedMicroseconds: number; storageBytes: number }>(
    `SELECT count(*)::int AS recordings,COALESCE(sum(r.duration_us),0)::double precision AS "recordedMicroseconds",
        COALESCE(sum(r.byte_length),0)::double precision AS "storageBytes"
     FROM recordings r WHERE r.org_id=$1 AND ${eventScope('r.student_id','r.created_at')}`, args,
  );
  const evaluation = await client.query<{ orders: number; completed: number; failed: number; cancelled: number; active: number }>(
    `SELECT count(*)::int AS orders,count(*) FILTER (WHERE e.status='completed')::int AS completed,
        count(*) FILTER (WHERE e.status='failed')::int AS failed,count(*) FILTER (WHERE e.status='cancelled')::int AS cancelled,
        count(*) FILTER (WHERE e.status IN ('queued','processing'))::int AS active
     FROM evaluation_requests e WHERE e.org_id=$1 AND ${eventScope('e.student_id','e.created_at')}`, args,
  );
  const processed = await client.query<{ durationUs: string; processed: number }>(
    `SELECT COALESCE(sum(r.duration_us),0)::text AS "durationUs",count(*)::int AS processed
     FROM evaluation_results f JOIN evaluation_requests e ON e.id=f.request_id AND e.org_id=f.org_id
     JOIN recordings r ON r.id=e.recording_id AND r.org_id=e.org_id AND r.student_id=e.student_id
     WHERE f.org_id=$1 AND ${eventScope('f.student_id','f.created_at')}`, args,
  );
  const credits = await client.query(
    `SELECT COALESCE(sum(w.delta) FILTER (WHERE w.kind='grant'),0)::double precision AS granted,
        COALESCE(sum(-w.delta) FILTER (WHERE w.kind='consumption'),0)::double precision AS consumed,
        COALESCE(sum(w.delta) FILTER (WHERE w.kind='refund'),0)::double precision AS refunded,
        COALESCE(sum(w.delta) FILTER (WHERE w.kind='adjustment'),0)::double precision AS adjusted
     FROM wallet_entries w WHERE w.org_id=$1 AND ${eventScope('w.user_id','w.created_at')}`, args,
  );
  const current = await client.query(
    `SELECT count(*) FILTER (WHERE u.status='active' AND u.archived_at IS NULL)::int AS "activeStudents",
        COALESCE(sum(w.balance),0)::double precision AS balance,COALESCE(sum(w.reserved),0)::double precision AS reserved,
        COALESCE(sum(w.balance-w.reserved),0)::double precision AS available
     FROM users u LEFT JOIN wallets w ON w.user_id=u.id AND w.org_id=u.org_id
     WHERE u.org_id=$1 AND 'student'=ANY(u.roles) AND ($2::uuid IS NULL OR u.id=$2) AND
       ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM student_schools ss WHERE ss.org_id=$1 AND ss.student_id=u.id AND ss.school_id=$3 AND ss.ended_at IS NULL))`,
    args.slice(0, 3),
  );
  const purchases = await client.query(
    `SELECT count(*)::int AS orders,count(*) FILTER (WHERE p.status='paid')::int AS paid,
        count(*) FILTER (WHERE p.status='pending')::int AS pending,count(*) FILTER (WHERE p.status='declined')::int AS declined,
        count(*) FILTER (WHERE p.status='cancelled')::int AS cancelled
     FROM commerce_orders p WHERE p.org_id=$1 AND ${eventScope('p.student_id','p.created_at')}`, args,
  );
  const settledPurchases = await client.query<{ paidCents: string }>(
    `SELECT COALESCE(sum(p.amount_cents),0)::text AS "paidCents"
     FROM commerce_orders p WHERE p.org_id=$1 AND p.status='paid' AND ${eventScope('p.student_id','p.completed_at')}`, args,
  );
  const invoices = await client.query(
    `SELECT count(*)::int AS invoices,count(*) FILTER (WHERE state='open')::int AS open,
        count(*) FILTER (WHERE state='settled')::int AS settled,COALESCE(sum(total_cents),0)::text AS "totalCents"
     FROM billing_invoices WHERE org_id=$1 AND consumption_month BETWEEN
       date_trunc('month',$2::date)::date AND date_trunc('month',$3::date)::date`,
    [orgId, bounds.from, bounds.through],
  );
  const ratedUsage = await client.query<{ allocatedCents: string }>(
    `SELECT COALESCE(sum(a.amount_cents),0)::text AS "allocatedCents"
     FROM billing_usage_allocations a JOIN wallet_entries w ON w.id=a.consumption_entry_id AND w.org_id=a.org_id
     WHERE a.org_id=$1 AND ${eventScope('w.user_id','w.created_at')}`, args,
  );
  const { config, revision } = await readOperationPolicy(client, orgId);
  const microseconds = BigInt(processed.rows[0].durationUs);
  const estimatedCents = (microseconds * BigInt(config.simulatedCentsPerMinute) + 59_999_999n) / 60_000_000n;
  const flags = await client.query(
    `SELECT e.student_id AS "studentId",u.name,
       count(*) FILTER (WHERE e.created_at>=clock_timestamp()-interval '1 hour')::int AS "lastHour",
       count(*) FILTER (WHERE e.status IN ('queued','processing'))::int AS active,
       count(*) FILTER (WHERE e.status='failed')::int AS failed
     FROM evaluation_requests e JOIN users u ON u.id=e.student_id AND u.org_id=e.org_id
     WHERE e.org_id=$1 AND ${eventScope('e.student_id','e.created_at')}
     GROUP BY e.student_id,u.name
     HAVING count(*) FILTER (WHERE e.created_at>=clock_timestamp()-interval '1 hour') >= $6
       OR count(*) FILTER (WHERE e.status IN ('queued','processing')) >= $7
       OR (count(*)>=3 AND count(*) FILTER (WHERE e.status='failed')*2>count(*))
     ORDER BY "lastHour" DESC,active DESC,e.student_id LIMIT 50`,
    [...args, config.maxEvaluationsPerHour, config.maxConcurrentEvaluations],
  );
  return {
    period: { from: bounds.from, through: bounds.through },
    usage: { ...upload.rows[0], ...evaluation.rows[0], evaluatedMicroseconds: Number(microseconds), processed: processed.rows[0].processed },
    credits: { ...credits.rows[0], ...current.rows[0] },
    estimatedCost: { cents: Number(estimatedCents), centsPerMinute: config.simulatedCentsPerMinute },
    purchases: { ...purchases.rows[0], ...settledPurchases.rows[0] },
    billing: { ...invoices.rows[0], ...ratedUsage.rows[0] },
    flags: flags.rows,
    policy: { config, revision },
  };
}

async function countAndPage(client: PoolClient, sql: string, args: unknown[], page: number, pageSize: number, order: string) {
  const count = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM (${sql}) matches`, args);
  const items = await client.query(
    `SELECT * FROM (${sql}) matches ORDER BY ${order} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    [...args, pageSize, (page - 1) * pageSize],
  );
  return { items: items.rows, total: count.rows[0].total, page, pageSize };
}

export async function registerOperations(app: FastifyInstance) {
  app.get(base, request => {
    const input = parse(scopeInput, request.query);
    return withOperator(request, false, async (client, org) => {
      if (input.schoolId && !(await client.query('SELECT id FROM schools WHERE id=$1 AND org_id=$2', [input.schoolId, org.id])).rowCount) {
        throw new OperationsError(404, 'Escola não encontrada.');
      }
      if (input.studentId && !(await client.query('SELECT id FROM users WHERE id=$1 AND org_id=$2', [input.studentId, org.id])).rowCount) {
        throw new OperationsError(404, 'Aluno não encontrado.');
      }
      const schools = await client.query('SELECT id,name,status FROM schools WHERE org_id=$1 ORDER BY lower(name),id', [org.id]);
      return { org, schools: schools.rows, ...await metrics(client, org.id, input) };
    });
  });

  app.get(`${base}/students`, request => {
    const input = parse(z.object({ ...pagination, search: z.string().trim().max(120).default('') }).strict(), request.query);
    return withOperator(request, false, (client, org) => countAndPage(client,
      `SELECT id,name,email,status FROM users WHERE org_id=$1 AND 'student'=ANY(roles)
         AND (strpos(lower(name),lower($2))>0 OR strpos(lower(email),lower($2))>0)`,
      [org.id, input.search], input.page, input.pageSize, 'lower(name),id'));
  });

  app.put(`${base}/policy`, request => {
    const input = parse(z.object({ expectedRevision: z.number().int().min(0), config: operationPolicySchema }).strict(), request.body);
    return withOperator(request, true, async (client, org, actor) => {
      const current = await readOperationPolicy(client, org.id);
      if (current.revision !== input.expectedRevision) throw new OperationsError(409, 'A política mudou. Recarregue antes de salvar.');
      const updated = await client.query(
        `INSERT INTO operation_policies(org_id,config) VALUES($1,$2) ON CONFLICT(org_id) DO UPDATE
         SET config=EXCLUDED.config,revision=operation_policies.revision+1,updated_at=clock_timestamp()
         RETURNING config,revision`, [org.id, input.config],
      );
      await audit(client, actor, org.id, 'operation_policy_changed', { revision: updated.rows[0].revision });
      return { policy: updated.rows[0] };
    });
  });

  app.get(`${base}/audit`, request => {
    const input = parse(z.object({ ...pagination, event: z.string().trim().max(100).optional() }).strict(), request.query);
    return withOperator(request, false, (client, org, actor) => countAndPage(client,
      `SELECT a.id,a.event_type AS event,a.created_at AS "createdAt",u.name AS actor,
         jsonb_strip_nulls(jsonb_build_object('targetOrgId',a.metadata->'targetOrgId','studentId',a.metadata->'studentId',
           'requestId',a.metadata->'requestId','revision',a.metadata->'revision','reason',a.metadata->'reason')) AS details
       FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id AND u.org_id=a.org_id
       WHERE (a.org_id=$1 OR (a.org_id=$2 AND a.metadata->>'targetOrgId'=$1::text))
         AND ($3::text IS NULL OR a.event_type=$3)`,
      [org.id, actor.org.id, input.event ?? null], input.page, input.pageSize, '"createdAt" DESC,id DESC'));
  });

  app.get(`${base}/jobs`, request => {
    const input = parse(z.object({ ...pagination, status: z.enum(['queued','processing','completed','failed','cancelled']).optional() }).strict(), request.query);
    return withOperator(request, false, (client, org) => countAndPage(client,
      `SELECT r.id,r.student_id AS "studentId",u.name,r.status,r.scenario,r.credits,r.error_code AS "errorCode",
         j.state,j.attempts,j.available_at AS "availableAt",j.lease_until AS "leaseUntil",r.created_at AS "createdAt",
         (r.status IN ('queued','processing') AND j.attempts<3 AND
          (j.state='queued' OR (j.state='leased' AND j.lease_until<=clock_timestamp())) AND w.status='reserved') AS "canRetry"
       FROM evaluation_requests r JOIN evaluation_jobs j ON j.request_id=r.id
       JOIN users u ON u.id=r.student_id AND u.org_id=r.org_id
       LEFT JOIN credit_reservations w ON w.org_id=r.org_id AND w.request_id=r.id::text AND w.user_id=r.student_id
       WHERE r.org_id=$1 AND ($2::text IS NULL OR r.status=$2)`,
      [org.id, input.status ?? null], input.page, input.pageSize, '"createdAt" DESC,id DESC'));
  });

  app.post(`${base}/jobs/:id/retry`, request => {
    const { id } = parse(itemPath, request.params);
    return withOperator(request, true, async (client, org, actor) => {
      const job = await client.query(
        'SELECT j.request_id FROM evaluation_jobs j JOIN evaluation_requests r ON r.id=j.request_id WHERE r.org_id=$1 AND j.request_id=$2 FOR UPDATE OF j',
        [org.id, id],
      );
      if (!job.rowCount) throw new OperationsError(404, 'Tarefa não encontrada.');
      const updated = await client.query(
        `UPDATE evaluation_jobs j SET state='queued',available_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
         FROM evaluation_requests r,credit_reservations w WHERE r.id=j.request_id AND r.id=$1 AND r.org_id=$2
           AND r.status IN ('queued','processing') AND j.attempts<3
           AND (j.state='queued' OR (j.state='leased' AND j.lease_until<=clock_timestamp()))
           AND w.org_id=r.org_id AND w.user_id=r.student_id AND w.request_id=r.id::text AND w.status='reserved'
         RETURNING j.request_id`, [id, org.id],
      );
      if (!updated.rowCount) throw new OperationsError(409, 'A tarefa está em processamento ou já foi encerrada.');
      await client.query("UPDATE evaluation_requests SET status='queued',updated_at=clock_timestamp() WHERE id=$1", [id]);
      await audit(client, actor, org.id, 'evaluation_job_requeued', { requestId: id });
      return { status: 'queued' };
    });
  });

  app.get(`${base}/reservations`, request => {
    const input = parse(z.object(pagination).strict(), request.query);
    return withOperator(request, false, (client, org) => countAndPage(client,
      `SELECT w.id,w.user_id AS "studentId",u.name,w.request_id AS "requestId",w.amount,w.created_at AS "createdAt",
         r.status AS "evaluationStatus",j.state AS "jobState",
         (r.id IS NULL OR r.status IN ('failed','cancelled')) AS "canRelease"
       FROM credit_reservations w JOIN users u ON u.id=w.user_id AND u.org_id=w.org_id
       LEFT JOIN evaluation_requests r ON r.org_id=w.org_id AND r.student_id=w.user_id AND r.id::text=w.request_id
       LEFT JOIN evaluation_jobs j ON j.request_id=r.id WHERE w.org_id=$1 AND w.status='reserved'`,
      [org.id], input.page, input.pageSize, '"createdAt",id'));
  });

  app.post(`${base}/reservations/:id/release`, request => {
    const { id } = parse(itemPath, request.params);
    const input = parse(z.object({ reason: z.string().trim().min(4).max(500) }).strict(), request.body);
    return withOperator(request, true, async (client, org, actor) => {
      const target = await client.query<{ user_id: string; request_id: string; status: string; evaluation_id: string | null }>(
        `SELECT w.user_id,w.request_id,w.status,r.id AS evaluation_id FROM credit_reservations w
         LEFT JOIN evaluation_requests r ON r.org_id=w.org_id AND r.student_id=w.user_id AND r.id::text=w.request_id
         WHERE w.id=$1 AND w.org_id=$2`, [id, org.id],
      );
      const reservation = target.rows[0];
      if (!reservation) throw new OperationsError(404, 'Reserva não encontrada.');
      if (reservation.status === 'released') return { status: 'released' };
      if (reservation.status !== 'reserved') throw new OperationsError(409, 'Um consumo confirmado exige estorno.');
      if (reservation.evaluation_id) {
        await client.query('SELECT request_id FROM evaluation_jobs WHERE request_id=$1 FOR UPDATE', [reservation.evaluation_id]);
        const current = await client.query<{ status: string }>('SELECT status FROM evaluation_requests WHERE id=$1', [reservation.evaluation_id]);
        if (!['failed','cancelled'].includes(current.rows[0].status)) throw new OperationsError(409, 'A reserva pertence a uma avaliação ativa ou concluída.');
      }
      await releaseReservationInTransaction(client, { orgId: org.id, userId: reservation.user_id, requestId: reservation.request_id, reason: input.reason });
      await audit(client, actor, org.id, 'orphan_reservation_released', { requestId: reservation.request_id, studentId: reservation.user_id, reason: input.reason });
      return { status: 'released' };
    });
  });
}
