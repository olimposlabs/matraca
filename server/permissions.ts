import type { FastifyRequest } from 'fastify';
import type { QueryResult, QueryResultRow } from 'pg';
import { requireIdentity, type AuthIdentity } from './auth.js';

export interface EducationQuery {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
}
export class EducationError extends Error {
  constructor(public readonly statusCode: 400 | 401 | 403 | 404 | 409, message: string) {
    super(message); this.name = 'EducationError';
  }
}
export const isOrgAdmin = (actor: AuthIdentity) => actor.user.roles.includes('org_admin');
export const scopeValues = (actor: AuthIdentity) => [actor.org.id, actor.user.id, actor.user.roles];

// These predicates use only server-owned SQL aliases and parameters:
// $1 org, $2 actor user and $3 actor roles. They never interpolate request data.
export const STUDENT_SCOPE_SQL = `(
  'org_admin'=ANY($3::text[]) OR u.id=$2 OR EXISTS (
    SELECT 1 FROM student_schools ss JOIN schools sc ON sc.id=ss.school_id AND sc.org_id=ss.org_id
    WHERE ss.org_id=$1 AND ss.student_id=u.id AND ss.ended_at IS NULL AND sc.status='active' AND (
      ('school'=ANY($3::text[]) AND EXISTS (SELECT 1 FROM school_staff st WHERE st.org_id=$1
        AND st.school_id=ss.school_id AND st.user_id=$2 AND st.role='school' AND st.ended_at IS NULL))
      OR ('teacher'=ANY($3::text[]) AND EXISTS (
        SELECT 1 FROM enrollments e JOIN classes c ON c.id=e.class_id AND c.org_id=e.org_id
        JOIN teacher_class_assignments a ON a.class_id=c.id AND a.org_id=c.org_id
        JOIN teacher_profiles p ON p.user_id=a.teacher_id AND p.org_id=a.org_id
        JOIN school_staff st ON st.org_id=a.org_id AND st.school_id=c.school_id AND st.user_id=a.teacher_id
        WHERE e.org_id=$1 AND e.student_id=u.id AND e.school_id=ss.school_id AND e.status='active'
          AND c.status='active' AND a.teacher_id=$2 AND a.ended_at IS NULL
          AND p.approval_status='approved' AND st.role='teacher' AND st.ended_at IS NULL
      ))
    )
  )
)`;
export const PERSON_SCOPE_SQL = `(
  'org_admin'=ANY($3::text[]) OR u.id=$2 OR ('student'=ANY(u.roles) AND ${STUDENT_SCOPE_SQL})
  OR ('school'=ANY($3::text[]) AND NOT(u.roles && ARRAY['org_admin','operator']::text[]) AND EXISTS (
    SELECT 1 FROM school_staff target JOIN school_staff manager
      ON manager.school_id=target.school_id AND manager.org_id=target.org_id
    JOIN schools sc ON sc.id=target.school_id AND sc.org_id=target.org_id
    WHERE target.org_id=$1 AND target.user_id=u.id AND target.ended_at IS NULL
      AND manager.user_id=$2 AND manager.role='school' AND manager.ended_at IS NULL AND sc.status='active'
  ))
)`;

export async function educationIdentity(request: FastifyRequest): Promise<AuthIdentity> {
  return requireIdentity(request, ['org_admin', 'school', 'teacher', 'student']);
}
export async function requireStudentScope(request: FastifyRequest, studentId: string): Promise<AuthIdentity> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(studentId)) {
    throw new EducationError(400, 'Identificador de aluno inválido.');
  }
  const actor = await educationIdentity(request);
  await assertStudentScope(request.server.db, actor, studentId);
  return actor;
}
export async function assertStudentScope(client: EducationQuery, actor: AuthIdentity, studentId: string): Promise<void> {
  const target = await client.query('SELECT id FROM users WHERE id=$1 AND org_id=$2 AND \'student\'=ANY(roles)', [studentId, actor.org.id]);
  if (!target.rowCount) throw new EducationError(404, 'Aluno não encontrado.');
  const result = await client.query(`SELECT u.id FROM users u WHERE u.org_id=$1 AND u.id=$4 AND ${STUDENT_SCOPE_SQL}`,
    [...scopeValues(actor), studentId]);
  if (!result.rowCount) throw new EducationError(403, 'Você não tem acesso a este aluno.');
}
export async function assertSchoolScope(client: EducationQuery, actor: AuthIdentity, schoolId: string, active = true): Promise<void> {
  const school = await client.query<{ status: string }>('SELECT status FROM schools WHERE id=$1 AND org_id=$2', [schoolId, actor.org.id]);
  if (!school.rows[0]) throw new EducationError(404, 'Escola não encontrada.');
  if (!isOrgAdmin(actor)) {
    const allowed = actor.user.roles.includes('school') && (await client.query(
      `SELECT id FROM school_staff WHERE org_id=$1 AND school_id=$2 AND user_id=$3 AND role='school' AND ended_at IS NULL`,
      [actor.org.id, schoolId, actor.user.id],
    )).rowCount;
    if (!allowed || school.rows[0].status !== 'active') throw new EducationError(403, 'Você não administra esta escola.');
  }
  if (active && school.rows[0].status !== 'active') throw new EducationError(409, 'A escola está arquivada.');
}
export async function managedSchoolIds(client: EducationQuery, actor: AuthIdentity): Promise<string[]> {
  const result = isOrgAdmin(actor)
    ? await client.query<{ id: string }>('SELECT id FROM schools WHERE org_id=$1', [actor.org.id])
    : await client.query<{ id: string }>(`SELECT DISTINCT s.id FROM schools s JOIN school_staff st
        ON st.school_id=s.id AND st.org_id=s.org_id WHERE s.org_id=$1 AND s.status='active'
        AND st.user_id=$2 AND st.role='school' AND st.ended_at IS NULL AND 'school'=ANY($3::text[])`, scopeValues(actor));
  return result.rows.map((row) => row.id);
}
