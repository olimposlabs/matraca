import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CourseError, courseEditorTarget, schoolCourseScope } from './courses.js';

const coursePath = z.object({ id: z.uuid() }).passthrough();
const assignableQuery = z.object({
  kind: z.enum(['student', 'class']),
  search: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const candidateQueries = {
  student: `SELECT id,name,email AS detail FROM users
    WHERE org_id=$1 AND 'student'=ANY(roles) AND status IN ('active','invited') AND archived_at IS NULL
      AND (strpos(lower(name),lower($2))>0 OR strpos(lower(email),lower($2))>0)
      AND ($3::uuid[] IS NULL OR EXISTS(SELECT 1 FROM student_schools ss
        WHERE ss.org_id=users.org_id AND ss.student_id=users.id AND ss.ended_at IS NULL AND ss.school_id=ANY($3::uuid[])))`,
  class: `SELECT c.id,c.name,s.name AS detail FROM classes c JOIN schools s ON s.id=c.school_id AND s.org_id=c.org_id
    WHERE c.org_id=$1 AND c.status='active' AND s.status='active'
      AND (strpos(lower(c.name),lower($2))>0 OR strpos(lower(s.name),lower($2))>0)
      AND ($3::uuid[] IS NULL OR c.school_id=ANY($3::uuid[]))`,
} as const;

export async function registerCourseManagementReads(app: FastifyInstance) {
  for (const mode of ['manage', 'central', 'school'] as const) {
    const central = mode === 'central';
    const base = central ? '/api/backoffice/courses/:orgId' : `/api/courses/${mode}`;
    if (mode !== 'school') app.get(`${base}/:id/assets`, async request => {
      const { orgId } = await courseEditorTarget(request, central);
      const params = coursePath.safeParse(request.params);
      if (!params.success) throw new CourseError(400, 'Identificador do curso inválido.');
      const courseId = params.data.id;
      const course = await app.db.query('SELECT id FROM courses WHERE id=$1 AND org_id=$2', [courseId, orgId]);
      if (!course.rowCount) throw new CourseError(404, 'Curso não encontrado.');
      const assets = await app.db.query<{ id: string; filename: string; mimeType: string; size: string }>(
        `SELECT id,filename,mime_type AS "mimeType",byte_length AS size
         FROM course_assets WHERE course_id=$1 AND org_id=$2 ORDER BY created_at DESC,id`, [courseId, orgId],
      );
      return { assets: assets.rows.map(asset => ({ ...asset, size: Number(asset.size) })) };
    });
    app.get(`${base}/:id/assignable`, async request => {
      const { orgId, schoolIds } = mode === 'school'
        ? await schoolCourseScope(request)
        : { ...await courseEditorTarget(request, central), schoolIds: null };
      const params = coursePath.safeParse(request.params);
      const query = assignableQuery.safeParse(request.query);
      if (!params.success || !query.success) throw new CourseError(400, 'Confira os filtros da atribuição.');
      const course = await app.db.query("SELECT id FROM courses WHERE id=$1 AND org_id=$2 AND ($3=false OR status='published')", [params.data.id, orgId, mode === 'school']);
      if (!course.rowCount) throw new CourseError(404, 'Curso não encontrado.');
      const { kind, search, page, pageSize } = query.data;
      const selection = candidateQueries[kind];
      return app.db.transaction(async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const count = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM (${selection}) candidates`, [orgId, search, schoolIds]);
        const items = await client.query(
          `SELECT id,name,detail FROM (${selection}) candidates ORDER BY lower(name),id LIMIT $4 OFFSET $5`,
          [orgId, search, schoolIds, pageSize, (page - 1) * pageSize],
        );
        return { items: items.rows, total: count.rows[0].count, page, pageSize };
      });
    });
  }
}
