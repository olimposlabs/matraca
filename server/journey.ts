import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireIdentity, type AuthIdentity } from './auth.js';
import type { CourseDocument } from './course-model.js';
import { courseProgress, JourneyError, updateStudy } from './journey-progress.js';
import { assertStudentScope } from './permissions.js';

const profileInput = z.object({
  profession: z.string().trim().min(1).max(200),
  experience: z.enum(['beginner', 'intermediate', 'advanced']),
  goals: z.array(z.string().trim().min(1).max(300)).min(1).max(5),
  mode: z.enum(['base', 'diagnostic']),
}).strict();
const studyInput = z.object({
  unitId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/),
  checked: z.array(z.number().int().min(0).max(99)).max(100),
  completeStudy: z.boolean(),
}).strict();
const enrollmentPath = z.object({ enrollmentId: z.uuid() }).strict();

function parse<Value>(schema: z.ZodType<Value>, value: unknown): Value {
  const result = schema.safeParse(value);
  if (!result.success) throw new JourneyError(400, 'Confira os dados da sua jornada.');
  return result.data;
}

function publicProfile(input: unknown) {
  const profile = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    profession: typeof profile.profession === 'string' ? profile.profession : '',
    experience: typeof profile.experience === 'string' && ['beginner', 'intermediate', 'advanced'].includes(profile.experience) ? profile.experience : '',
    goals: Array.isArray(profile.goals) ? profile.goals.filter((item): item is string => typeof item === 'string').slice(0, 5) : [],
    mode: profile.journeyMode === 'diagnostic' ? 'diagnostic' : 'base',
    updatedAt: typeof profile.journeyUpdatedAt === 'string' ? profile.journeyUpdatedAt : null,
  };
}

const diagnosticPriorities: Record<string, { title: string; focus: string }> = {
  clarity: { title: 'Clareza da mensagem', focus: 'Resuma sua ideia principal em uma frase e corte palavras desnecessárias.' },
  structure: { title: 'Estrutura', focus: 'Organize a próxima fala em abertura, desenvolvimento e fechamento.' },
  voice: { title: 'Voz e ritmo', focus: 'Experimente pausas intencionais antes das ideias que deseja destacar.' },
  presence: { title: 'Presença visual', focus: 'Observe a postura, a direção do olhar e os gestos em uma nova gravação.' },
};

const priorityKeywords: Record<string, string[]> = {
  clarity: ['clareza', 'compreensiv', 'informacoes'],
  structure: ['roteiro', 'abertura', 'concluir', 'passagem entre ideias'],
  voice: ['voz', 'ritmo', 'pausas', 'vocais'],
  presence: ['enquadramento', 'gestos', 'camera', 'postura'],
};

interface SuggestedUnit {
  courseId: string;
  enrollmentId: string;
  unitId: string;
  title: string;
}

async function availableSuggestions(client: PoolClient, orgId: string, studentId: string) {
  const result = await client.query<SuggestedUnit>(
    `SELECT e.course_id AS "courseId",e.id AS "enrollmentId",unit->>'id' AS "unitId",unit->>'title' AS title
     FROM course_enrollments e JOIN course_versions v ON v.id=e.version_id AND v.org_id=e.org_id
     CROSS JOIN LATERAL jsonb_array_elements(v.document->'modules') WITH ORDINALITY AS modules(module,module_order)
     CROSS JOIN LATERAL jsonb_array_elements(module->'units') WITH ORDINALITY AS units(unit,unit_order)
     WHERE e.org_id=$1 AND e.student_id=$2 AND e.status='active' AND v.document->>'journey'='adaptive'
       AND NOT EXISTS (SELECT 1 FROM course_unit_progress p
         WHERE p.enrollment_id=e.id AND p.unit_id=unit->>'id' AND p.completed_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(unit->'prerequisites') prerequisite
         WHERE NOT EXISTS (SELECT 1 FROM course_unit_progress p
           WHERE p.enrollment_id=e.id AND p.unit_id=prerequisite AND p.completed_at IS NOT NULL))
     ORDER BY e.created_at,module_order,unit_order`, [orgId, studentId],
  );
  return result.rows;
}

function normalized(value: string) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

interface ResultRow {
  id: string;
  status: string;
  report: {
    overallLevel: number | null;
    rubricVersion: string;
    observations: { criterionId: string; level: number | null }[];
  } | null;
}

async function mutateStudent<T>(request: FastifyRequest, task: (client: PoolClient, actor: AuthIdentity) => Promise<T>) {
  const session = await requireIdentity(request, ['student']);
  return request.server.db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8))', [session.user.id]);
    const actor = await requireIdentity(request, ['student'], client);
    if (actor.user.id !== session.user.id || actor.org.id !== session.org.id) throw new JourneyError(403, 'Sua sessão mudou. Entre novamente.');
    return task(client, actor);
  });
}

export async function registerJourney(app: FastifyInstance) {
  app.get('/api/journey', async request => {
    const actor = await requireIdentity(request, ['student']);
    return app.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const person = await client.query<{ profile: unknown }>('SELECT profile FROM users WHERE org_id=$1 AND id=$2', [actor.org.id, actor.user.id]);
      const profile = publicProfile(person.rows[0]?.profile);
      const result = await client.query<ResultRow>(
        `SELECT r.id,r.status,er.report FROM evaluation_requests r
         JOIN recordings m ON m.id=r.recording_id AND m.org_id=r.org_id AND m.student_id=r.student_id
         LEFT JOIN evaluation_results er ON er.request_id=r.id
         WHERE r.org_id=$1 AND r.student_id=$2 AND m.purpose='diagnostic' ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
        [actor.org.id, actor.user.id],
      );
      const diagnostic = result.rows[0];
      const priorities = (diagnostic?.report?.observations ?? [])
        .filter(item => item.level !== null && diagnosticPriorities[item.criterionId])
        .sort((a, b) => a.level! - b.level!).slice(0, 2)
        .map(item => ({ criterionId: item.criterionId, level: item.level, ...diagnosticPriorities[item.criterionId] }));
      const coursesEnabled = actor.org.settings.coursesEnabled !== false;
      const strictJourney = actor.org.settings.strictJourney === true;
      const suggestions = coursesEnabled && !strictJourney && profile.mode === 'diagnostic' && priorities.length
        ? await availableSuggestions(client, actor.org.id, actor.user.id) : [];
      const used = new Set<string>();
      const suggestedPriorities = priorities.map(priority => {
        const keywords = priorityKeywords[priority.criterionId];
        const recommendedUnit = suggestions.find(unit => {
          const key = `${unit.enrollmentId}:${unit.unitId}`;
          return !used.has(key) && keywords?.some(keyword => normalized(unit.title).includes(keyword));
        });
        if (recommendedUnit) used.add(`${recommendedUnit.enrollmentId}:${recommendedUnit.unitId}`);
        return { ...priority, recommendedUnit: recommendedUnit ?? null };
      });
      const courses = coursesEnabled ? await client.query(
        `SELECT e.id AS "enrollmentId",e.course_id AS "courseId",e.status,v.document->>'title' AS title,
           (SELECT count(*)::int FROM course_unit_progress p WHERE p.enrollment_id=e.id AND p.completed_at IS NOT NULL) AS "completedUnits",
           (SELECT count(*)::int FROM jsonb_array_elements(v.document->'modules') module
              CROSS JOIN LATERAL jsonb_array_elements(module->'units')) AS "totalUnits"
         FROM course_enrollments e JOIN course_versions v ON v.id=e.version_id AND v.org_id=e.org_id
         WHERE e.org_id=$1 AND e.student_id=$2 AND e.status<>'cancelled' ORDER BY e.created_at`,
        [actor.org.id, actor.user.id],
      ) : { rows: [] };
      return {
        profile, courses: courses.rows, coursesEnabled, strictJourney,
        diagnostic: {
          enabled: actor.org.settings.diagnosticEnabled !== false,
          evaluationId: diagnostic?.id ?? null,
          status: diagnostic?.status ?? null,
          overallLevel: diagnostic?.report?.overallLevel ?? null,
          priorities: suggestedPriorities,
        },
      };
    });
  });

  app.put('/api/journey/profile', async request => {
    const input = parse(profileInput, request.body);
    return mutateStudent(request, async (client, actor) => {
      if (input.mode === 'diagnostic' && actor.org.settings.diagnosticEnabled === false) {
        throw new JourneyError(403, 'O diagnóstico está desativado nesta organização.');
      }
      const next = {
        profession: input.profession,
        experience: input.experience,
        goals: [...new Set(input.goals)],
        journeyMode: input.mode,
        journeyUpdatedAt: new Date().toISOString(),
      };
      const updated = await client.query<{ profile: unknown }>(
        'UPDATE users SET profile=profile||$3::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND org_id=$2 RETURNING profile',
        [actor.user.id, actor.org.id, next],
      );
      return { profile: publicProfile(updated.rows[0].profile) };
    });
  });

  app.get('/api/journey/courses/:enrollmentId', async request => {
    const { enrollmentId } = parse(enrollmentPath, request.params);
    const actor = await requireIdentity(request, ['student']);
    if (actor.org.settings.coursesEnabled === false) throw new JourneyError(403, 'Os cursos estão desativados nesta organização.');
    return app.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const progress = await courseProgress(client, { orgId: actor.org.id, studentId: actor.user.id, enrollmentId }, actor.org.settings.strictJourney === true);
      return { progress };
    });
  });

  app.put('/api/journey/courses/:enrollmentId/study', async request => {
    const { enrollmentId } = parse(enrollmentPath, request.params);
    const input = parse(studyInput, request.body);
    return mutateStudent(request, async (client, actor) => {
      if (actor.org.settings.coursesEnabled === false) throw new JourneyError(403, 'Os cursos estão desativados nesta organização.');
      const progress = await updateStudy(client, { orgId: actor.org.id, studentId: actor.user.id, enrollmentId }, actor.org.settings.strictJourney === true, input);
      return { progress };
    });
  });

  app.get('/api/journey/evolution', async request => {
    const { studentId } = parse(z.object({ studentId: z.uuid().optional() }).strict(), request.query);
    const actor = await requireIdentity(request, ['student', 'teacher', 'school', 'org_admin']);
    const target = studentId ?? actor.user.id;
    return app.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await assertStudentScope(client, actor, target);
      const found = await client.query<ResultRow & {
        recordingId: string;
        completedAt: Date;
        purpose: string;
        objective: string;
        criteria: CourseDocument['modules'][number]['units'][number]['activity']['criteria'];
      }>(
        `SELECT r.id,r.status,r.recording_id AS "recordingId",r.completed_at AS "completedAt",
            m.purpose,m.objective,r.context->'criteria' AS criteria,er.report
         FROM evaluation_results er JOIN evaluation_requests r ON r.id=er.request_id
         JOIN recordings m ON m.id=r.recording_id AND m.org_id=r.org_id AND m.student_id=r.student_id
         WHERE r.org_id=$1 AND r.student_id=$2 ORDER BY r.completed_at DESC,r.id DESC LIMIT 50`,
        [actor.org.id, target],
      );
      const attempts = found.rows.reverse().map(row => ({
        id: row.id, recordingId: row.recordingId, completedAt: row.completedAt,
        purpose: row.purpose, objective: row.objective, rubricVersion: row.report?.rubricVersion,
        overallLevel: row.report?.overallLevel,
        scores: row.report?.observations.map(item => ({
          criterionId: item.criterionId,
          title: row.criteria.find(criterion => criterion.id === item.criterionId)?.title ?? item.criterionId,
          level: item.level,
        })),
      }));
      return { attempts };
    });
  });
}
