import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireIdentity,type AuthIdentity,type IdentityRole } from './auth.js';
import { localHostname } from './config.js';
import { courseDocumentSchema,emptyCourse,validatePublication,type CourseDocument } from './course-model.js';
import { assertStudentScope,managedSchoolIds } from './permissions.js';

export class CourseError extends Error {constructor(public readonly statusCode:400|401|403|404|409,message:string){super(message);}}
const uuid=z.uuid();
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new CourseError(400,'Confira os campos e os limites do curso.');return result.data;}
interface CourseRow {id:string;org_id:string;title:string;status:string;draft_revision:number;draft:CourseDocument}
interface VersionRow {id:string;course_id:string;org_id:string;version:number;document:CourseDocument}
const revision=z.object({expectedRevision:z.number().int().min(0)}).strict();
async function revalidate(client:PoolClient,request:FastifyRequest,actor:AuthIdentity,role:IdentityRole=actor.org.kind==='backoffice'?'operator':'org_admin'){
 const current=await client.query<{roles:string[]}>(`SELECT u.roles FROM sessions s JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id JOIN orgs o ON o.id=s.org_id JOIN domains d ON d.hostname=s.hostname AND d.org_id=s.org_id WHERE s.token_hash=$1 AND s.hostname=$2 AND s.org_id=$3 AND s.user_id=$4 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='active' AND u.archived_at IS NULL AND o.status='active' FOR SHARE OF u,o`,[createHash('sha256').update(request.cookies.matraca_session??'').digest('hex'),localHostname(request.headers.host),actor.org.id,actor.user.id]);
 if(!current.rows[0])throw new CourseError(401,'Seu acesso foi encerrado.');
 if(!current.rows[0].roles.includes(role))throw new CourseError(403,'Seu perfil atual não pode executar esta operação de curso.');
}
async function target(request:FastifyRequest,central:boolean){
 const actor=await requireIdentity(request,central?['operator']:['org_admin']);
 if(central&&actor.org.kind!=='backoffice')throw new CourseError(403,'Acesso exclusivo do backoffice.');
 const orgId=central?parse(z.object({orgId:uuid}).passthrough(),request.params).orgId:actor.org.id;
 const found=await request.server.db.query<{settings:Record<string,unknown>}>('SELECT settings FROM orgs WHERE id=$1 AND kind<>\'backoffice\' AND status=\'active\'',[orgId]);
 if(!found.rows[0])throw new CourseError(404,'Organização não encontrada.');
 return {actor,orgId};
}
async function mutation<T>(request:FastifyRequest,central:boolean,fn:(client:PoolClient,orgId:string,actor:AuthIdentity)=>Promise<T>){
 const {actor,orgId}=await target(request,central);
 return request.server.db.transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))',[orgId]);
  await revalidate(client,request,actor);
  if(!(await client.query("SELECT id FROM orgs WHERE id=$1 AND status='active' AND kind<>'backoffice' FOR SHARE",[orgId])).rowCount)throw new CourseError(404,'Organização não encontrada.');
  return fn(client,orgId,actor);
 });
}
async function course(client:PoolClient,orgId:string,id:string){const row=(await client.query<CourseRow>('SELECT * FROM courses WHERE id=$1 AND org_id=$2 FOR UPDATE',[id,orgId])).rows[0];if(!row)throw new CourseError(404,'Curso não encontrado.');return row;}
function courseId(request:FastifyRequest){return parse(z.object({id:uuid}).passthrough(),request.params).id;}
async function publish(client:PoolClient,orgId:string,id:string,expectedRevision:number,actorId:string|null){
 const row=await course(client,orgId,id);if(row.draft_revision!==expectedRevision)throw new CourseError(409,'O rascunho mudou. Recarregue antes de publicar.');
 const issues=validatePublication(row.draft);if(issues.length)throw new CourseError(400,issues.join(' '));
 const assets=row.draft.modules.flatMap(module=>module.units.flatMap(unit=>unit.assetIds));
 if(assets.length){const owned=await client.query('SELECT id FROM course_assets WHERE org_id=$1 AND course_id=$2 AND id=ANY($3::uuid[])',[orgId,id,assets]);if(owned.rowCount!==new Set(assets).size)throw new CourseError(400,'Há um anexo que não pertence a este curso.');}
 const previous=(await client.query<VersionRow>('SELECT * FROM course_versions WHERE course_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];
 if(previous&&JSON.stringify(previous.document)===JSON.stringify(row.draft)){
  await client.query("UPDATE courses SET status='published',updated_at=now() WHERE id=$1",[id]);
  return previous;
 }
 const result=await client.query<VersionRow>('INSERT INTO course_versions(org_id,course_id,version,document,published_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[orgId,id,(previous?.version??0)+1,row.draft,actorId]);
 await client.query("UPDATE courses SET status='published',updated_at=now() WHERE id=$1",[id]);return result.rows[0];
}
export { publish as publishCourseInTransaction, mutation as courseMutation, target as courseEditorTarget };
export async function enrollAssignedCourses(client:PoolClient,orgId:string,classId:string,studentId:string){
 const assignments=await client.query<{id:string;course_id:string;version_id:string}>(`SELECT DISTINCT ON(a.course_id) a.id,a.course_id,a.version_id
  FROM course_assignments a JOIN course_versions v ON v.id=a.version_id AND v.org_id=a.org_id
  JOIN courses c ON c.id=a.course_id AND c.org_id=a.org_id
  WHERE a.org_id=$1 AND a.class_id=$2 AND c.status='published'
  ORDER BY a.course_id,v.version DESC,a.created_at DESC,a.id`,[orgId,classId]);
 for(const item of assignments.rows)await client.query("INSERT INTO course_enrollments(org_id,course_id,version_id,student_id,source,source_ref) VALUES($1,$2,$3,$4,'assignment',$5) ON CONFLICT(course_id,student_id) DO NOTHING",[orgId,item.course_id,item.version_id,studentId,item.id]);
}
const assignmentInput = z.object({
  versionId: uuid, studentId: uuid.optional(), classId: uuid.optional(),
}).strict().refine(input => Boolean(input.studentId) !== Boolean(input.classId));
type AssignmentInput = z.infer<typeof assignmentInput>;

export async function schoolCourseScope(request: FastifyRequest) {
  const actor = await requireIdentity(request, ['school']);
  const schoolIds = await managedSchoolIds(request.server.db, { ...actor, user: { ...actor.user, roles: ['school'] } });
  if (!schoolIds.length) throw new CourseError(403, 'Você não administra uma escola ativa.');
  return { orgId: actor.org.id, schoolIds };
}

async function assignCourse(client: PoolClient, orgId: string, actorId: string, id: string, input: AssignmentInput, schoolIds: string[] | null = null) {
  const item = await course(client, orgId, id);
  if (item.status !== 'published') throw new CourseError(409, 'Publique o curso antes de atribuir.');
  const version = await client.query('SELECT id FROM course_versions WHERE id=$1 AND course_id=$2 AND org_id=$3', [input.versionId, id, orgId]);
  if (!version.rowCount) throw new CourseError(404, 'Versão não encontrada.');
  let students: string[] = [];
  if (input.studentId) {
    const student = await client.query(
      `SELECT u.id FROM users u WHERE u.id=$1 AND u.org_id=$2 AND 'student'=ANY(u.roles)
         AND u.status IN ('active','invited') AND u.archived_at IS NULL
         AND ($3::uuid[] IS NULL OR EXISTS(SELECT 1 FROM student_schools ss
           WHERE ss.org_id=u.org_id AND ss.student_id=u.id AND ss.ended_at IS NULL AND ss.school_id=ANY($3::uuid[])))`,
      [input.studentId, orgId, schoolIds],
    );
    if (!student.rowCount) throw new CourseError(404, 'Aluno não encontrado no seu escopo.');
    students = [input.studentId];
  }
  if (input.classId) {
    const assignedClass = await client.query(
      `SELECT c.id FROM classes c JOIN schools s ON s.id=c.school_id AND s.org_id=c.org_id
       WHERE c.id=$1 AND c.org_id=$2 AND c.status='active' AND s.status='active'
         AND ($3::uuid[] IS NULL OR c.school_id=ANY($3::uuid[]))`, [input.classId, orgId, schoolIds],
    );
    if (!assignedClass.rowCount) throw new CourseError(404, 'Turma ativa não encontrada no seu escopo.');
    const enrolled = await client.query<{ student_id: string }>(
      `SELECT e.student_id FROM enrollments e JOIN users u ON u.id=e.student_id AND u.org_id=e.org_id
       WHERE e.class_id=$1 AND e.org_id=$2 AND e.status='active' AND 'student'=ANY(u.roles)
         AND u.status IN ('active','invited') AND u.archived_at IS NULL`, [input.classId, orgId],
    );
    students = enrolled.rows.map(row => row.student_id);
  }
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM course_assignments WHERE version_id=$1 AND (student_id=$2 OR class_id=$3)',
    [input.versionId, input.studentId ?? null, input.classId ?? null],
  );
  const assignmentId = existing.rows[0]?.id ?? randomUUID();
  if (!existing.rowCount) await client.query(
    'INSERT INTO course_assignments(id,org_id,course_id,version_id,class_id,student_id,assigned_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [assignmentId, orgId, id, input.versionId, input.classId ?? null, input.studentId ?? null, actorId],
  );
  const enrolled = await client.query(
    `INSERT INTO course_enrollments(org_id,course_id,version_id,student_id,source,source_ref)
     SELECT $1,$2,$3,student,'assignment',$4 FROM unnest($5::uuid[]) student
     ON CONFLICT(course_id,student_id) DO NOTHING`, [orgId, id, input.versionId, assignmentId, students],
  );
  return { assignmentId, enrolled: enrolled.rowCount ?? 0 };
}

export async function registerCourses(app:FastifyInstance){
 for(const central of [false,true]){
  const base=central?'/api/backoffice/courses/:orgId':'/api/courses/manage';
  app.get(base,async request=>{const {orgId}=await target(request,central);const result=await app.db.query('SELECT c.id,c.title,c.status,c.draft_revision AS revision,(SELECT max(version) FROM course_versions v WHERE v.course_id=c.id) AS "publishedVersion" FROM courses c WHERE c.org_id=$1 ORDER BY c.updated_at DESC',[orgId]);return {courses:result.rows};});
  app.post(base,async(request,reply)=>{
   const input=parse(z.object({title:z.string().trim().min(1).max(160),copyBaseCourseId:uuid.optional()}).strict(),request.body);
   const copiedKeys:string[]=[];
   try{const result=await mutation(request,central,async(client,orgId,actor)=>{
    let document=emptyCourse(input.title);let sourceId:string|null=null;
    if(input.copyBaseCourseId){const source=(await client.query<VersionRow>("SELECT v.* FROM course_versions v JOIN courses c ON c.id=v.course_id JOIN orgs o ON o.id=c.org_id WHERE c.id=$1 AND o.kind='matraca' AND c.status='published' ORDER BY v.version DESC LIMIT 1",[input.copyBaseCourseId])).rows[0];if(!source)throw new CourseError(404,'Curso base publicado não encontrado.');document={...source.document,title:input.title,catalogVisible:false};sourceId=source.course_id;}
    const created=(await client.query<CourseRow>('INSERT INTO courses(org_id,title,draft,source_course_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[orgId,input.title,document,sourceId,actor.user.id])).rows[0];
    if(sourceId){
     const assetIds=[...new Set(document.modules.flatMap(module=>module.units.flatMap(unit=>unit.assetIds)))];
     const assets=await client.query<{id:string;object_key:string;filename:string;mime_type:string;byte_length:string}>('SELECT id,object_key,filename,mime_type,byte_length FROM course_assets WHERE course_id=$1 AND id=ANY($2::uuid[])',[sourceId,assetIds]);
     if(assets.rows.length!==assetIds.length)throw new CourseError(409,'Um anexo da base não está disponível.');
     const mapping=new Map<string,string>();
     for(const asset of assets.rows){const id=randomUUID();const key=`course-assets/${orgId}/${id}`;copiedKeys.push(key);await app.storage.put(key,app.storage.read(asset.object_key));await client.query('INSERT INTO course_assets(id,org_id,course_id,object_key,filename,mime_type,byte_length,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,orgId,created.id,key,asset.filename,asset.mime_type,asset.byte_length,actor.user.id]);mapping.set(asset.id,id);}
     document={...document,modules:document.modules.map(module=>({...module,units:module.units.map(unit=>({...unit,assetIds:unit.assetIds.map(id=>mapping.get(id)!)}))}))};
     await client.query('UPDATE courses SET draft=$2 WHERE id=$1',[created.id,document]);created.draft=document;
    }
    return {course:created};
   });return reply.code(201).send(result);}catch(error){await Promise.all(copiedKeys.map(key=>app.storage.remove(key).catch(()=>{})));throw error;}
  });
  app.get(`${base}/:id`,async request=>{const {orgId}=await target(request,central);const found=(await app.db.query<CourseRow>('SELECT * FROM courses WHERE id=$1 AND org_id=$2',[courseId(request),orgId])).rows[0];if(!found)throw new CourseError(404,'Curso não encontrado.');const versions=await app.db.query('SELECT id,version,published_at FROM course_versions WHERE course_id=$1 AND org_id=$2 ORDER BY version DESC',[found.id,orgId]);return {course:found,versions:versions.rows};});
  app.put(`${base}/:id`,async request=>{
   const input=parse(z.object({expectedRevision:z.number().int().min(0),document:courseDocumentSchema}).strict(),request.body);
   return mutation(request,central,async(client,orgId)=>{const item=await course(client,orgId,courseId(request));if(item.draft_revision!==input.expectedRevision)throw new CourseError(409,'Outra edição foi salva. Recarregue antes de continuar.');const updated=await client.query<CourseRow>('UPDATE courses SET title=$2,draft=$3,draft_revision=draft_revision+1,updated_at=now() WHERE id=$1 RETURNING *',[item.id,input.document.title,input.document]);return {course:updated.rows[0]};});
  });
  app.post(`${base}/:id/publish`,async request=>{const input=parse(revision,request.body);return mutation(request,central,async(client,orgId,actor)=>({version:await publish(client,orgId,courseId(request),input.expectedRevision,actor.user.id)}));});
  app.post(`${base}/:id/archive`,async request=>mutation(request,central,async(client,orgId)=>{const item=await course(client,orgId,courseId(request));await client.query("UPDATE courses SET status='archived',updated_at=now() WHERE id=$1",[item.id]);return {archived:true};}));
  app.post(`${base}/:id/assign`, async request => {
    const input = parse(assignmentInput, request.body);
    return mutation(request, central, (client, orgId, actor) => assignCourse(client, orgId, actor.user.id, courseId(request), input));
  });
 }
 app.get('/api/courses/school', async request => {
  const { orgId } = await schoolCourseScope(request);
  const result = await app.db.query(
    `SELECT c.id,c.title,c.status,(SELECT max(version) FROM course_versions v WHERE v.course_id=c.id) AS "publishedVersion"
     FROM courses c WHERE c.org_id=$1 AND c.status='published' ORDER BY lower(c.title),c.id`, [orgId],
  );
  return { courses: result.rows };
 });
 app.get('/api/courses/school/:id', async request => {
  const { orgId } = await schoolCourseScope(request);
  const id = courseId(request);
  const course = await app.db.query("SELECT id,title,status FROM courses WHERE id=$1 AND org_id=$2 AND status='published'", [id, orgId]);
  if (!course.rowCount) throw new CourseError(404, 'Curso publicado não encontrado.');
  const versions = await app.db.query('SELECT id,version,published_at FROM course_versions WHERE course_id=$1 AND org_id=$2 ORDER BY version DESC', [id, orgId]);
  return { course: course.rows[0], versions: versions.rows };
 });
 app.post('/api/courses/school/:id/assign', async request => {
  const input = parse(assignmentInput, request.body);
  const actor = await requireIdentity(request, ['school']);
  const orgId = actor.org.id;
  return app.db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [orgId]);
    await revalidate(client, request, actor, 'school');
    const schoolIds = await managedSchoolIds(client, { ...actor, user: { ...actor.user, roles: ['school'] } });
    if (!schoolIds.length) throw new CourseError(403, 'Você não administra uma escola ativa.');
    return assignCourse(client, orgId, actor.user.id, courseId(request), input, schoolIds);
  });
 });
 app.get('/api/courses/base',async request=>{await requireIdentity(request,['org_admin','operator']);return {courses:(await app.db.query("SELECT c.id,c.title FROM courses c JOIN orgs o ON o.id=c.org_id WHERE o.kind='matraca' AND c.status='published' ORDER BY c.title")).rows};});
 app.get('/api/courses',async request=>{
  const actor=await requireIdentity(request,['student']);if(actor.org.settings.coursesEnabled===false)return {enabled:false,courses:[]};
  const rows=await app.db.query('SELECT e.id AS "enrollmentId",e.course_id AS id,e.status,v.version,v.document->>\'title\' AS title,v.document->>\'description\' AS description FROM course_enrollments e JOIN course_versions v ON v.id=e.version_id AND v.org_id=e.org_id WHERE e.org_id=$1 AND e.student_id=$2 AND e.status<>\'cancelled\' ORDER BY e.created_at',[actor.org.id,actor.user.id]);return {enabled:true,courses:rows.rows};
 });
 app.get('/api/courses/:id',async request=>{
  const actor=await requireIdentity(request,['student']);if(actor.org.settings.coursesEnabled===false)throw new CourseError(403,'Os cursos estão desativados nesta organização.');
  const id=courseId(request);
  const found=(await app.db.query('SELECT e.id AS "enrollmentId",e.status,v.id AS "versionId",v.version,v.document FROM course_enrollments e JOIN course_versions v ON v.id=e.version_id AND v.org_id=e.org_id WHERE e.org_id=$1 AND e.student_id=$2 AND e.course_id=$3 AND e.status<>\'cancelled\'',[actor.org.id,actor.user.id,id])).rows[0];if(!found)throw new CourseError(404,'Curso não encontrado na sua jornada.');
  const assetIds=[...new Set((found.document as CourseDocument).modules.flatMap(module=>module.units.flatMap(unit=>unit.assetIds)))];
  const assets=await app.db.query('SELECT id,filename,mime_type AS "mimeType",byte_length::integer AS size FROM course_assets WHERE org_id=$1 AND course_id=$2 AND id=ANY($3::uuid[]) ORDER BY filename,id',[actor.org.id,id,assetIds]);
  return {...found,assets:assets.rows};
 });
 app.get('/api/courses/students/:studentId',async request=>{const actor=await requireIdentity(request,['org_admin','school','teacher','student']);const studentId=parse(z.object({studentId:uuid}),request.params).studentId;await assertStudentScope(app.db,actor,studentId);return {courses:(await app.db.query('SELECT e.id,e.course_id,e.status,v.version,v.document->>\'title\' AS title FROM course_enrollments e JOIN course_versions v ON v.id=e.version_id WHERE e.org_id=$1 AND e.student_id=$2',[actor.org.id,studentId])).rows};});
}
