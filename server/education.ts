import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthIdentity, IdentityRole } from './auth.js';
import { localHostname } from './config.js';
import { EducationError, educationIdentity, assertSchoolScope, assertStudentScope, isOrgAdmin,
  managedSchoolIds, PERSON_SCOPE_SQL, STUDENT_SCOPE_SQL, scopeValues, type EducationQuery } from './permissions.js';
export { requireStudentScope } from './permissions.js';

const id = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[<>]/.test(s));
const roles = z.array(z.enum(['student','teacher','school','org_admin'])).min(1).max(4)
  .refine((items) => new Set(items).size === items.length);
const schoolInput = z.object({ name: text(160), city: z.string().trim().max(120).default(''), state: z.string().trim().max(80).default('') }).strict();
const schoolPatch = z.object({ name: text(160).optional(), city: z.string().trim().max(120).optional(), state: z.string().trim().max(80).optional(), status: z.enum(['active','archived']).optional() }).strict();
const personInput = z.object({ name: text(120), email: z.string().trim().max(254).email().transform((s) => s.toLowerCase()), roles, schoolId: id.optional() }).strict();
const personPatch = z.object({ name: text(120).optional(), status: z.enum(['invited','active','suspended']).optional(), roles: roles.optional(), profile: z.record(z.string(),z.unknown()).optional() }).strict();
const dates = { startsOn: z.iso.date().nullable().optional(), endsOn: z.iso.date().nullable().optional() };
const classInput = z.object({ schoolId: id, name: text(160), ...dates }).strict();
const classPatch = z.object({ name: text(160).optional(), ...dates, status: z.enum(['active','closed','archived']).optional() }).strict();
const certification = z.object({ name: text(160), issuer: text(160), issuedOn: z.iso.date().optional(), expiresOn: z.iso.date().optional() }).strict()
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn);
const approvalInput = z.object({ approvalStatus: z.enum(['pending','approved','suspended']), certifications: z.array(certification).max(30).optional() }).strict();
const typeInput = z.object({ name: text(100), position: z.number().int().min(0).max(10000).default(0) }).strict();
const typePatch = z.object({ name: text(100).optional(), position: z.number().int().min(0).max(10000).optional(), status: z.enum(['active','archived']).optional() }).strict();
const groupInput = z.object({ name: text(160), typeId: id, parentId: id.nullable().optional(), schoolId: id.nullable().optional() }).strict();
const groupPatch = z.object({ name: text(160).optional(), typeId: id.optional(), parentId: id.nullable().optional(), status: z.enum(['active','archived']).optional() }).strict();
const querySchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), search: z.string().trim().max(160).default(''), status: z.string().max(20).optional(), schoolId: id.optional(), role: z.enum(['student','teacher','school','org_admin']).optional() }).strict();

export interface School { id: string; name: string; city: string; state: string; status: 'active'|'archived' }
export interface Person { id: string; name: string; email: string; roles: IdentityRole[]; status: string; profile: Record<string,unknown>; archivedAt: Date|null; schoolId: string|null; schoolIds: string[]; teacherProfile: { approvalStatus: string; certifications: unknown[] }|null }
export interface SchoolClass { id: string; schoolId: string; name: string; status: 'active'|'closed'|'archived'; startsOn: string|null; endsOn: string|null }
export interface EducationGroup { id: string; typeId: string; parentId: string|null; schoolId: string|null; name: string; status: 'active'|'archived' }
export interface GroupType { id: string; name: string; position: number; status: string }

const personSelect = `SELECT u.id,u.name,u.email,u.roles,u.status,u.profile,u.archived_at AS "archivedAt",
  (SELECT ss.school_id FROM student_schools ss WHERE ss.org_id=u.org_id AND ss.student_id=u.id AND ss.ended_at IS NULL) AS "schoolId",
  ARRAY(SELECT DISTINCT st.school_id FROM school_staff st WHERE st.org_id=u.org_id AND st.user_id=u.id AND st.ended_at IS NULL) AS "schoolIds",
  (SELECT jsonb_build_object('approvalStatus',tp.approval_status,'certifications',tp.certifications)
   FROM teacher_profiles tp WHERE tp.org_id=u.org_id AND tp.user_id=u.id) AS "teacherProfile" FROM users u`;
const classSelect = `SELECT c.id,c.school_id AS "schoolId",c.name,c.status,c.starts_on::text AS "startsOn",c.ends_on::text AS "endsOn" FROM classes c`;
const groupSelect = `SELECT g.id,g.type_id AS "typeId",g.parent_id AS "parentId",g.school_id AS "schoolId",g.name,g.status FROM education_groups g`;
const classScope = `('org_admin'=ANY($3::text[]) OR c.school_id=ANY($4::uuid[]) OR
  ('teacher'=ANY($3::text[]) AND c.status='active' AND EXISTS (
    SELECT 1 FROM teacher_class_assignments a JOIN teacher_profiles p ON p.user_id=a.teacher_id AND p.org_id=a.org_id
    JOIN school_staff st ON st.org_id=a.org_id AND st.school_id=a.school_id AND st.user_id=a.teacher_id
    JOIN schools sc ON sc.id=a.school_id AND sc.org_id=a.org_id
    WHERE a.org_id=$1 AND a.class_id=c.id AND a.teacher_id=$2 AND a.ended_at IS NULL
      AND p.approval_status='approved' AND st.role='teacher' AND st.ended_at IS NULL AND sc.status='active')) OR
  ('student'=ANY($3::text[]) AND EXISTS(SELECT 1 FROM enrollments e WHERE e.org_id=$1 AND e.class_id=c.id AND e.student_id=$2)))`;

export async function registerEducation(app: FastifyInstance): Promise<void> {
  const base = '/api/education';
  app.get(`${base}/overview`, async (request) => {
    const actor = await educationIdentity(request);
    const managed = await managedSchoolIds(app.db,actor);
    const approval = (await app.db.query<{ approval_status: string }>('SELECT approval_status FROM teacher_profiles WHERE org_id=$1 AND user_id=$2',[actor.org.id,actor.user.id])).rows[0]?.approval_status ?? null;
    const query = { page:1,pageSize:100,search:'' };
    const [schools,people,classes,groupTypes,groups] = await Promise.all([
      list(app.db,actor,'schools',query),list(app.db,actor,'people',query),list(app.db,actor,'classes',query),list(app.db,actor,'group-types',query),list(app.db,actor,'groups',query),
    ]);
    return { schools:schools.items,people:people.items,classes:classes.items,groupTypes:groupTypes.items,groups:groups.items,
      capabilities:{ manageSchools:isOrgAdmin(actor),managePeople:isOrgAdmin(actor)||managed.length>0,approveTeachers:isOrgAdmin(actor),transferStudents:isOrgAdmin(actor),manageGroups:isOrgAdmin(actor)||managed.length>0,teacherApprovalStatus:approval },scope:{schoolIds:managed} };
  });
  for (const resource of ['schools','people','classes','group-types','groups'] as const) {
    app.get(`${base}/${resource}`, async (request) => list(app.db,await educationIdentity(request),resource,parse(querySchema,request.query)));
  }

  app.post(`${base}/schools`, async (request,reply) => {
    const data=parse(schoolInput,request.body);
    const result=await mutate(app,request,async(client,actor)=>{
      admin(actor); const row=(await client.query<School>('INSERT INTO schools(org_id,name,city,state) VALUES($1,$2,$3,$4) RETURNING id,name,city,state,status',[actor.org.id,data.name,data.city,data.state])).rows[0];
      await audit(client,actor,'school_created',row.id); return {school:row};
    }); return reply.code(201).send(result);
  });
  app.get(`${base}/schools/:id`, async(request)=>{
    const actor=await educationIdentity(request), schoolId=param(request);
    await assertSchoolScope(app.db,actor,schoolId,false);
    const school=await getSchool(app.db,actor,schoolId);
    const staff=await app.db.query(`SELECT st.id,st.user_id AS "userId",u.name,u.email,st.role,st.ended_at AS "endedAt" FROM school_staff st JOIN users u ON u.id=st.user_id AND u.org_id=st.org_id WHERE st.org_id=$1 AND st.school_id=$2 ORDER BY st.started_at DESC`,[actor.org.id,schoolId]);
    return {school,staff:staff.rows};
  });
  app.patch(`${base}/schools/:id`,async(request)=>mutate(app,request,async(client,actor)=>{
    admin(actor); const schoolId=param(request), data=patch(schoolPatch,request.body), old=await getSchool(client,actor,schoolId);
    const school=(await client.query<School>('UPDATE schools SET name=$3,city=$4,state=$5,status=$6,updated_at=now() WHERE org_id=$1 AND id=$2 RETURNING id,name,city,state,status',[actor.org.id,schoolId,data.name??old.name,data.city??old.city,data.state??old.state,data.status??old.status])).rows[0];
    if(data.status==='archived') {
      await client.query("UPDATE classes SET status='archived',updated_at=now() WHERE org_id=$1 AND school_id=$2",[actor.org.id,schoolId]);
      await client.query("UPDATE enrollments SET status='cancelled',ended_at=now() WHERE org_id=$1 AND school_id=$2 AND status='active'",[actor.org.id,schoolId]);
      await client.query('UPDATE teacher_class_assignments SET ended_at=now() WHERE org_id=$1 AND school_id=$2 AND ended_at IS NULL',[actor.org.id,schoolId]);
      await client.query('UPDATE school_staff SET ended_at=now() WHERE org_id=$1 AND school_id=$2 AND ended_at IS NULL',[actor.org.id,schoolId]);
      await client.query("UPDATE education_groups SET status='archived',updated_at=now() WHERE org_id=$1 AND school_id=$2",[actor.org.id,schoolId]);
      await client.query('UPDATE group_memberships SET ended_at=now() WHERE org_id=$1 AND ended_at IS NULL AND group_id IN(SELECT id FROM education_groups WHERE org_id=$1 AND school_id=$2)',[actor.org.id,schoolId]);
    }
    await audit(client,actor,'school_updated',schoolId); return {school};
  }));
  app.post(`${base}/schools/:id/staff`,async(request,reply)=>{
    const data=parse(z.object({userId:id,role:z.enum(['school','teacher'])}).strict(),request.body);
    const result=await mutate(app,request,async(client,actor)=>{
      admin(actor);const schoolId=param(request); await assertSchoolScope(client,actor,schoolId);
      const user=await getPerson(client,actor,data.userId); live(user);
      if(!user.roles.includes(data.role)) throw new EducationError(409,'O usuário não possui este papel.');
      const staff=(await client.query('INSERT INTO school_staff(org_id,school_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,school_id,user_id,role) WHERE ended_at IS NULL DO UPDATE SET role=EXCLUDED.role RETURNING id,user_id AS "userId",role,ended_at AS "endedAt"',[actor.org.id,schoolId,data.userId,data.role])).rows[0];
      await audit(client,actor,'staff_assigned',data.userId);return {staff};
    });return reply.code(201).send(result);
  });
  app.delete(`${base}/schools/:id/staff/:userId`,async(request,reply)=>{
    const params=parse(z.object({id,userId:id}).strict(),request.params);
    await mutate(app,request,async(client,actor)=>{
      await assertSchoolScope(client,actor,params.id,false);
      if(!isOrgAdmin(actor) && (await client.query("SELECT id FROM school_staff WHERE org_id=$1 AND school_id=$2 AND user_id=$3 AND role='school' AND ended_at IS NULL",[actor.org.id,params.id,params.userId])).rowCount) throw new EducationError(403,'Somente o administrador altera gestores.');
      await client.query('UPDATE school_staff SET ended_at=now() WHERE org_id=$1 AND school_id=$2 AND user_id=$3 AND ended_at IS NULL',[actor.org.id,params.id,params.userId]);
      await client.query('UPDATE teacher_class_assignments SET ended_at=now() WHERE org_id=$1 AND school_id=$2 AND teacher_id=$3 AND ended_at IS NULL',[actor.org.id,params.id,params.userId]);
      await audit(client,actor,'staff_ended',params.userId);
    });return reply.code(204).send();
  });

  app.post(`${base}/people`,async(request,reply)=>{
    const data=parse(personInput,request.body);
    const result=await mutate(app,request,async(client,actor)=>{
      manager(actor);
      if(!isOrgAdmin(actor) && (!data.schoolId||data.roles.some(role=>role!=='student'&&role!=='teacher'))) throw new EducationError(403,'A escola cadastra somente alunos e professores da própria escola.');
      if(data.schoolId) await assertSchoolScope(client,actor,data.schoolId);
      const user=(await client.query<{id:string}>("INSERT INTO users(org_id,email,name,roles,status) VALUES($1,$2,$3,$4,'invited') RETURNING id",[actor.org.id,data.email,data.name,data.roles])).rows[0];
      if(data.roles.includes('teacher')) await client.query('INSERT INTO teacher_profiles(org_id,user_id) VALUES($1,$2)',[actor.org.id,user.id]);
      if(data.schoolId) {
        if(data.roles.includes('student')) await client.query('INSERT INTO student_schools(org_id,student_id,school_id) VALUES($1,$2,$3)',[actor.org.id,user.id,data.schoolId]);
        for(const role of ['school','teacher']) if(data.roles.includes(role as 'school'|'teacher')) await client.query('INSERT INTO school_staff(org_id,user_id,school_id,role) VALUES($1,$2,$3,$4)',[actor.org.id,user.id,data.schoolId,role]);
      }
      await audit(client,actor,'person_created',user.id);return {person:await getPerson(client,actor,user.id)};
    });return reply.code(201).send(result);
  });
  app.get(`${base}/people/:id`,async(request)=>{
    const actor=await educationIdentity(request),personId=param(request),person=await getPerson(app.db,actor,personId);
    await assertPerson(app.db,actor,person);
    if(person.roles.includes('student')) await assertStudentScope(app.db,actor,personId);
    const schoolHistory=await app.db.query(`SELECT ss.id,ss.school_id AS "schoolId",s.name AS "schoolName",ss.started_at AS "startedAt",ss.ended_at AS "endedAt" FROM student_schools ss JOIN schools s ON s.id=ss.school_id AND s.org_id=ss.org_id WHERE ss.org_id=$1 AND ss.student_id=$2 ORDER BY ss.started_at DESC`,[actor.org.id,personId]);
    const enrollments=await app.db.query(`${enrollmentSelect} WHERE e.org_id=$1 AND e.student_id=$2 ORDER BY e.started_at DESC`,[actor.org.id,personId]);
    const groups=await app.db.query(`SELECT m.id,m.group_id AS "groupId",g.name,g.name AS "groupName",m.started_at AS "startedAt",m.ended_at AS "endedAt" FROM group_memberships m JOIN education_groups g ON g.id=m.group_id AND g.org_id=m.org_id WHERE m.org_id=$1 AND m.user_id=$2 ORDER BY m.started_at DESC`,[actor.org.id,personId]);
    return {person,schoolHistory:schoolHistory.rows,enrollments:enrollments.rows,groups:groups.rows};
  });
  app.patch(`${base}/people/:id`,async(request)=>mutate(app,request,async(client,actor)=>{
    manager(actor);const personId=param(request),data=patch(personPatch,request.body),person=await getPerson(client,actor,personId);
    await assertPerson(client,actor,person);
    if(!isOrgAdmin(actor) && (data.roles || (data.status && (person.roles.length!==1||person.roles[0]!=='student')) || person.roles.includes('org_admin'))) throw new EducationError(403,'Somente o administrador altera papéis ou o status de profissionais.');
    const nextRoles=data.roles??person.roles, nextStatus=data.status??person.status;
    await protectLastAdmin(client,actor,person,nextRoles,nextStatus);
    await client.query('UPDATE users SET name=$3,status=$4,roles=$5,profile=$6,archived_at=CASE WHEN $4=\'active\' THEN NULL ELSE archived_at END,updated_at=now() WHERE org_id=$1 AND id=$2',[actor.org.id,personId,data.name??person.name,nextStatus,nextRoles,data.profile??person.profile]);
    if(data.roles) await syncRemovedRoles(client,actor,person,data.roles);
    await audit(client,actor,'person_updated',personId);return {person:await getPerson(client,actor,personId)};
  }));
  app.post(`${base}/people/:id/archive`,async(request)=>mutate(app,request,async(client,actor)=>{
    manager(actor);const personId=param(request),person=await getPerson(client,actor,personId);await assertPerson(client,actor,person);
    if(!isOrgAdmin(actor)&&(person.roles.length!==1||person.roles[0]!=='student')) throw new EducationError(403,'A escola só pode arquivar seus alunos.');
    await protectLastAdmin(client,actor,person,person.roles,'suspended');
    await client.query("UPDATE users SET status='suspended',archived_at=COALESCE(archived_at,now()),updated_at=now() WHERE org_id=$1 AND id=$2",[actor.org.id,personId]);
    await client.query('UPDATE school_staff SET ended_at=now() WHERE org_id=$1 AND user_id=$2 AND ended_at IS NULL',[actor.org.id,personId]);
    await client.query('UPDATE teacher_class_assignments SET ended_at=now() WHERE org_id=$1 AND teacher_id=$2 AND ended_at IS NULL',[actor.org.id,personId]);
    await client.query("UPDATE teacher_profiles SET approval_status='suspended',updated_at=now() WHERE org_id=$1 AND user_id=$2",[actor.org.id,personId]);
    await client.query("UPDATE enrollments SET status='cancelled',ended_at=now() WHERE org_id=$1 AND student_id=$2 AND status='active'",[actor.org.id,personId]);
    await client.query('UPDATE group_memberships SET ended_at=now() WHERE org_id=$1 AND user_id=$2 AND ended_at IS NULL',[actor.org.id,personId]);
    await client.query('UPDATE sessions SET revoked_at=now() WHERE org_id=$1 AND user_id=$2 AND revoked_at IS NULL',[actor.org.id,personId]);
    await audit(client,actor,'person_archived',personId);return {person:await getPerson(client,actor,personId)};
  }));
  app.patch(`${base}/teachers/:id`,async(request)=>mutate(app,request,async(client,actor)=>{
    admin(actor);const userId=param(request),data=parse(approvalInput,request.body),person=await getPerson(client,actor,userId);
    if(!person.roles.includes('teacher')) throw new EducationError(409,'O usuário não é professor.');
    const teacher=(await client.query(`INSERT INTO teacher_profiles(org_id,user_id,approval_status,certifications,approved_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id,org_id) DO UPDATE SET approval_status=EXCLUDED.approval_status,certifications=EXCLUDED.certifications,approved_by=EXCLUDED.approved_by,updated_at=now()
      RETURNING user_id AS "userId",approval_status AS "approvalStatus",certifications`,[actor.org.id,userId,data.approvalStatus,JSON.stringify(data.certifications??person.teacherProfile?.certifications??[]),data.approvalStatus==='approved'?actor.user.id:null])).rows[0];
    await audit(client,actor,'teacher_approval_updated',userId);return {teacher};
  }));

  app.post(`${base}/classes`,async(request,reply)=>{
    const data=parse(classInput,request.body);
    const result=await mutate(app,request,async(client,actor)=>{
      await assertSchoolScope(client,actor,data.schoolId);checkDates(data.startsOn,data.endsOn);
      const row=(await client.query<{id:string}>('INSERT INTO classes(org_id,school_id,name,starts_on,ends_on) VALUES($1,$2,$3,$4,$5) RETURNING id',[actor.org.id,data.schoolId,data.name,data.startsOn??null,data.endsOn??null])).rows[0];
      await audit(client,actor,'class_created',row.id);return {class:await getClass(client,actor,row.id)};
    });return reply.code(201).send(result);
  });
  app.get(`${base}/classes/:id`,async(request)=>{
    const actor=await educationIdentity(request),classId=param(request),schoolClass=await getClass(app.db,actor,classId);
    const managed=await managedSchoolIds(app.db,actor);
    if(!(await app.db.query(`SELECT c.id FROM classes c WHERE c.org_id=$1 AND c.id=$5 AND ${classScope}`,[...scopeValues(actor),managed,classId])).rowCount) throw new EducationError(403,'Você não tem acesso a esta turma.');
    const enrollments=await app.db.query(`${enrollmentSelect} WHERE e.org_id=$1 AND e.class_id=$4 AND ${STUDENT_SCOPE_SQL} ORDER BY e.started_at DESC`,[...scopeValues(actor),classId]);
    const teachers=await app.db.query('SELECT a.id,a.teacher_id AS "teacherId",u.name,a.ended_at AS "endedAt" FROM teacher_class_assignments a JOIN users u ON u.id=a.teacher_id AND u.org_id=a.org_id WHERE a.org_id=$1 AND a.class_id=$2 ORDER BY a.started_at DESC',[actor.org.id,classId]);
    return {class:schoolClass,enrollments:enrollments.rows,teachers:teachers.rows};
  });
  app.patch(`${base}/classes/:id`,async(request)=>mutate(app,request,async(client,actor)=>{
    const classId=param(request),data=patch(classPatch,request.body),old=await getClass(client,actor,classId);await assertSchoolScope(client,actor,old.schoolId,false);
    const starts=data.startsOn===undefined?old.startsOn:data.startsOn,ends=data.endsOn===undefined?old.endsOn:data.endsOn;checkDates(starts,ends);
    if(data.status==='active') await assertSchoolScope(client,actor,old.schoolId);
    await client.query('UPDATE classes SET name=$3,status=$4,starts_on=$5,ends_on=$6,updated_at=now() WHERE org_id=$1 AND id=$2',[actor.org.id,classId,data.name??old.name,data.status??old.status,starts,ends]);
    if(data.status&&data.status!=='active') {
      await client.query("UPDATE enrollments SET status=$3,ended_at=now() WHERE org_id=$1 AND class_id=$2 AND status='active'",[actor.org.id,classId,data.status==='closed'?'completed':'cancelled']);
      await client.query('UPDATE teacher_class_assignments SET ended_at=now() WHERE org_id=$1 AND class_id=$2 AND ended_at IS NULL',[actor.org.id,classId]);
    }
    await audit(client,actor,'class_updated',classId);return {class:await getClass(client,actor,classId)};
  }));
  app.post(`${base}/classes/:id/enrollments`,async(request,reply)=>{
    const {studentId}=parse(z.object({studentId:id}).strict(),request.body);
    const result=await mutate(app,request,async(client,actor)=>{
      const c=await getClass(client,actor,param(request));await assertSchoolScope(client,actor,c.schoolId);if(c.status!=='active') throw new EducationError(409,'A turma está encerrada.');
      const student=await getPerson(client,actor,studentId);live(student);
      if(!student.roles.includes('student')||student.schoolId!==c.schoolId) throw new EducationError(409,'O aluno precisa pertencer à escola da turma.');
      const enrollment=(await client.query(`INSERT INTO enrollments(org_id,class_id,school_id,student_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(org_id,class_id,student_id) WHERE status='active' DO UPDATE SET status='active'
        RETURNING id,student_id AS "studentId",class_id AS "classId",status,started_at AS "startedAt",ended_at AS "endedAt"`,[actor.org.id,c.id,c.schoolId,studentId])).rows[0];
      await audit(client,actor,'student_enrolled',studentId);return {enrollment};
    });return reply.code(201).send(result);
  });
  app.delete(`${base}/classes/:id/enrollments/:studentId`,async(request,reply)=>{
    const params=parse(z.object({id,studentId:id}).strict(),request.params);
    await mutate(app,request,async(client,actor)=>{const c=await getClass(client,actor,params.id);await assertSchoolScope(client,actor,c.schoolId,false);
      await client.query("UPDATE enrollments SET status='cancelled',ended_at=now() WHERE org_id=$1 AND class_id=$2 AND student_id=$3 AND status='active'",[actor.org.id,c.id,params.studentId]);await audit(client,actor,'enrollment_ended',params.studentId);
    });return reply.code(204).send();
  });
  app.post(`${base}/classes/:id/teachers`,async(request,reply)=>{
    const {teacherId}=parse(z.object({teacherId:id}).strict(),request.body);
    const result=await mutate(app,request,async(client,actor)=>{
      const c=await getClass(client,actor,param(request));await assertSchoolScope(client,actor,c.schoolId);if(c.status!=='active') throw new EducationError(409,'A turma está encerrada.');
      const teacher=await getPerson(client,actor,teacherId);live(teacher);
      if(!teacher.roles.includes('teacher')||teacher.teacherProfile?.approvalStatus!=='approved'||!(await client.query("SELECT id FROM school_staff WHERE org_id=$1 AND school_id=$2 AND user_id=$3 AND role='teacher' AND ended_at IS NULL",[actor.org.id,c.schoolId,teacherId])).rowCount) throw new EducationError(409,'O professor precisa estar aprovado e vinculado à escola.');
      const assignment=(await client.query(`INSERT INTO teacher_class_assignments(org_id,class_id,school_id,teacher_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(org_id,class_id,teacher_id) WHERE ended_at IS NULL DO UPDATE SET teacher_id=EXCLUDED.teacher_id
        RETURNING id,teacher_id AS "teacherId",ended_at AS "endedAt"`,[actor.org.id,c.id,c.schoolId,teacherId])).rows[0];await audit(client,actor,'teacher_assigned',teacherId);return {assignment};
    });return reply.code(201).send(result);
  });
  app.delete(`${base}/classes/:id/teachers/:teacherId`,async(request,reply)=>{
    const params=parse(z.object({id,teacherId:id}).strict(),request.params);
    await mutate(app,request,async(client,actor)=>{const c=await getClass(client,actor,params.id);await assertSchoolScope(client,actor,c.schoolId,false);
      await client.query('UPDATE teacher_class_assignments SET ended_at=now() WHERE org_id=$1 AND class_id=$2 AND teacher_id=$3 AND ended_at IS NULL',[actor.org.id,c.id,params.teacherId]);await audit(client,actor,'teacher_assignment_ended',params.teacherId);
    });return reply.code(204).send();
  });
  app.post(`${base}/students/:id/transfer`,async(request)=>mutate(app,request,async(client,actor)=>{
    admin(actor);const studentId=param(request),data=parse(z.object({schoolId:id,reason:z.string().trim().max(1000).default('')}).strict(),request.body);
    const student=await getPerson(client,actor,studentId);if(!student.roles.includes('student')) throw new EducationError(409,'O usuário não é aluno.');
    await assertSchoolScope(client,actor,data.schoolId);
    await client.query('SELECT id FROM users WHERE org_id=$1 AND id=$2 FOR UPDATE',[actor.org.id,studentId]);
    if(student.schoolId===data.schoolId) return {person:student,transferred:false};
    await client.query('UPDATE student_schools SET ended_at=now() WHERE org_id=$1 AND student_id=$2 AND ended_at IS NULL',[actor.org.id,studentId]);
    await client.query("UPDATE enrollments SET status='transferred',ended_at=now() WHERE org_id=$1 AND student_id=$2 AND status='active'",[actor.org.id,studentId]);
    await client.query('UPDATE group_memberships SET ended_at=now() WHERE org_id=$1 AND user_id=$2 AND ended_at IS NULL AND group_id IN(SELECT id FROM education_groups WHERE org_id=$1 AND school_id IS NOT NULL)',[actor.org.id,studentId]);
    await client.query('INSERT INTO student_schools(org_id,student_id,school_id) VALUES($1,$2,$3)',[actor.org.id,studentId,data.schoolId]);
    await client.query('INSERT INTO student_transfers(org_id,student_id,from_school_id,to_school_id,reason,actor_user_id) VALUES($1,$2,$3,$4,$5,$6)',[actor.org.id,studentId,student.schoolId,data.schoolId,data.reason,actor.user.id]);
    await audit(client,actor,'student_transferred',studentId);return {person:await getPerson(client,actor,studentId),transferred:true};
  }));

  app.post(`${base}/group-types`,async(request,reply)=>{
    const data=parse(typeInput,request.body);const result=await mutate(app,request,async(client,actor)=>{
      admin(actor);const groupType=(await client.query<GroupType>('INSERT INTO group_types(org_id,name,position) VALUES($1,$2,$3) RETURNING id,name,position,status',[actor.org.id,data.name,data.position])).rows[0];await audit(client,actor,'group_type_created',groupType.id);return {groupType};
    });return reply.code(201).send(result);
  });
  app.patch(`${base}/group-types/:id`,async(request)=>mutate(app,request,async(client,actor)=>{
    admin(actor);const typeId=param(request),data=patch(typePatch,request.body),old=await getType(client,actor,typeId);
    if(data.status==='archived'&&(await client.query("SELECT id FROM education_groups WHERE org_id=$1 AND type_id=$2 AND status='active'",[actor.org.id,typeId])).rowCount) throw new EducationError(409,'Arquive os grupos deste tipo primeiro.');
    const groupType=(await client.query<GroupType>('UPDATE group_types SET name=$3,position=$4,status=$5 WHERE org_id=$1 AND id=$2 RETURNING id,name,position,status',[actor.org.id,typeId,data.name??old.name,data.position??old.position,data.status??old.status])).rows[0];await audit(client,actor,'group_type_updated',typeId);return {groupType};
  }));
  app.post(`${base}/groups`,async(request,reply)=>{
    const data=parse(groupInput,request.body);const result=await mutate(app,request,async(client,actor)=>{
      manager(actor);if(!isOrgAdmin(actor)&&!data.schoolId) throw new EducationError(403,'A escola cria grupos apenas no próprio escopo.');
      if(data.schoolId) await assertSchoolScope(client,actor,data.schoolId);
      await validGroupParent(client,actor,data.parentId??null,data.schoolId??null);if((await getType(client,actor,data.typeId)).status!=='active') throw new EducationError(409,'Tipo de grupo arquivado.');
      const row=(await client.query<{id:string}>('INSERT INTO education_groups(org_id,name,type_id,parent_id,school_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[actor.org.id,data.name,data.typeId,data.parentId??null,data.schoolId??null])).rows[0];await audit(client,actor,'group_created',row.id);return {group:await getGroup(client,actor,row.id)};
    });return reply.code(201).send(result);
  });
  app.get(`${base}/groups/:id`,async(request)=>{
    const actor=await educationIdentity(request),group=await getGroup(app.db,actor,param(request));await groupManager(app.db,actor,group,false);
    const members=await app.db.query(`SELECT m.id,m.user_id AS "userId",u.name,m.ended_at AS "endedAt" FROM group_memberships m JOIN users u ON u.id=m.user_id AND u.org_id=m.org_id WHERE m.org_id=$1 AND m.group_id=$4 AND ${PERSON_SCOPE_SQL} ORDER BY m.started_at DESC`,[...scopeValues(actor),group.id]);return {group,members:members.rows};
  });
  app.patch(`${base}/groups/:id`,async(request)=>mutate(app,request,async(client,actor)=>{
    const groupId=param(request),data=patch(groupPatch,request.body),old=await getGroup(client,actor,groupId);await groupManager(client,actor,old,false);
    const parentId=data.parentId===undefined?old.parentId:data.parentId;await validGroupParent(client,actor,parentId,old.schoolId);
    if(parentId) {
      const cycle=await client.query('WITH RECURSIVE descendants AS (SELECT id FROM education_groups WHERE org_id=$1 AND id=$2 UNION ALL SELECT g.id FROM education_groups g JOIN descendants d ON g.parent_id=d.id WHERE g.org_id=$1) SELECT id FROM descendants WHERE id=$3',[actor.org.id,groupId,parentId]);
      if(cycle.rowCount) throw new EducationError(409,'O grupo não pode ser pai de si mesmo nem de um ancestral.');
    }
    const groupType=await getType(client,actor,data.typeId??old.typeId);if((data.status??old.status)==='active'&&groupType.status!=='active') throw new EducationError(409,'Tipo de grupo arquivado.');
    if(data.status==='active'&&old.schoolId) await assertSchoolScope(client,actor,old.schoolId);
    await client.query('UPDATE education_groups SET name=$3,type_id=$4,parent_id=$5,status=$6,updated_at=now() WHERE org_id=$1 AND id=$2',[actor.org.id,groupId,data.name??old.name,data.typeId??old.typeId,parentId,data.status??old.status]);
    if(data.status==='archived') {
      const descendants=await client.query<{id:string}>('WITH RECURSIVE descendants AS (SELECT id FROM education_groups WHERE org_id=$1 AND id=$2 UNION ALL SELECT g.id FROM education_groups g JOIN descendants d ON g.parent_id=d.id WHERE g.org_id=$1) SELECT id FROM descendants',[actor.org.id,groupId]);
      const ids=descendants.rows.map(row=>row.id);await client.query("UPDATE education_groups SET status='archived',updated_at=now() WHERE org_id=$1 AND id=ANY($2::uuid[])",[actor.org.id,ids]);await client.query('UPDATE group_memberships SET ended_at=now() WHERE org_id=$1 AND group_id=ANY($2::uuid[]) AND ended_at IS NULL',[actor.org.id,ids]);
    }
    await audit(client,actor,'group_updated',groupId);return {group:await getGroup(client,actor,groupId)};
  }));
  app.post(`${base}/groups/:id/members`,async(request,reply)=>{
    const {userId}=parse(z.object({userId:id}).strict(),request.body);const result=await mutate(app,request,async(client,actor)=>{
      const group=await getGroup(client,actor,param(request));await groupManager(client,actor,group);const person=await getPerson(client,actor,userId);live(person);await assertPerson(client,actor,person);
      if(group.schoolId && person.schoolId!==group.schoolId && !person.schoolIds.includes(group.schoolId)) throw new EducationError(409,'O participante precisa pertencer à escola do grupo.');
      const membership=(await client.query('INSERT INTO group_memberships(org_id,group_id,user_id) VALUES($1,$2,$3) ON CONFLICT(org_id,group_id,user_id) WHERE ended_at IS NULL DO UPDATE SET user_id=EXCLUDED.user_id RETURNING id,user_id AS "userId",ended_at AS "endedAt"',[actor.org.id,group.id,userId])).rows[0];await audit(client,actor,'group_member_added',userId);return {membership};
    });return reply.code(201).send(result);
  });
  app.delete(`${base}/groups/:id/members/:userId`,async(request,reply)=>{
    const params=parse(z.object({id,userId:id}).strict(),request.params);await mutate(app,request,async(client,actor)=>{
      const group=await getGroup(client,actor,params.id);await groupManager(client,actor,group,false);await client.query('UPDATE group_memberships SET ended_at=now() WHERE org_id=$1 AND group_id=$2 AND user_id=$3 AND ended_at IS NULL',[actor.org.id,group.id,params.userId]);await audit(client,actor,'group_member_ended',params.userId);
    });return reply.code(204).send();
  });
}

const enrollmentSelect=`SELECT e.id,e.student_id AS "studentId",u.name AS "studentName",e.class_id AS "classId",c.name AS "className",e.school_id AS "schoolId",e.status,e.started_at AS "startedAt",e.ended_at AS "endedAt" FROM enrollments e JOIN users u ON u.id=e.student_id AND u.org_id=e.org_id JOIN classes c ON c.id=e.class_id AND c.org_id=e.org_id`;
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const parsed=schema.safeParse(value);if(!parsed.success)throw new EducationError(400,'Dados inválidos. Confira os campos informados.');return parsed.data;}
function patch<T extends object>(schema:z.ZodType<T>,value:unknown):T {const data=parse(schema,value);if(Object.keys(data).length===0)throw new EducationError(400,'Informe ao menos uma alteração.');return data;}
function param(request:FastifyRequest):string {return parse(z.object({id}).strict(),request.params).id;}
function admin(actor:AuthIdentity):void {if(!isOrgAdmin(actor))throw new EducationError(403,'Ação exclusiva do administrador da organização.');}
function manager(actor:AuthIdentity):void {if(!isOrgAdmin(actor)&&!actor.user.roles.includes('school'))throw new EducationError(403,'Ação exclusiva da gestão.');}
function live(person:Person):void {if(person.archivedAt||person.status==='suspended')throw new EducationError(409,'O usuário está suspenso ou arquivado.');}
function checkDates(start:string|null|undefined,end:string|null|undefined):void {if(start&&end&&end<start)throw new EducationError(400,'O término deve ser posterior ao início.');}
async function mutate<T>(app:FastifyInstance,request:FastifyRequest,fn:(client:PoolClient,actor:AuthIdentity)=>Promise<T>):Promise<T> {
  const actor=await educationIdentity(request);try{return await app.db.transaction(async(client)=>{
    // Serializes educational changes inside one tenant, including reparent and transfer.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))',[actor.org.id]);
    const current=await client.query<{name:string;email:string;roles:IdentityRole[]}>(
      `SELECT u.name,u.email,u.roles FROM sessions s JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id
       JOIN orgs o ON o.id=s.org_id JOIN domains d ON d.hostname=s.hostname AND d.org_id=s.org_id
       WHERE s.token_hash=$1 AND s.org_id=$2 AND s.user_id=$3 AND s.hostname=$4
         AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='active'
         AND u.archived_at IS NULL AND o.status='active' FOR SHARE OF u,o`,
      [createHash('sha256').update(request.cookies.matraca_session??'').digest('hex'),actor.org.id,actor.user.id,localHostname(request.headers.host)],
    );
    const user=current.rows[0];if(!user)throw new EducationError(401,'A sessão foi revogada ou suspensa.');
    if(!user.roles.some(role=>['org_admin','school','teacher','student'].includes(role))||user.roles.includes('operator'))throw new EducationError(403,'Você não tem permissão para esta ação.');
    return fn(client,{...actor,user:{...actor.user,...user}});
  });}catch(error){if((error as{code?:string}).code==='23505')throw new EducationError(409,'Este cadastro ou vínculo já existe.');throw error;}
}
async function getSchool(client:EducationQuery,actor:AuthIdentity,schoolId:string):Promise<School> {const row=(await client.query<School>('SELECT id,name,city,state,status FROM schools WHERE org_id=$1 AND id=$2',[actor.org.id,schoolId])).rows[0];if(!row)throw new EducationError(404,'Escola não encontrada.');return row;}
async function getPerson(client:EducationQuery,actor:AuthIdentity,userId:string):Promise<Person> {const row=(await client.query<Person>(`${personSelect} WHERE u.org_id=$1 AND u.id=$2`,[actor.org.id,userId])).rows[0];if(!row)throw new EducationError(404,'Pessoa não encontrada.');return row;}
async function getClass(client:EducationQuery,actor:AuthIdentity,classId:string):Promise<SchoolClass> {const row=(await client.query<SchoolClass>(`${classSelect} WHERE c.org_id=$1 AND c.id=$2`,[actor.org.id,classId])).rows[0];if(!row)throw new EducationError(404,'Turma não encontrada.');return row;}
async function getGroup(client:EducationQuery,actor:AuthIdentity,groupId:string):Promise<EducationGroup> {const row=(await client.query<EducationGroup>(`${groupSelect} WHERE g.org_id=$1 AND g.id=$2`,[actor.org.id,groupId])).rows[0];if(!row)throw new EducationError(404,'Grupo não encontrado.');return row;}
async function getType(client:EducationQuery,actor:AuthIdentity,typeId:string):Promise<GroupType> {const row=(await client.query<GroupType>('SELECT id,name,position,status FROM group_types WHERE org_id=$1 AND id=$2',[actor.org.id,typeId])).rows[0];if(!row)throw new EducationError(404,'Tipo de grupo não encontrado.');return row;}
async function assertPerson(client:EducationQuery,actor:AuthIdentity,person:Person):Promise<void> {if(!(await client.query(`SELECT u.id FROM users u WHERE u.org_id=$1 AND u.id=$4 AND ${PERSON_SCOPE_SQL}`,[...scopeValues(actor),person.id])).rowCount)throw new EducationError(403,'Você não tem acesso a esta pessoa.');}
async function groupManager(client:EducationQuery,actor:AuthIdentity,group:EducationGroup,active=true):Promise<void> {manager(actor);if(group.schoolId)await assertSchoolScope(client,actor,group.schoolId,active);else admin(actor);if(active&&group.status!=='active')throw new EducationError(409,'O grupo está arquivado.');}
async function validGroupParent(client:EducationQuery,actor:AuthIdentity,parentId:string|null,schoolId:string|null):Promise<void> {if(!parentId)return;const parent=await getGroup(client,actor,parentId);if(parent.status!=='active')throw new EducationError(409,'O grupo pai está arquivado.');if(parent.schoolId&&parent.schoolId!==schoolId)throw new EducationError(409,'O grupo deve manter o escopo escolar do pai.');}
async function audit(client:PoolClient,actor:AuthIdentity,event:string,entityId:string):Promise<void> {await client.query('INSERT INTO audit_events(org_id,actor_user_id,event_type,metadata) VALUES($1,$2,$3,$4)',[actor.org.id,actor.user.id,event,{entityId}]);}
async function protectLastAdmin(client:EducationQuery,actor:AuthIdentity,person:Person,nextRoles:IdentityRole[],nextStatus:string):Promise<void> {if(person.roles.includes('org_admin')&&person.status==='active'&&(!nextRoles.includes('org_admin')||nextStatus!=='active')){const others=await client.query("SELECT id FROM users WHERE org_id=$1 AND id<>$2 AND 'org_admin'=ANY(roles) AND status='active' AND archived_at IS NULL",[actor.org.id,person.id]);if(!others.rowCount)throw new EducationError(409,'Mantenha ao menos um administrador ativo.');}}
async function syncRemovedRoles(client:PoolClient,actor:AuthIdentity,person:Person,next:IdentityRole[]):Promise<void> {
  for(const role of ['school','teacher'])if(!next.includes(role as IdentityRole))await client.query('UPDATE school_staff SET ended_at=now() WHERE org_id=$1 AND user_id=$2 AND role=$3 AND ended_at IS NULL',[actor.org.id,person.id,role]);
  if(!next.includes('teacher')){await client.query('UPDATE teacher_class_assignments SET ended_at=now() WHERE org_id=$1 AND teacher_id=$2 AND ended_at IS NULL',[actor.org.id,person.id]);await client.query("UPDATE teacher_profiles SET approval_status='suspended',updated_at=now() WHERE org_id=$1 AND user_id=$2",[actor.org.id,person.id]);}
  else if(!person.roles.includes('teacher'))await client.query("INSERT INTO teacher_profiles(org_id,user_id) VALUES($1,$2) ON CONFLICT(user_id,org_id) DO UPDATE SET approval_status='pending',approved_by=NULL,updated_at=now()",[actor.org.id,person.id]);
  if(!next.includes('student')){await client.query('UPDATE student_schools SET ended_at=now() WHERE org_id=$1 AND student_id=$2 AND ended_at IS NULL',[actor.org.id,person.id]);await client.query("UPDATE enrollments SET status='cancelled',ended_at=now() WHERE org_id=$1 AND student_id=$2 AND status='active'",[actor.org.id,person.id]);}
}

async function list(client:EducationQuery,actor:AuthIdentity,resource:'schools'|'people'|'classes'|'group-types'|'groups',query:z.infer<typeof querySchema>) {
  const managed=await managedSchoolIds(client,actor), values:unknown[]=[...scopeValues(actor),managed];
  let select:string,where:string,alias:string;
  if(resource==='schools') {
    select='SELECT s.id,s.name,s.city,s.state,s.status FROM schools s';alias='s';
    where=`s.org_id=$1 AND ('org_admin'=ANY($3::text[]) OR s.id=ANY($4::uuid[]) OR
      EXISTS(SELECT 1 FROM student_schools ss WHERE ss.org_id=$1 AND ss.school_id=s.id AND ss.student_id=$2 AND ss.ended_at IS NULL) OR
      ('teacher'=ANY($3::text[]) AND s.status='active' AND EXISTS(SELECT 1 FROM school_staff st JOIN teacher_profiles p ON p.org_id=st.org_id AND p.user_id=st.user_id WHERE st.org_id=$1 AND st.school_id=s.id AND st.user_id=$2 AND st.role='teacher' AND st.ended_at IS NULL AND p.approval_status='approved')))`;
  } else if(resource==='people') {select=personSelect;alias='u';where=`u.org_id=$1 AND ${PERSON_SCOPE_SQL}`;}
  else if(resource==='classes') {select=classSelect;alias='c';where=`c.org_id=$1 AND ${classScope}`;}
  else if(resource==='group-types') {select='SELECT t.id,t.name,t.position,t.status FROM group_types t';alias='t';where='t.org_id=$1';}
  else {select=groupSelect;alias='g';where=`g.org_id=$1 AND ('org_admin'=ANY($3::text[]) OR ('school'=ANY($3::text[]) AND (g.school_id IS NULL OR g.school_id=ANY($4::uuid[]))) OR EXISTS(SELECT 1 FROM group_memberships m WHERE m.org_id=$1 AND m.group_id=g.id AND m.user_id=$2 AND m.ended_at IS NULL))`;}
  // Keep the first four placeholders typed even for simple catalogs.
  where+=' AND $2::uuid IS NOT NULL AND $3::text[] IS NOT NULL AND $4::uuid[] IS NOT NULL';
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  if(query.search){const token=bind(`%${query.search.replace(/[\\%_]/g,'\\$&')}%`);where+=` AND (${alias}.name ILIKE ${token}${resource==='people'?` OR u.email ILIKE ${token}`:''})`;}
  if(query.status){if(resource==='people'&&query.status==='archived')where+=' AND u.archived_at IS NOT NULL';else where+=` AND ${alias}.status=${bind(query.status)}`;}
  if(query.schoolId){const token=bind(query.schoolId);if(resource==='people')where+=` AND (EXISTS(SELECT 1 FROM student_schools ss WHERE ss.org_id=$1 AND ss.student_id=u.id AND ss.school_id=${token} AND ss.ended_at IS NULL) OR EXISTS(SELECT 1 FROM school_staff st WHERE st.org_id=$1 AND st.user_id=u.id AND st.school_id=${token} AND st.ended_at IS NULL))`;else if(resource==='classes'||resource==='groups')where+=` AND ${alias}.school_id=${token}`;else if(resource==='schools')where+=` AND s.id=${token}`;else values.pop();}
  if(query.role&&resource==='people')where+=` AND ${bind(query.role)}=ANY(u.roles)`;
  const count=await client.query<{total:number}>(`SELECT count(*)::integer AS total FROM (${select} WHERE ${where}) visible`,values);
  const limit=bind(query.pageSize),offset=bind((query.page-1)*query.pageSize);
  const items=await client.query(`${select} WHERE ${where} ORDER BY ${alias}.name,${alias}.id LIMIT ${limit} OFFSET ${offset}`,values);
  return {items:items.rows,total:count.rows[0].total,page:query.page,pageSize:query.pageSize};
}
