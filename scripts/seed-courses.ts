import type {PoolClient} from 'pg';
import {fileURLToPath} from 'node:url';
import {loadCurriculumFromFile} from '../server/curriculum.js';
import {curriculumToCourse} from '../server/course-model.js';
import {publishCourseInTransaction} from '../server/courses.js';
export async function seedCourses(client:PoolClient,id:(key:string)=>string){
 if(!(await client.query("SELECT to_regclass('courses') IS NOT NULL AS ready")).rows[0].ready)return;
 const source=await loadCurriculumFromFile(fileURLToPath(new URL('../docs/PLANO_DE_ENSINO.md',import.meta.url)));
 const base=curriculumToCourse(source);
 const organizations=await client.query<{id:string;slug:string}>("SELECT id,slug FROM orgs WHERE slug IN ('matraca','parceiro') ORDER BY CASE slug WHEN 'matraca' THEN 0 ELSE 1 END");
 for(const org of organizations.rows){
  const courseId=id(`course:${org.slug}:base`);const document=org.slug==='matraca'?base:{...base,title:'Horizonte · jornada de oratória',catalogVisible:false};
  const created=await client.query('INSERT INTO courses(id,org_id,title,draft,source_course_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id',[courseId,org.id,document.title,document,org.slug==='parceiro'?id('course:matraca:base'):null]);
  if(!created.rowCount)continue;
  const version=await publishCourseInTransaction(client,org.id,courseId,0,null);
  const students=await client.query<{id:string}>("SELECT id FROM users WHERE org_id=$1 AND 'student'=ANY(roles) AND status='active'",[org.id]);
  for(const student of students.rows)await client.query("INSERT INTO course_enrollments(org_id,course_id,version_id,student_id,source,source_ref) VALUES($1,$2,$3,$4,'demo','pilot-seed') ON CONFLICT(course_id,student_id) DO NOTHING",[org.id,courseId,version.id,student.id]);
 }
}
