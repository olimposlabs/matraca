import type { PoolClient } from 'pg';
import type { CourseDocument, CourseUnit } from './course-model.js';
import { grantCreditsInTransaction } from './wallet.js';
import { awardLearningEvent } from './gamification-core.js';

export class JourneyError extends Error {
  constructor(readonly statusCode: 400 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

export interface JourneyTarget {
  orgId: string;
  studentId: string;
  enrollmentId: string;
}

interface Enrollment {
  id: string;
  course_id: string;
  version_id: string;
  org_id: string;
  student_id: string;
  status: 'active' | 'completed';
  document: CourseDocument;
}

interface Progress {
  unit_id: string;
  checked_indices: number[];
  studied_at: Date | null;
  completed_at: Date | null;
  evaluation_id: string | null;
}

async function enrollmentFor(client: PoolClient, target: JourneyTarget, lock: boolean) {
  const result = await client.query<Enrollment>(
    `SELECT e.id,e.course_id,e.version_id,e.org_id,e.student_id,e.status,v.document
     FROM course_enrollments e JOIN course_versions v ON v.id=e.version_id AND v.org_id=e.org_id
     WHERE e.id=$1 AND e.org_id=$2 AND e.student_id=$3 AND e.status IN ('active','completed')
     ${lock ? 'FOR UPDATE OF e' : ''}`,
    [target.enrollmentId, target.orgId, target.studentId],
  );
  return result.rows[0];
}

async function readProgress(client: PoolClient, enrollmentId: string) {
  const result = await client.query<Progress>(
    'SELECT unit_id,checked_indices,studied_at,completed_at,evaluation_id FROM course_unit_progress WHERE enrollment_id=$1',
    [enrollmentId],
  );
  return new Map(result.rows.map(item => [item.unit_id, item]));
}

function allUnits(enrollment: Enrollment) {
  return enrollment.document.modules.flatMap(module => module.units);
}

/** Older publications could reference a later unit. Keep all requirements without deadlocking the sequence. */
function orderedUnits(units: CourseUnit[], sequential: boolean) {
  if (!sequential) return units;
  const remaining = [...units];
  const ordered: CourseUnit[] = [];
  const emitted = new Set<string>();
  while (remaining.length) {
    const index = remaining.findIndex(unit => unit.prerequisites.every(id => emitted.has(id)));
    if (index < 0) return units;
    const [unit] = remaining.splice(index, 1);
    ordered.push(unit);
    emitted.add(unit.id);
  }
  return ordered;
}

function blockers(unit: CourseUnit, units: CourseUnit[], progress: Map<string, Progress>, sequential: boolean) {
  const index = units.findIndex(item => item.id === unit.id);
  const required = new Set(unit.prerequisites);
  if (sequential) for (const previous of units.slice(0, index)) required.add(previous.id);
  return [...required].filter(id => !progress.get(id)?.completed_at);
}

function progressView(enrollment: Enrollment, progress: Map<string, Progress>, strict: boolean) {
  const sequential = strict || enrollment.document.journey === 'sequential';
  const units = orderedUnits(allUnits(enrollment), sequential);
  return {
    enrollmentId: enrollment.id,
    versionId: enrollment.version_id,
    status: enrollment.status,
    sequential,
    completedUnits: units.filter(unit => progress.get(unit.id)?.completed_at).length,
    totalUnits: units.length,
    units: units.map(unit => {
      const record = progress.get(unit.id);
      const missing = blockers(unit, units, progress, sequential);
      return {
        id: unit.id,
        title: unit.title,
        kind: unit.kind,
        checked: record?.checked_indices ?? [],
        studiedAt: record?.studied_at ?? null,
        completedAt: record?.completed_at ?? null,
        evaluationId: record?.evaluation_id ?? null,
        locked: !record?.completed_at && missing.length > 0,
        blockedBy: missing,
      };
    }),
  };
}

export async function courseProgress(client: PoolClient, target: JourneyTarget, strict: boolean) {
  const enrollment = await enrollmentFor(client, target, false);
  if (!enrollment) throw new JourneyError(404, 'Matrícula não encontrada.');
  return progressView(enrollment, await readProgress(client, enrollment.id), strict);
}

async function learningEvent(client: PoolClient, enrollment: Enrollment, kind: 'lesson' | 'review' | 'course', subject: string) {
  const inserted = await client.query<{ id: string }>(
    `WITH RECURSIVE related_groups(id,parent_id) AS (
       SELECT g.id,g.parent_id FROM education_groups g
       JOIN group_memberships m ON m.group_id=g.id AND m.org_id=g.org_id
       WHERE g.org_id=$2 AND m.user_id=$3 AND m.ended_at IS NULL AND g.status='active'
       UNION
       SELECT parent.id,parent.parent_id FROM education_groups parent JOIN related_groups child ON child.parent_id=parent.id
       WHERE parent.org_id=$2 AND parent.status='active'
     )
     INSERT INTO learning_events(enrollment_id,org_id,student_id,kind,subject_id,group_ids)
     SELECT $1,$2,$3,$4,$5,COALESCE(array_agg(id ORDER BY id),'{}') FROM related_groups
     ON CONFLICT(enrollment_id,kind,subject_id) DO NOTHING RETURNING id`,
    [enrollment.id, enrollment.org_id, enrollment.student_id, kind, subject],
  );
  if (inserted.rows[0]) await awardLearningEvent(client, {
    id: inserted.rows[0].id, orgId: enrollment.org_id, studentId: enrollment.student_id, kind,
  });
}

async function completeUnit(client: PoolClient, enrollment: Enrollment, unit: CourseUnit, evaluationId: string | null) {
  const completed = await client.query(
    `UPDATE course_unit_progress SET completed_at=clock_timestamp(),evaluation_id=$3,updated_at=clock_timestamp()
     WHERE enrollment_id=$1 AND unit_id=$2 AND studied_at IS NOT NULL AND completed_at IS NULL RETURNING unit_id`,
    [enrollment.id, unit.id, evaluationId],
  );
  if (!completed.rowCount) return;
  await learningEvent(client, enrollment, unit.kind, unit.id);
  const progress = await readProgress(client, enrollment.id);
  if (!allUnits(enrollment).every(item => progress.get(item.id)?.completed_at)) return;
  const courseCompleted = await client.query(
    "UPDATE course_enrollments SET status='completed',completed_at=clock_timestamp() WHERE id=$1 AND status='active' RETURNING id",
    [enrollment.id],
  );
  if (!courseCompleted.rowCount) return;
  await learningEvent(client, enrollment, 'course', enrollment.course_id);
  const reward = enrollment.document.completionCreditGrant;
  if (reward > 0) await grantCreditsInTransaction(client, {
    orgId: enrollment.org_id,
    userId: enrollment.student_id,
    source: 'course',
    sourceRef: enrollment.course_id,
    amount: reward,
    eventKey: `${enrollment.id}:completion`,
    reason: 'Conclusão do curso',
  });
}

export async function updateStudy(
  client: PoolClient,
  target: JourneyTarget,
  strict: boolean,
  input: { unitId: string; checked: number[]; completeStudy: boolean },
) {
  const enrollment = await enrollmentFor(client, target, true);
  if (!enrollment) throw new JourneyError(404, 'Matrícula não encontrada.');
  const units = allUnits(enrollment);
  const unit = units.find(item => item.id === input.unitId);
  if (!unit) throw new JourneyError(404, 'Unidade não encontrada nesta versão.');
  const progress = await readProgress(client, enrollment.id);
  const current = progress.get(unit.id);
  if (current?.studied_at) return progressView(enrollment, progress, strict);
  const sequential = strict || enrollment.document.journey === 'sequential';
  if (blockers(unit, orderedUnits(units, sequential), progress, sequential).length) throw new JourneyError(409, 'Conclua as unidades anteriores exigidas antes de continuar.');
  const checked = [...new Set(input.checked)].sort((a, b) => a - b);
  if (checked.some(index => index < 0 || index >= unit.checklist.length)) throw new JourneyError(400, 'O checklist foi alterado. Recarregue a unidade.');
  if (input.completeStudy && checked.length !== unit.checklist.length) throw new JourneyError(409, 'Marque todos os itens do checklist antes de concluir o estudo.');
  await client.query(
    `INSERT INTO course_unit_progress(enrollment_id,version_id,org_id,student_id,unit_id,checked_indices,studied_at)
     VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN clock_timestamp() END)
     ON CONFLICT(enrollment_id,unit_id) DO UPDATE SET checked_indices=EXCLUDED.checked_indices,
       studied_at=EXCLUDED.studied_at,updated_at=clock_timestamp()`,
    [enrollment.id, enrollment.version_id, enrollment.org_id, enrollment.student_id, unit.id, checked, input.completeStudy],
  );
  if (input.completeStudy) {
    if (enrollment.document.creditMode === 'progress' && unit.studyCreditGrant > 0) {
      await grantCreditsInTransaction(client, {
        orgId: enrollment.org_id,
        userId: enrollment.student_id,
        source: unit.kind === 'review' ? 'module' : 'lesson',
        sourceRef: unit.id,
        amount: unit.studyCreditGrant,
        eventKey: `${enrollment.id}:${unit.id}:study`,
        reason: unit.kind === 'review' ? 'Estudo da revisão do módulo' : 'Estudo e checklist da aula',
      });
    }
    if (!unit.requiresEvaluation) await completeUnit(client, enrollment, unit, null);
  }
  const progressNow = await readProgress(client, enrollment.id);
  const complete = allUnits(enrollment).every(item => progressNow.get(item.id)?.completed_at);
  return progressView({ ...enrollment, status: complete ? 'completed' : enrollment.status }, progressNow, strict);
}

export async function requireStudyForEvaluation(client: PoolClient, target: JourneyTarget, unitId: string, strict: boolean) {
  const enrollment = await enrollmentFor(client, target, false);
  if (!enrollment) throw new JourneyError(404, 'Matrícula não encontrada.');
  const progress = await readProgress(client, enrollment.id);
  const record = progress.get(unitId);
  if (!record?.studied_at) throw new JourneyError(409, 'Conclua o estudo e o checklist antes de solicitar a avaliação desta unidade.');
  if (record.completed_at) return;
  const sequential = strict || enrollment.document.journey === 'sequential';
  const units = orderedUnits(allUnits(enrollment), sequential);
  const unit = units.find(item => item.id === unitId);
  if (!unit) throw new JourneyError(404, 'Unidade não encontrada nesta versão.');
  if (blockers(unit, units, progress, sequential).length) {
    throw new JourneyError(409, 'Conclua as unidades anteriores exigidas antes de solicitar a avaliação.');
  }
}

export async function applyCourseEvaluation(
  client: PoolClient,
  input: { orgId: string; studentId: string; recordingId: string; evaluationId: string },
) {
  const result = await client.query<{ enrollment_id: string; unit_id: string }>(
    `SELECT enrollment_id,unit_id FROM recordings WHERE id=$1 AND org_id=$2 AND student_id=$3 AND purpose='course'`,
    [input.recordingId, input.orgId, input.studentId],
  );
  const recording = result.rows[0];
  if (!recording) return;
  const enrollment = await enrollmentFor(client, { ...input, enrollmentId: recording.enrollment_id }, true);
  if (!enrollment) return;
  const unit = allUnits(enrollment).find(item => item.id === recording.unit_id);
  if (!unit) throw new Error('Unidade ausente da versão matriculada.');
  await completeUnit(client, enrollment, unit, input.evaluationId);
}
