import type { PoolClient } from 'pg';

/** Additive, deterministic demo seed. Re-running never restores a removed live link. */
export async function seedEducation(client:PoolClient,id:(key:string)=>string) {
  if (!(await client.query("SELECT to_regclass('schools') IS NOT NULL AS ready")).rows[0].ready) return;
  const org=(await client.query("SELECT id FROM orgs WHERE slug='parceiro'")).rows[0];
  if (!org) return;
  const schoolId=id('parceiro:school:centro');
  const currentClass=id('parceiro:class:pilot');
  const pastClass=id('parceiro:class:intro');
  await client.query("INSERT INTO schools(id,org_id,name,city,state) VALUES($1,$2,'Unidade Centro','São Paulo','SP') ON CONFLICT(id) DO NOTHING",[schoolId,org.id]);
  await client.query("INSERT INTO classes(id,org_id,school_id,name,starts_on) VALUES($1,$2,$3,'Turma Piloto 2026','2026-11-01') ON CONFLICT(id) DO NOTHING",[currentClass,org.id,schoolId]);
  await client.query("INSERT INTO classes(id,org_id,school_id,name,status,starts_on,ends_on) VALUES($1,$2,$3,'Introdução · turma encerrada','closed','2026-10-01','2026-10-31') ON CONFLICT(id) DO NOTHING",[pastClass,org.id,schoolId]);
  const people=await client.query<{id:string;email:string;roles:string[]}>('SELECT id,email,roles FROM users WHERE org_id=$1',[org.id]);
  const admin=people.rows.find(person=>person.roles.includes('org_admin'));
  for (const person of people.rows) {
    if (person.roles.includes('student')) {
      await client.query('INSERT INTO student_schools(id,org_id,school_id,student_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id(`student-school:${person.id}`),org.id,schoolId,person.id]);
      await client.query('INSERT INTO enrollments(id,org_id,class_id,school_id,student_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[id(`enrollment-pilot:${person.id}`),org.id,currentClass,schoolId,person.id]);
      await client.query("INSERT INTO enrollments(id,org_id,class_id,school_id,student_id,status,started_at,ended_at) VALUES($1,$2,$3,$4,$5,'completed','2026-10-01T12:00:00Z','2026-10-31T12:00:00Z') ON CONFLICT DO NOTHING",[id(`enrollment-intro:${person.id}`),org.id,pastClass,schoolId,person.id]);
    }
    for (const role of ['school','teacher']) if (person.roles.includes(role)) {
      await client.query('INSERT INTO school_staff(id,org_id,school_id,user_id,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[id(`staff:${person.id}:${role}`),org.id,schoolId,person.id,role]);
    }
    if (person.roles.includes('teacher')) {
      await client.query("INSERT INTO teacher_profiles(org_id,user_id,approval_status,certifications,approved_by) VALUES($1,$2,'approved',$3,$4) ON CONFLICT DO NOTHING",[org.id,person.id,JSON.stringify([{name:'Formação docente · demonstração',issuer:'Matraca · piloto',issuedOn:'2026-10-01'}]),admin?.id??null]);
      await client.query('INSERT INTO teacher_class_assignments(id,org_id,class_id,school_id,teacher_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[id(`teacher-class:${person.id}`),org.id,currentClass,schoolId,person.id]);
    }
  }
  const levels=[{type:'Estado',name:'São Paulo',school:null},{type:'Cidade',name:'São Paulo · capital',school:null},{type:'Unidade',name:'Unidade Centro',school:schoolId},{type:'Turma',name:'Turma Piloto 2026',school:schoolId}];
  let parent:string|null=null;
  for (const [position,level] of levels.entries()) {
    const typeId=id(`group-type:${level.type}`); const groupId=id(`group:${level.type}`);
    await client.query('INSERT INTO group_types(id,org_id,name,position) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[typeId,org.id,level.type,position]);
    await client.query('INSERT INTO education_groups(id,org_id,type_id,parent_id,school_id,name) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[groupId,org.id,typeId,parent,level.school,level.name]);
    for (const person of people.rows.filter(person=>person.roles.includes('student'))) await client.query('INSERT INTO group_memberships(id,org_id,group_id,user_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id(`group-member:${groupId}:${person.id}`),org.id,groupId,person.id]);
    parent=groupId;
  }
}
