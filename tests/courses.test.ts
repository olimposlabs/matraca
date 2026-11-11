import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../server/app.js';
import {createDatabase} from '../server/db.js';
import {localDatabaseUrl} from '../server/config.js';
import {emptyCourse,courseDocumentSchema,validatePublication,curriculumToCourse,type CourseDocument} from '../server/course-model.js';
import {parseCurriculum} from '../server/curriculum.js';
import {seedCourses} from '../scripts/seed-courses.js';
interface Actor{orgId:string;userId:string;host:string;cookie:string}
const example=():CourseDocument=>({...emptyCourse('Curso de teste'),modules:[{id:'module-1',title:'Clareza',introductionMarkdown:'Introdução',units:[{id:'lesson-1',title:'Mensagem principal',chapter:'Fundamentos',kind:'lesson',mode:'content',bodyMarkdown:'Conteúdo autoral completo.',instructionMarkdown:'Apresente uma ideia em trinta segundos.',checklist:['Defini o objetivo.'],references:[],assetIds:[],prerequisites:[],studyCreditGrant:1,requiresEvaluation:true,activity:{maximumSeconds:30,acceptedMedia:['audio','video'],scenario:'one_on_one',criteria:[{id:'clarity',title:'Clareza',enabled:true,weight:1,modality:'both',descriptors:['Requer apoio','Parcial','Consistente','Flexível']}]}}]}]});

describe('cursos versionados e atribuição',()=>{
 let app:FastifyInstance;let control:ReturnType<typeof createDatabase>;let db:ReturnType<typeof createDatabase>;let root:string;const schema=`courses_test_${randomUUID().replaceAll('-','')}`;
 beforeAll(async()=>{const base=process.env.DATABASE_URL??localDatabaseUrl;control=createDatabase(base);await control.query(`CREATE SCHEMA ${schema}`);const url=new URL(base);url.searchParams.set('options',`-c search_path=${schema}`);db=createDatabase(url.toString());const directory=new URL('../server/migrations/',import.meta.url);for(const name of(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort())await db.query(await readFile(new URL(name,directory),'utf8'));root=await mkdtemp(join(tmpdir(),'matraca-courses-'));app=await createApp({databaseUrl:url.toString(),storageRoot:join(root,'objects')});});
 afterAll(async()=>{await app?.close();await db?.close();if(control){try{await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await control.close();}}if(root)await rm(root,{recursive:true,force:true});});
 async function actor(role='org_admin',orgId:string=randomUUID(),kind='partner'):Promise<Actor>{await db.query('INSERT INTO orgs(id,slug,name,kind) VALUES($1,$2,\'Curso sintético\',$3) ON CONFLICT DO NOTHING',[orgId,`course-${orgId}`,kind]);const host=kind==='backoffice'?`backoffice-${orgId}.localhost`:`course-${orgId}.localhost`;await db.query('INSERT INTO domains(hostname,org_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[host,orgId]);const userId=randomUUID();await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,$3,'Pessoa sintética',$4,'active')",[userId,orgId,`${userId}@example.test`,[role]]);const token=randomBytes(32).toString('base64url');await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[orgId,userId,host,createHash('sha256').update(token).digest('hex')]);return {orgId,userId,host,cookie:`matraca_session=${token}`};}
 async function call(a:Actor,method:'GET'|'POST'|'PUT',url:string,payload?:unknown){return app.inject({method,url,headers:{host:a.host,cookie:a.cookie,'x-matraca-request':'1'},...(payload===undefined?{}:{payload:JSON.stringify(payload),headers:{host:a.host,cookie:a.cookie,'x-matraca-request':'1','content-type':'application/json'}})});}
 async function draft(a:Actor,document=example()){const created=await call(a,'POST','/api/courses/manage',{title:document.title});expect(created.statusCode).toBe(201);const id=created.json().course.id;const saved=await call(a,'PUT',`/api/courses/manage/${id}`,{expectedRevision:0,document});expect(saved.statusCode).toBe(200);return id;}
 async function publish(a:Actor,id:string,expectedRevision=1){const response=await call(a,'POST',`/api/courses/manage/${id}/publish`,{expectedRevision});expect(response.statusCode).toBe(200);return response.json().version;}
 it('importa a base completa em configuração publicável sem perder o texto',async()=>{const content=await readFile(new URL('../docs/PLANO_DE_ENSINO.md',import.meta.url),'utf8');const course=curriculumToCourse(parseCurriculum(content));expect(courseDocumentSchema.safeParse(course).success).toBe(true);expect(validatePublication(course)).toEqual([]);expect(course.modules.flatMap(module=>module.units)).toHaveLength(48);expect(course.provenance?.sourceMarkdown).toBe(content);expect(course.modules.flatMap(module=>module.units).filter(unit=>unit.kind==='lesson').every(unit=>unit.activity.maximumSeconds===30)).toBe(true);});
 it('rejeita publicação incompleta, ciclos e critérios sem peso',()=>{expect(validatePublication(emptyCourse('Vazio')).length).toBeGreaterThan(0);const course=example();course.modules[0].units[0].prerequisites=['lesson-1'];course.modules[0].units[0].activity.criteria[0].weight=0;expect(validatePublication(course)).toContain('Os pré-requisitos contêm um ciclo.');expect(validatePublication(course).some(issue=>issue.includes('peso positivo'))).toBe(true);});
 it('salva com revisão otimista e não duplica publicação repetida',async()=>{const admin=await actor();const id=await draft(admin);expect((await call(admin,'PUT',`/api/courses/manage/${id}`,{expectedRevision:0,document:example()})).statusCode).toBe(409);const first=await publish(admin,id);const second=await publish(admin,id);expect(second.id).toBe(first.id);expect((await db.query('SELECT id FROM course_versions WHERE course_id=$1',[id])).rowCount).toBe(1);});
 it('republica curso arquivado sem duplicar o snapshot idêntico',async()=>{
  const admin=await actor();const id=await draft(admin);const first=await publish(admin,id);
  expect((await call(admin,'POST',`/api/courses/manage/${id}/archive`)).statusCode).toBe(200);
  const restored=await publish(admin,id);expect(restored.id).toBe(first.id);
  expect((await call(admin,'GET',`/api/courses/manage/${id}`)).json().course.status).toBe('published');
 });
 it('mantém aluno na versão atribuída e impede editar snapshot publicado',async()=>{const admin=await actor();const student=await actor('student',admin.orgId);const id=await draft(admin);const original=await publish(admin,id);expect((await call(admin,'POST',`/api/courses/manage/${id}/assign`,{versionId:original.id,studentId:student.userId})).statusCode).toBe(200);const revised=example();revised.modules[0].units[0].bodyMarkdown='Conteúdo da segunda versão.';await call(admin,'PUT',`/api/courses/manage/${id}`,{expectedRevision:1,document:revised});const second=await publish(admin,id,2);expect(second.version).toBe(2);const view=await call(student,'GET',`/api/courses/${id}`);expect(view.statusCode).toBe(200);expect(view.json().version).toBe(1);expect(view.json().document.modules[0].units[0].bodyMarkdown).toBe('Conteúdo autoral completo.');await expect(db.query("UPDATE course_versions SET document='{}' WHERE id=$1",[original.id])).rejects.toThrow('immutable');});
 it('novos alunos da turma recebem a última versão atribuída, preservando a anterior e respeitando arquivo',async()=>{
  const admin=await actor();const previous=await actor('student',admin.orgId);const next=await actor('student',admin.orgId);const late=await actor('student',admin.orgId);
  const schoolId=randomUUID(),classId=randomUUID();
  await db.query("INSERT INTO schools(id,org_id,name) VALUES($1,$2,'Escola teste')",[schoolId,admin.orgId]);
  await db.query("INSERT INTO classes(id,org_id,school_id,name) VALUES($1,$2,$3,'Turma teste')",[classId,admin.orgId,schoolId]);
  for(const student of [previous,next,late])await db.query('INSERT INTO student_schools(org_id,school_id,student_id) VALUES($1,$2,$3)',[admin.orgId,schoolId,student.userId]);
  expect((await call(admin,'POST',`/api/education/classes/${classId}/enrollments`,{studentId:previous.userId})).statusCode).toBe(201);
  const id=await draft(admin);const first=await publish(admin,id);
  expect((await call(admin,'POST',`/api/courses/manage/${id}/assign`,{versionId:first.id,classId})).statusCode).toBe(200);
  const document=example();document.description='Versão atualizada';
  expect((await call(admin,'PUT',`/api/courses/manage/${id}`,{expectedRevision:1,document})).statusCode).toBe(200);
  const second=await publish(admin,id,2);
  expect((await call(admin,'POST',`/api/courses/manage/${id}/assign`,{versionId:second.id,classId})).statusCode).toBe(200);
  expect((await call(admin,'POST',`/api/education/classes/${classId}/enrollments`,{studentId:next.userId})).statusCode).toBe(201);
  expect((await call(previous,'GET',`/api/courses/${id}`)).json().version).toBe(1);
  expect((await call(next,'GET',`/api/courses/${id}`)).json().version).toBe(2);
  expect((await call(admin,'POST',`/api/courses/manage/${id}/archive`)).statusCode).toBe(200);
  expect((await call(admin,'POST',`/api/education/classes/${classId}/enrollments`,{studentId:late.userId})).statusCode).toBe(201);
  expect((await call(late,'GET','/api/courses')).json().courses).toEqual([]);
  expect((await call(previous,'GET',`/api/courses/${id}`)).statusCode).toBe(200);
 });
 it('isola editor, versões e atribuições entre organizações e papéis',async()=>{const admin=await actor();const stranger=await actor();const school=await actor('school',admin.orgId);const id=await draft(admin);const version=await publish(admin,id);expect((await call(stranger,'GET',`/api/courses/manage/${id}`)).statusCode).toBe(404);expect((await call(school,'POST','/api/courses/manage',{title:'Proibido'})).statusCode).toBe(403);expect((await call(admin,'POST',`/api/courses/manage/${id}/assign`,{versionId:version.id,studentId:stranger.userId})).statusCode).toBe(404);});
 it('permite acompanhamento sem texto de aula e desliga cursos preservando dados',async()=>{const admin=await actor();const student=await actor('student',admin.orgId);const document=example();document.modules[0].units[0].mode='tracking';document.modules[0].units[0].bodyMarkdown='';const id=await draft(admin,document);const version=await publish(admin,id);await call(admin,'POST',`/api/courses/manage/${id}/assign`,{versionId:version.id,studentId:student.userId});await db.query('UPDATE orgs SET settings=$2 WHERE id=$1',[admin.orgId,{coursesEnabled:false}]);expect((await call(student,'GET','/api/courses')).json()).toEqual({enabled:false,courses:[]});expect((await call(student,'GET',`/api/courses/${id}`)).statusCode).toBe(403);expect((await db.query('SELECT id FROM course_enrollments WHERE student_id=$1',[student.userId])).rowCount).toBe(1);});
 it('copia a base sem alterar o original e aceita manutenção pelo backoffice',async()=>{const native=await actor('org_admin',randomUUID(),'matraca');const admin=await actor();const operator=await actor('operator',randomUUID(),'backoffice');const id=await draft(native);await publish(native,id);const copied=await call(admin,'POST','/api/courses/manage',{title:'Curso do parceiro',copyBaseCourseId:id});expect(copied.statusCode).toBe(201);const copyId=copied.json().course.id;expect(copyId).not.toBe(id);expect(copied.json().course.draft.modules).toEqual(example().modules);const view=await call(operator,'GET',`/api/backoffice/courses/${admin.orgId}/${copyId}`);expect(view.statusCode).toBe(200);expect((await call(admin,'GET',`/api/backoffice/courses/${native.orgId}/${id}`)).statusCode).toBe(403);});

 it('protege anexo staged, transmite ranges e copia objeto para a organização de destino',async()=>{
  const native=await actor('org_admin',randomUUID(),'matraca');const student=await actor('student',native.orgId);const partner=await actor();const id=await draft(native);
  const boundary=`asset-${randomUUID()}`;const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMQkdP4DwAB/gFaYeIFNgAAAABJRU5ErkJggg==','base64');
  const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slide.png"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const upload=await app.inject({method:'POST',url:`/api/courses/manage/${id}/assets`,headers:{host:native.host,cookie:native.cookie,'x-matraca-request':'1','content-type':`multipart/form-data; boundary=${boundary}`},payload});expect(upload.statusCode).toBe(201);const assetId=upload.json().asset.id;
  const staged=await app.inject({method:'POST',url:`/api/courses/manage/${id}/assets`,headers:{host:native.host,cookie:native.cookie,'x-matraca-request':'1','content-type':`multipart/form-data; boundary=${boundary}`},payload});expect(staged.statusCode).toBe(201);
  expect((await call(student,'GET',`/api/course-assets/${assetId}`)).statusCode).toBe(403);
  const document=example();document.modules[0].units[0].assetIds=[assetId];await call(native,'PUT',`/api/courses/manage/${id}`,{expectedRevision:1,document});const version=await publish(native,id,2);await call(native,'POST',`/api/courses/manage/${id}/assign`,{versionId:version.id,studentId:student.userId});
  expect((await call(student,'GET',`/api/courses/${id}`)).json().assets).toEqual([{id:assetId,filename:'slide.png',mimeType:'image/png',size:png.length}]);
  expect((await call(student,'GET',`/api/course-assets/${staged.json().asset.id}`)).statusCode).toBe(403);
  const range=await app.inject({method:'GET',url:`/api/course-assets/${assetId}`,headers:{host:student.host,cookie:student.cookie,range:'bytes=0-7'}});expect(range.statusCode).toBe(206);expect(range.rawPayload).toEqual(png.subarray(0,8));expect(range.headers['content-range']).toBe(`bytes 0-7/${png.length}`);
  expect((await app.inject({method:'GET',url:`/api/course-assets/${assetId}`,headers:{host:student.host,cookie:student.cookie,range:'bytes=999999-'}})).statusCode).toBe(416);
  expect((await call(partner,'GET',`/api/course-assets/${assetId}`)).statusCode).toBe(404);
  const copy=await call(partner,'POST','/api/courses/manage',{title:'Cópia com material',copyBaseCourseId:id});expect(copy.statusCode).toBe(201);const newAsset=copy.json().course.draft.modules[0].units[0].assetIds[0];expect(newAsset).not.toBe(assetId);const downloaded=await call(partner,'GET',`/api/course-assets/${newAsset}`);expect(downloaded.statusCode).toBe(200);expect(downloaded.rawPayload).toEqual(png);
  await db.query("UPDATE course_enrollments SET status='cancelled' WHERE course_id=$1 AND student_id=$2",[id,student.userId]);
  expect((await call(student,'GET','/api/courses')).json().courses).toEqual([]);
  expect((await call(student,'GET',`/api/courses/${id}`)).statusCode).toBe(404);
  expect((await call(student,'GET',`/api/course-assets/${assetId}`)).statusCode).toBe(403);
  await db.query("UPDATE course_enrollments SET status='completed',completed_at=now() WHERE course_id=$1 AND student_id=$2",[id,student.userId]);
  expect((await call(student,'GET',`/api/courses/${id}`)).statusCode).toBe(200);
  expect((await call(student,'GET',`/api/course-assets/${assetId}`)).statusCode).toBe(200);
 });
 it('rejeita imagem truncada que conserva cabeçalho legível sem manter objeto ou registro',async()=>{
  const admin=await actor();const id=await draft(admin);const boundary=`asset-${randomUUID()}`;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMQkdP4DwAB/gFaYeIFNgAAAABJRU5ErkJggg==','base64').subarray(0,70);
  const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="truncated.png"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const response=await app.inject({method:'POST',url:`/api/courses/manage/${id}/assets`,headers:{host:admin.host,cookie:admin.cookie,'x-matraca-request':'1','content-type':`multipart/form-data; boundary=${boundary}`},payload});
  expect(response.statusCode).toBe(400);
  expect((await db.query('SELECT id FROM course_assets WHERE org_id=$1',[admin.orgId])).rowCount).toBe(0);
  expect(await readdir(join(root,'objects','course-assets',admin.orgId))).toEqual([]);
 });
 it('seed inicial publica duas cópias completas e repetir preserva alterações',async()=>{const ids=new Map<string,string>();const stable=(key:string)=>{if(!ids.has(key))ids.set(key,randomUUID());return ids.get(key)!;};for(const slug of ['matraca','parceiro']){const orgId=randomUUID();await db.query('INSERT INTO orgs(id,slug,name,kind) VALUES($1,$2,$2,$3)',[orgId,slug,slug==='matraca'?'matraca':'partner']);await actor('student',orgId,slug==='matraca'?'matraca':'partner');}await db.transaction(client=>seedCourses(client,stable));const courses=await db.query('SELECT id,draft FROM courses WHERE id=ANY($1::uuid[])',[[stable('course:matraca:base'),stable('course:parceiro:base')]]);expect(courses.rowCount).toBe(2);expect(courses.rows.every(row=>row.draft.modules.length===12)).toBe(true);await db.query('UPDATE courses SET title=$2 WHERE id=$1',[stable('course:parceiro:base'),'Edição preservada']);await db.transaction(client=>seedCourses(client,stable));expect((await db.query('SELECT title FROM courses WHERE id=$1',[stable('course:parceiro:base')])).rows[0].title).toBe('Edição preservada');});
});
