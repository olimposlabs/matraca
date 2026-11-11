import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireIdentity, type AuthIdentity } from '../auth.js';
import type { CourseDocument } from '../course-model.js';
import { assertStudentScope } from '../permissions.js';
import { requireStudyForEvaluation } from '../journey-progress.js';
import { readOperationPolicy } from '../operation-policy.js';
import { reserveCreditsInTransaction } from '../wallet.js';
import { evaluationScenarios, type EvaluationContext, type EvaluationCriterion } from './provider.js';
import { cancelEvaluationInTransaction } from './worker.js';

class EvaluationError extends Error {
  constructor(readonly statusCode: 400 | 403 | 404 | 409 | 429, message: string) {
    super(message);
  }
}

const createInput = z.object({
  recordingId: z.uuid(),
  clientKey: z.uuid(),
  scenario: z.enum(evaluationScenarios).optional(),
}).strict();
const listQuery = z.object({
  studentId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
const requestPath = z.object({ id: z.uuid() }).strict();
const learnerProfile = z.object({
  profession: z.string().max(200).optional(),
  experience: z.string().max(300).optional(),
  goals: z.array(z.string().max(300)).max(10).optional(),
});

const defaultDescriptors = [
  'O comportamento aparece pouco ou ainda exige apoio.',
  'O comportamento aparece em parte da apresentação.',
  'O comportamento aparece de forma consistente.',
  'O comportamento é ajustado à intenção e ao público.',
] as const;

const defaultCriteria: EvaluationCriterion[] = [
  { id: 'clarity', title: 'Clareza da mensagem', modality: 'both', weight: 3, descriptors: defaultDescriptors },
  { id: 'structure', title: 'Estrutura', modality: 'both', weight: 2, descriptors: defaultDescriptors },
  { id: 'voice', title: 'Voz e ritmo', modality: 'audio', weight: 2, descriptors: defaultDescriptors },
  { id: 'presence', title: 'Presença visual', modality: 'visual', weight: 2, descriptors: defaultDescriptors },
];

interface Recording {
  id: string;
  duration_us: string;
  has_audio: boolean;
  has_video: boolean;
  objective: string;
  purpose: EvaluationContext['purpose'];
  enrollment_id: string | null;
  version_id: string | null;
  unit_id: string | null;
  scenario: EvaluationContext['audienceScenario'];
}

const summary = `r.id,r.student_id AS "studentId",r.recording_id AS "recordingId",r.status,r.credits,
  r.created_at AS "createdAt",r.completed_at AS "completedAt",j.attempts,r.error_code AS "errorCode",
  m.purpose,m.objective,m.duration_us::double precision AS "durationMicroseconds",m.unit_id AS "unitId",
  m.version_id AS "versionId",m.enrollment_id AS "enrollmentId",m.has_audio AS "hasAudio",m.has_video AS "hasVideo",
  (er.report->>'overallLevel')::double precision AS "overallLevel",true AS simulated`;
const joined = `FROM evaluation_requests r JOIN evaluation_jobs j ON j.request_id=r.id
  JOIN recordings m ON m.id=r.recording_id AND m.org_id=r.org_id AND m.student_id=r.student_id
  LEFT JOIN evaluation_results er ON er.request_id=r.id`;

function errorMessage(code: string | null): string | null {
  switch (code) {
    case 'timeout': return 'O simulador excedeu o tempo de resposta. Os créditos reservados foram liberados.';
    case 'invalid': return 'O simulador devolveu um relatório inválido. Os créditos reservados foram liberados.';
    case 'permanent':
    case 'temporary': return 'A avaliação simulada falhou. Os créditos reservados foram liberados.';
    default: return null;
  }
}

async function contextFor(client: PoolClient, actor: AuthIdentity, recording: Recording, id: string): Promise<EvaluationContext> {
  let criteria = defaultCriteria;
  let rubricVersion = 'matraca-pilot-v1';
  let activity: EvaluationContext['activity'] = null;
  if (recording.purpose === 'diagnostic' && actor.org.settings.diagnosticEnabled === false) {
    throw new EvaluationError(403, 'O diagnóstico está desativado nesta organização.');
  }
  if (recording.purpose === 'course') {
    if (actor.org.settings.coursesEnabled === false) throw new EvaluationError(403, 'Os cursos estão desativados nesta organização.');
    const current = await client.query<{ document: CourseDocument; version: number }>(
      `SELECT v.document,v.version FROM course_enrollments e
       JOIN course_versions v ON v.id=e.version_id AND v.org_id=e.org_id
       WHERE e.id=$1 AND e.version_id=$2 AND e.org_id=$3 AND e.student_id=$4 AND e.status IN ('active','completed')
       FOR SHARE OF e`,
      [recording.enrollment_id, recording.version_id, actor.org.id, actor.user.id],
    );
    const version = current.rows[0];
    const unit = version?.document.modules.flatMap(module => module.units).find(item => item.id === recording.unit_id);
    if (!unit) throw new EvaluationError(403, 'A atividade não está disponível na sua matrícula.');
    await requireStudyForEvaluation(client, { orgId: actor.org.id, studentId: actor.user.id, enrollmentId: recording.enrollment_id! }, unit.id, actor.org.settings.strictJourney === true);
    criteria = unit.activity.criteria.filter(criterion => criterion.enabled && criterion.weight > 0);
    activity = { title: unit.title, instructionMarkdown: unit.instructionMarkdown };
    rubricVersion = `${recording.version_id}:${unit.id}:v${version.version}`;
  }
  if (!criteria.length) throw new EvaluationError(409, 'Esta atividade está sem critérios de avaliação.');
  const person = await client.query<{ profile: unknown }>('SELECT profile FROM users WHERE id=$1 AND org_id=$2', [actor.user.id, actor.org.id]);
  const learner = learnerProfile.safeParse(person.rows[0]?.profile);
  const history = await client.query<{ rubricVersion: string; score: number | null }>(
    `SELECT report->>'rubricVersion' AS "rubricVersion",(report->>'overallLevel')::double precision AS score
     FROM evaluation_results WHERE org_id=$1 AND student_id=$2 ORDER BY created_at DESC,request_id DESC LIMIT 5`,
    [actor.org.id, actor.user.id],
  );
  return {
    requestId: id,
    recording: {
      id: recording.id, durationMicroseconds: Number(recording.duration_us),
      hasAudio: recording.has_audio, hasVideo: recording.has_video,
    },
    objective: recording.objective,
    purpose: recording.purpose,
    audienceScenario: recording.scenario,
    activity,
    rubricVersion,
    criteria,
    learner: learner.success ? learner.data : {},
    recentResults: history.rows,
  };
}

async function studentMutation<T>(request: FastifyRequest, task: (client: PoolClient, actor: AuthIdentity) => Promise<T>): Promise<T> {
  const session = await requireIdentity(request, ['student']);
  return request.server.db.transaction(async client => {
    // Serialize duplicate submissions and capacity checks for the same learner.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8))', [session.user.id]);
    const actor = await requireIdentity(request, ['student'], client);
    if (actor.user.id !== session.user.id || actor.org.id !== session.org.id) throw new EvaluationError(403, 'Sua sessão mudou. Entre novamente.');
    return task(client, actor);
  });
}

export async function registerEvaluations(app: FastifyInstance) {
  app.post('/api/evaluations', async (request, reply) => {
    const input = createInput.safeParse(request.body);
    if (!input.success) throw new EvaluationError(400, 'Confira a gravação e o cenário de avaliação.');
    const { recordingId, clientKey } = input.data;
    const queued = await studentMutation(request, async (client, actor) => {
      const existing = await client.query<{ id: string; recording_id: string; scenario: string; status: string; credits: number }>(
        'SELECT id,recording_id,scenario,status,credits FROM evaluation_requests WHERE org_id=$1 AND student_id=$2 AND client_key=$3',
        [actor.org.id, actor.user.id, clientKey],
      );
      const previous = existing.rows[0];
      if (previous) {
        if (previous.recording_id !== recordingId || (input.data.scenario && previous.scenario !== input.data.scenario)) throw new EvaluationError(409, 'A chave do pedido já está associada a outra avaliação.');
        return { id: previous.id, status: previous.status, credits: previous.credits, simulated: true };
      }
      const found = await client.query<Recording>(
        `SELECT id,duration_us,has_audio,has_video,objective,purpose,enrollment_id,version_id,unit_id,scenario
         FROM recordings WHERE id=$1 AND org_id=$2 AND student_id=$3 FOR SHARE`,
        [recordingId, actor.org.id, actor.user.id],
      );
      if (!found.rows[0]) throw new EvaluationError(404, 'Gravação não encontrada.');
      const running = await client.query<{ recording_id: string }>(
        "SELECT recording_id FROM evaluation_requests WHERE org_id=$1 AND student_id=$2 AND status IN ('queued','processing')",
        [actor.org.id, actor.user.id],
      );
      if (running.rows.some(item => item.recording_id === recordingId)) throw new EvaluationError(409, 'Esta gravação já tem uma avaliação em andamento.');
      const { config } = await readOperationPolicy(client, actor.org.id);
      if (running.rows.length >= config.maxConcurrentEvaluations) throw new EvaluationError(429, 'Aguarde a conclusão de uma das suas avaliações.');
      const frequency = await client.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM evaluation_requests WHERE org_id=$1 AND student_id=$2 AND created_at>=clock_timestamp()-interval '1 hour'",
        [actor.org.id, actor.user.id],
      );
      if (frequency.rows[0].total >= config.maxEvaluationsPerHour) throw new EvaluationError(429, 'O limite de avaliações por hora foi atingido.');
      const scenario = input.data.scenario ?? config.evaluationScenario;
      const id = randomUUID();
      const context = await contextFor(client, actor, found.rows[0], id);
      const reservation = await reserveCreditsInTransaction(client, {
        orgId: actor.org.id, userId: actor.user.id, requestId: id,
        durationMicroseconds: context.recording.durationMicroseconds,
      });
      if (reservation.status !== 'reserved') throw new EvaluationError(409, 'A reserva desta avaliação não está disponível.');
      await client.query(
        `INSERT INTO evaluation_requests(id,org_id,student_id,recording_id,client_key,scenario,context,credits)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, actor.org.id, actor.user.id, recordingId, clientKey, scenario, context, reservation.amount],
      );
      await client.query('INSERT INTO evaluation_jobs(request_id) VALUES ($1)', [id]);
      await client.query("INSERT INTO evaluation_outbox(request_id,event_type) VALUES ($1,'queued')", [id]);
      return { id, status: 'queued', credits: reservation.amount, simulated: true };
    });
    return reply.code(202).send({ evaluation: queued });
  });

  app.get('/api/evaluations', async request => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) throw new EvaluationError(400, 'Confira os filtros das avaliações.');
    const actor = await requireIdentity(request, ['student', 'teacher', 'school', 'org_admin']);
    const { studentId = actor.user.id, page, pageSize } = query.data;
    return app.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await assertStudentScope(client, actor, studentId);
      const count = await client.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM evaluation_requests WHERE org_id=$1 AND student_id=$2', [actor.org.id, studentId],
      );
      const results = await client.query<{ errorCode: string | null }>(
        `SELECT ${summary} ${joined} WHERE r.org_id=$1 AND r.student_id=$2
         ORDER BY r.created_at DESC,r.id DESC LIMIT $3 OFFSET $4`,
        [actor.org.id, studentId, pageSize, (page - 1) * pageSize],
      );
      return {
        items: results.rows.map(item => ({ ...item, errorMessage: errorMessage(item.errorCode) })),
        total: count.rows[0].total, page, pageSize,
      };
    });
  });

  app.get('/api/evaluations/:id', async request => {
    const params = requestPath.safeParse(request.params);
    if (!params.success) throw new EvaluationError(400, 'Avaliação inválida.');
    const actor = await requireIdentity(request, ['student', 'teacher', 'school', 'org_admin']);
    return app.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await client.query<{ studentId: string; errorCode: string | null }>(
        `SELECT ${summary},r.context->'criteria' AS criteria,r.context->'activity' AS activity,
           r.context->>'audienceScenario' AS "audienceScenario",er.report
         ${joined} WHERE r.id=$1 AND r.org_id=$2`,
        [params.data.id, actor.org.id],
      );
      const item = result.rows[0];
      if (!item) throw new EvaluationError(404, 'Avaliação não encontrada.');
      await assertStudentScope(client, actor, item.studentId);
      return { evaluation: { ...item, errorMessage: errorMessage(item.errorCode) } };
    });
  });

  app.post('/api/evaluations/:id/cancel', async request => {
    const params = requestPath.safeParse(request.params);
    if (!params.success) throw new EvaluationError(400, 'Avaliação inválida.');
    return studentMutation(request, async (client, actor) => {
      const status = await cancelEvaluationInTransaction(client, { orgId: actor.org.id, studentId: actor.user.id, requestId: params.data.id });
      if (!status) throw new EvaluationError(404, 'Avaliação não encontrada.');
      if (status !== 'cancelled') throw new EvaluationError(409, 'Esta avaliação já foi encerrada.');
      return { status };
    });
  });
}
