import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { requireIdentity, type AuthIdentity } from './auth.js';
import { assertStudentScope, STUDENT_SCOPE_SQL, scopeValues, type EducationQuery } from './permissions.js';
import type { EvaluationContext } from './evaluation/provider.js';

export class MentoringError extends Error {
  constructor(public readonly statusCode: 400 | 403 | 404 | 409, message: string) { super(message); this.name = 'MentoringError'; }
}
const text = z.string().trim().min(1).max(5000);
const pageQuery = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).strict();
const panelQuery = pageQuery.extend({ search: z.string().trim().max(120).default('') });
const sessionInput = z.object({ clientKey: z.uuid(), occurredAt: z.iso.datetime({ offset: true }), evaluationId: z.uuid().optional(),
  difficulties: z.array(text).min(1).max(30), guidance: text.max(10000), actions: z.array(text).min(1).max(30),
  followUpOn: z.iso.date().nullable().optional(), supersedesId: z.uuid().optional() }).strict();
const observation = z.object({ criterionId: z.string().min(1).max(100), note: text,
  level: z.number().int().min(1).max(4).nullable().optional(), startUs: z.number().int().nonnegative().optional(), endUs: z.number().int().positive().optional(),
}).strict().refine(data => (data.startUs === undefined) === (data.endUs === undefined));
const reviewInput = z.object({ clientKey: z.uuid(), summary: text.max(10000), observations: z.array(observation).min(1).max(80), supersedesId: z.uuid().optional() }).strict();
const planInput = z.object({ clientKey: z.uuid(), kind: z.enum(['task', 'goal']), title: text.max(180), description: z.string().trim().max(5000).default(''),
  dueOn: z.iso.date().nullable().optional(), mentoringSessionId: z.uuid().optional() }).strict();
const planPatch = z.object({ expectedRevision: z.number().int().min(1), title: text.max(180).optional(), description: z.string().trim().max(5000).optional(),
  dueOn: z.iso.date().nullable().optional(), status: z.enum(['planned', 'in_progress', 'completed', 'cancelled']).optional(), response: z.string().trim().max(5000).optional(),
}).strict().refine(data => Object.keys(data).some(key => key !== 'expectedRevision'));
interface PlanRow extends QueryResultRow {
  id: string; org_id: string; student_id: string; created_by: string; kind: string; title: string; description: string; status: string;
  due_on: string | null; mentoring_session_id: string | null; revision: number; created_at: Date; updated_at: Date;
}
interface SessionRow extends QueryResultRow {
  id: string; student_id: string; teacher_id: string; occurred_at: Date; evaluation_id: string | null; difficulties: string[];
  guidance: string; actions: string[]; follow_up_on: string | null; supersedes_id: string | null; created_at: Date; teacher_name?: string;
}
interface ReviewRow extends QueryResultRow {
  id: string; student_id: string; teacher_id: string; evaluation_id: string; summary: string; observations: z.infer<typeof observation>[];
  supersedes_id: string | null; created_at: Date; teacher_name?: string;
}
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value); if (!result.success) throw new MentoringError(400, 'Confira os dados e filtros de acompanhamento.'); return result.data;
};
const parameter = (request: FastifyRequest, name: string) => parse(z.uuid(), (request.params as Record<string, unknown>)[name]);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicPlan = (row: PlanRow) => ({ id: row.id, studentId: row.student_id, createdBy: row.created_by, kind: row.kind, title: row.title,
  description: row.description, status: row.status, dueOn: row.due_on, mentoringSessionId: row.mentoring_session_id,
  revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at });
const publicSession = (row: SessionRow) => ({ id: row.id, studentId: row.student_id, teacherId: row.teacher_id, teacherName: row.teacher_name,
  occurredAt: row.occurred_at, evaluationId: row.evaluation_id, difficulties: row.difficulties, guidance: row.guidance, actions: row.actions,
  followUpOn: row.follow_up_on, supersedesId: row.supersedes_id, createdAt: row.created_at });
const publicReview = (row: ReviewRow) => ({ id: row.id, studentId: row.student_id, teacherId: row.teacher_id, teacherName: row.teacher_name,
  evaluationId: row.evaluation_id, summary: row.summary, observations: row.observations, supersedesId: row.supersedes_id, createdAt: row.created_at, source: 'human' as const });

async function mutate<T>(request: FastifyRequest, work: (client: PoolClient, actor: AuthIdentity) => Promise<T>) {
  const initial = await requireIdentity(request, ['student', 'teacher', 'school', 'org_admin']);
  return request.server.db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [initial.org.id]);
    const actor = await requireIdentity(request, ['student', 'teacher', 'school', 'org_admin'], client);
    if (actor.org.id !== initial.org.id || actor.user.id !== initial.user.id) throw new MentoringError(403, 'A identidade da sessão mudou.');
    return work(client, actor);
  });
}

/** Teaching authorship never follows the broader self/admin alternatives in the read guard. */
async function isAssignedTeacher(client: EducationQuery, actor: AuthIdentity, studentId: string): Promise<boolean> {
  if (!actor.user.roles.includes('teacher')) return false;
  return !!(await client.query(`SELECT 1 FROM student_schools ss JOIN schools s ON s.id=ss.school_id AND s.org_id=ss.org_id
    JOIN enrollments e ON e.student_id=ss.student_id AND e.org_id=ss.org_id AND e.school_id=ss.school_id
    JOIN classes c ON c.id=e.class_id AND c.org_id=e.org_id JOIN teacher_class_assignments a ON a.class_id=c.id AND a.org_id=c.org_id
    JOIN teacher_profiles p ON p.user_id=a.teacher_id AND p.org_id=a.org_id
    JOIN school_staff st ON st.user_id=a.teacher_id AND st.school_id=c.school_id AND st.org_id=c.org_id
    WHERE ss.org_id=$1 AND ss.student_id=$2 AND ss.ended_at IS NULL AND s.status='active'
      AND e.status='active' AND c.status='active' AND a.teacher_id=$3 AND a.ended_at IS NULL
      AND p.approval_status='approved' AND st.role='teacher' AND st.ended_at IS NULL LIMIT 1`, [actor.org.id, studentId, actor.user.id])).rowCount;
}
async function requireTeacher(client: EducationQuery, actor: AuthIdentity, studentId: string) {
  await assertStudentScope(client, actor, studentId);
  if (!(await isAssignedTeacher(client, actor, studentId))) throw new MentoringError(403, 'A autoria exige professor aprovado e atribuído ao aluno.');
}
async function canManagePlan(client: EducationQuery, actor: AuthIdentity, studentId: string) {
  if (actor.user.roles.includes('org_admin')) return true;
  if (actor.user.roles.includes('school') && (await client.query(`SELECT 1 FROM student_schools ss
    JOIN schools s ON s.id=ss.school_id AND s.org_id=ss.org_id JOIN school_staff st ON st.school_id=s.id AND st.org_id=s.org_id
    WHERE ss.org_id=$1 AND ss.student_id=$2 AND ss.ended_at IS NULL AND s.status='active'
      AND st.user_id=$3 AND st.role='school' AND st.ended_at IS NULL LIMIT 1`, [actor.org.id, studentId, actor.user.id])).rowCount) return true;
  return isAssignedTeacher(client, actor, studentId);
}
async function completedEvaluation(client: EducationQuery, actor: AuthIdentity, evaluationId: string, expectedStudent?: string) {
  const row = (await client.query<{ id: string; student_id: string; context: EvaluationContext; duration_us: string }>(`SELECT e.id,e.student_id,e.context,r.duration_us
    FROM evaluation_requests e JOIN evaluation_results result ON result.request_id=e.id AND result.org_id=e.org_id AND result.student_id=e.student_id
    JOIN recordings r ON r.id=e.recording_id AND r.org_id=e.org_id AND r.student_id=e.student_id
    WHERE e.org_id=$1 AND e.id=$2 AND e.status='completed'`, [actor.org.id, evaluationId])).rows[0];
  if (!row || (expectedStudent && row.student_id !== expectedStudent)) throw new MentoringError(404, 'Avaliação concluída deste aluno não encontrada.');
  return row;
}
async function audit(client: PoolClient, actor: AuthIdentity, event: string, metadata: object) {
  await client.query('INSERT INTO audit_events(org_id,actor_user_id,event_type,metadata) VALUES($1,$2,$3,$4)', [actor.org.id, actor.user.id, event, metadata]);
}
async function history(client: PoolClient, actor: AuthIdentity, item: PlanRow, response = '') {
  await client.query(`INSERT INTO individual_plan_history(item_id,org_id,student_id,revision,actor_id,actor_roles,snapshot,response)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [item.id, item.org_id, item.student_id, item.revision, actor.user.id, actor.user.roles, publicPlan(item), response]);
}
async function planItem(client: EducationQuery, actor: AuthIdentity, itemId: string): Promise<PlanRow> {
  const item = (await client.query<PlanRow>('SELECT *,due_on::text FROM individual_plan_items WHERE org_id=$1 AND id=$2', [actor.org.id, itemId])).rows[0];
  if (!item) throw new MentoringError(404, 'Item do plano não encontrado.');
  await assertStudentScope(client, actor, item.student_id); return item;
}
async function pageRows<Row extends QueryResultRow>(client: EducationQuery, from: string, where: string, values: unknown[], page: z.infer<typeof pageQuery>, select = '*', order = 'created_at DESC,id DESC') {
  const total = (await client.query<{ total: number }>(`SELECT count(*)::integer AS total ${from} WHERE ${where}`, values)).rows[0].total;
  const items = await client.query<Row>(`SELECT ${select} ${from} WHERE ${where} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, page.pageSize, (page.page - 1) * page.pageSize]);
  return { items: items.rows, total, page: page.page, pageSize: page.pageSize };
}

export async function registerMentoring(app: FastifyInstance) {
  app.get('/api/mentoring/students', async request => {
    const actor = await requireIdentity(request, ['teacher', 'school', 'org_admin']);
    const page = parse(panelQuery, request.query), search = page.search.replace(/[\\%_]/g, '\\$&');
    const where = `u.org_id=$1 AND 'student'=ANY(u.roles) AND u.archived_at IS NULL AND ${STUDENT_SCOPE_SQL}
      AND ($4::text='' OR u.name ILIKE $4 OR u.email ILIKE $4)`;
    return pageRows(app.db, 'FROM users u', where, [...scopeValues(actor), search ? `%${search}%` : ''], page,
      `u.id,u.name,u.email,u.status,
      (SELECT max(occurred_at) FROM mentoring_sessions m WHERE m.org_id=u.org_id AND m.student_id=u.id) AS "lastMentoringAt",
      (SELECT count(*)::integer FROM individual_plan_items p WHERE p.org_id=u.org_id AND p.student_id=u.id AND p.status IN ('planned','in_progress')) AS "pendingItems",
      (SELECT result.report->'overallLevel' FROM evaluation_results result WHERE result.org_id=u.org_id AND result.student_id=u.id ORDER BY result.created_at DESC LIMIT 1) AS "latestLevel"`, 'u.name,u.id');
  });
  app.get('/api/mentoring/students/:id', async request => {
    const actor = await requireIdentity(request, ['student', 'teacher', 'school', 'org_admin']), studentId = parameter(request, 'id');
    await assertStudentScope(app.db, actor, studentId);
    const student = (await app.db.query('SELECT id,name,email,profile FROM users WHERE org_id=$1 AND id=$2', [actor.org.id, studentId])).rows[0];
    return { student, permissions: { authorTeacher: await isAssignedTeacher(app.db, actor, studentId), managePlan: await canManagePlan(app.db, actor, studentId), ownProgress: actor.user.id === studentId && actor.user.roles.includes('student') } };
  });
  for (const kind of ['sessions', 'reviews', 'plan'] as const) app.get(`/api/mentoring/students/:id/${kind}`, async request => {
    const actor = await requireIdentity(request, ['student', 'teacher', 'school', 'org_admin']), studentId = parameter(request, 'id'), page = parse(pageQuery, request.query);
    await assertStudentScope(app.db, actor, studentId);
    if (kind === 'plan') {
      const result = await pageRows<PlanRow>(app.db, 'FROM individual_plan_items', 'org_id=$1 AND student_id=$2', [actor.org.id, studentId], page, '*,due_on::text');
      return { ...result, items: result.items.map(publicPlan) };
    }
    if (kind === 'sessions') {
      const result = await pageRows<SessionRow>(app.db, 'FROM mentoring_sessions m JOIN users author ON author.id=m.teacher_id AND author.org_id=m.org_id', 'm.org_id=$1 AND m.student_id=$2', [actor.org.id, studentId], page, 'm.*,m.follow_up_on::text,author.name AS teacher_name', 'm.occurred_at DESC,m.id DESC');
      return { ...result, items: result.items.map(publicSession) };
    }
    const result = await pageRows<ReviewRow>(app.db, 'FROM human_reviews r JOIN users author ON author.id=r.teacher_id AND author.org_id=r.org_id', 'r.org_id=$1 AND r.student_id=$2', [actor.org.id, studentId], page, 'r.*,author.name AS teacher_name', 'r.created_at DESC,r.id DESC');
    return { ...result, items: result.items.map(publicReview) };
  });

  app.post('/api/mentoring/students/:id/sessions', async (request, reply) => {
    const studentId = parameter(request, 'id'), input = parse(sessionInput, request.body);
    const item = await mutate(request, async (client, actor) => {
      await requireTeacher(client, actor, studentId);
      if (input.evaluationId) await completedEvaluation(client, actor, input.evaluationId, studentId);
      const signature = fingerprint([studentId, input]);
      const existing = (await client.query<SessionRow & { fingerprint: string }>('SELECT *,follow_up_on::text FROM mentoring_sessions WHERE org_id=$1 AND teacher_id=$2 AND client_key=$3', [actor.org.id, actor.user.id, input.clientKey])).rows[0];
      if (existing) { if (existing.fingerprint !== signature) throw new MentoringError(409, 'Pedido repetido com dados diferentes.'); return existing; }
      if (input.supersedesId && !(await client.query('SELECT id FROM mentoring_sessions WHERE org_id=$1 AND student_id=$2 AND teacher_id=$3 AND id=$4', [actor.org.id, studentId, actor.user.id, input.supersedesId])).rowCount) throw new MentoringError(404, 'Mentoria original deste autor não encontrada.');
      const row = (await client.query<SessionRow>(`INSERT INTO mentoring_sessions(org_id,student_id,teacher_id,client_key,fingerprint,occurred_at,evaluation_id,difficulties,guidance,actions,follow_up_on,supersedes_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *,follow_up_on::text`, [actor.org.id, studentId, actor.user.id, input.clientKey, signature,
        input.occurredAt, input.evaluationId ?? null, JSON.stringify(input.difficulties), input.guidance, JSON.stringify(input.actions), input.followUpOn ?? null, input.supersedesId ?? null])).rows[0];
      await audit(client, actor, 'mentoring_session_recorded', { studentId, sessionId: row.id }); return row;
    });
    return reply.code(201).send({ session: publicSession(item) });
  });

  app.post('/api/mentoring/evaluations/:id/reviews', async (request, reply) => {
    const evaluationId = parameter(request, 'id'), input = parse(reviewInput, request.body);
    const item = await mutate(request, async (client, actor) => {
      const evaluation = await completedEvaluation(client, actor, evaluationId);
      await requireTeacher(client, actor, evaluation.student_id);
      const criteria = new Map(evaluation.context.criteria.map(criterion => [criterion.id, criterion]));
      for (const annotation of input.observations) {
        const criterion = criteria.get(annotation.criterionId);
        if (!criterion) throw new MentoringError(400, 'Critério não pertence à rubrica desta avaliação.');
        if (annotation.startUs !== undefined && (annotation.endUs! <= annotation.startUs || annotation.endUs! > Number(evaluation.duration_us))) throw new MentoringError(400, 'Trecho fora dos limites da gravação.');
        if (annotation.level != null && ((criterion.modality === 'visual' && !evaluation.context.recording.hasVideo) || (criterion.modality === 'audio' && !evaluation.context.recording.hasAudio))) throw new MentoringError(400, 'O formato não permite atribuir nível neste critério.');
      }
      const signature = fingerprint([evaluationId, input]);
      const existing = (await client.query<ReviewRow & { fingerprint: string }>('SELECT * FROM human_reviews WHERE org_id=$1 AND teacher_id=$2 AND client_key=$3', [actor.org.id, actor.user.id, input.clientKey])).rows[0];
      if (existing) { if (existing.fingerprint !== signature) throw new MentoringError(409, 'Pedido repetido com dados diferentes.'); return existing; }
      if (input.supersedesId && !(await client.query('SELECT id FROM human_reviews WHERE org_id=$1 AND evaluation_id=$2 AND teacher_id=$3 AND id=$4', [actor.org.id, evaluationId, actor.user.id, input.supersedesId])).rowCount) throw new MentoringError(404, 'Revisão original deste autor não encontrada.');
      const row = (await client.query<ReviewRow>(`INSERT INTO human_reviews(org_id,student_id,teacher_id,evaluation_id,client_key,fingerprint,summary,observations,supersedes_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [actor.org.id, evaluation.student_id, actor.user.id, evaluationId, input.clientKey, signature, input.summary, JSON.stringify(input.observations), input.supersedesId ?? null])).rows[0];
      await audit(client, actor, 'human_review_recorded', { studentId: evaluation.student_id, reviewId: row.id, evaluationId }); return row;
    });
    return reply.code(201).send({ review: publicReview(item) });
  });

  app.post('/api/mentoring/students/:id/plan', async (request, reply) => {
    const studentId = parameter(request, 'id'), input = parse(planInput, request.body);
    const item = await mutate(request, async (client, actor) => {
      await assertStudentScope(client, actor, studentId);
      if (!(await canManagePlan(client, actor, studentId))) throw new MentoringError(403, 'Somente professor atribuído ou gestor autorizado cria itens do plano.');
      const signature = fingerprint([studentId, input]);
      const existing = (await client.query<PlanRow & { fingerprint: string }>('SELECT *,due_on::text FROM individual_plan_items WHERE org_id=$1 AND created_by=$2 AND client_key=$3', [actor.org.id, actor.user.id, input.clientKey])).rows[0];
      if (existing) { if (existing.fingerprint !== signature) throw new MentoringError(409, 'Pedido repetido com dados diferentes.'); return existing; }
      if (input.mentoringSessionId && !(await client.query('SELECT id FROM mentoring_sessions WHERE org_id=$1 AND student_id=$2 AND id=$3', [actor.org.id, studentId, input.mentoringSessionId])).rowCount) throw new MentoringError(404, 'Mentoria deste aluno não encontrada.');
      const row = (await client.query<PlanRow>(`INSERT INTO individual_plan_items(org_id,student_id,created_by,client_key,fingerprint,kind,title,description,due_on,mentoring_session_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *,due_on::text`, [actor.org.id, studentId, actor.user.id, input.clientKey, signature, input.kind, input.title, input.description, input.dueOn ?? null, input.mentoringSessionId ?? null])).rows[0];
      await history(client, actor, row); await audit(client, actor, 'individual_plan_created', { studentId, itemId: row.id }); return row;
    });
    return reply.code(201).send({ item: publicPlan(item) });
  });
  app.patch('/api/mentoring/plan/:id', async request => {
    const itemId = parameter(request, 'id'), input = parse(planPatch, request.body);
    const item = await mutate(request, async (client, actor) => {
      const current = await planItem(client, actor, itemId), manager = await canManagePlan(client, actor, current.student_id);
      if (!manager) {
        if (actor.user.id !== current.student_id || !actor.user.roles.includes('student')) throw new MentoringError(403, 'Você não pode atualizar este plano.');
        if (input.title !== undefined || input.description !== undefined || input.dueOn !== undefined || input.status === 'cancelled') throw new MentoringError(403, 'O aluno atualiza apenas progresso e resposta.');
        if (current.status === 'cancelled') throw new MentoringError(409, 'O item foi cancelado pelo responsável.');
      }
      if (current.revision !== input.expectedRevision) throw new MentoringError(409, 'O plano mudou. Recarregue antes de salvar.');
      const next = (await client.query<PlanRow>(`UPDATE individual_plan_items SET title=$3,description=$4,status=$5,due_on=$6,revision=revision+1,updated_at=clock_timestamp()
        WHERE org_id=$1 AND id=$2 RETURNING *,due_on::text`, [actor.org.id, current.id, input.title ?? current.title, input.description ?? current.description,
        input.status ?? current.status, input.dueOn === undefined ? current.due_on : input.dueOn])).rows[0];
      await history(client, actor, next, input.response ?? ''); await audit(client, actor, 'individual_plan_updated', { studentId: current.student_id, itemId, revision: next.revision }); return next;
    });
    return { item: publicPlan(item) };
  });
  app.get('/api/mentoring/plan/:id/history', async request => {
    const actor = await requireIdentity(request, ['student', 'teacher', 'school', 'org_admin']), item = await planItem(app.db, actor, parameter(request, 'id'));
    const page = parse(pageQuery, request.query);
    return pageRows(app.db, 'FROM individual_plan_history h JOIN users author ON author.id=h.actor_id AND author.org_id=h.org_id', 'h.org_id=$1 AND h.item_id=$2', [actor.org.id, item.id], page,
      'h.revision,h.snapshot,h.response,h.actor_id AS "actorId",h.actor_roles AS "actorRoles",author.name AS "actorName",h.created_at AS "createdAt"', 'h.revision DESC');
  });
}
