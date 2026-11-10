import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { requireStudentScope } from '../server/education.js';

interface Actor { orgId: string; userId: string; host: string; cookie: string }
interface School { id: string; name: string; status: string }
interface Person { id: string; name: string; roles: string[]; schoolId: string | null }
interface Class { id: string; name: string; status: string }
const headers = (actor: Actor) => ({ host: actor.host, origin: `http://${actor.host}`, cookie: actor.cookie, 'x-matraca-request': '1' });
const base = '/api/education';

describe('gestão escolar e autorização atual do aluno', () => {
  let app: FastifyInstance;
  let controlDb: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let root: string;
  const schema = `education_test_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'matraca-education-'));
    const originalUrl = process.env.DATABASE_URL ?? localDatabaseUrl;
    controlDb = createDatabase(originalUrl);
    await controlDb.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(originalUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const databaseUrl = url.toString();
    db = createDatabase(databaseUrl);
    const migrations = new URL('../server/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await db.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    app = await createApp({ databaseUrl, storageRoot: join(root, 'objects') });
    // Test harness only: exercises the exported guard used by future protected resources.
    app.get<{ Params: { studentId: string } }>('/api/test/student-scope/:studentId', async request => {
      await requireStudentScope(request, request.params.studentId);
      return { allowed: true };
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (controlDb) {
      try { await controlDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await controlDb.close(); }
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function actor(orgId: string, host: string, userId: string): Promise<Actor> {
    await db.query("UPDATE users SET status='active' WHERE id=$1 AND org_id=$2", [userId, orgId]);
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO sessions (org_id,user_id,hostname,token_hash,expires_at) VALUES ($1,$2,$3,$4,now()+interval '1 hour')", [orgId, userId, host, createHash('sha256').update(token).digest('hex')]);
    return { orgId, userId, host, cookie: `matraca_session=${token}` };
  }

  async function organization(): Promise<Actor> {
    const orgId = randomUUID(), userId = randomUUID();
    const slug = `test-${randomUUID().slice(0, 8)}`;
    const host = `${slug}.matraca.localhost`;
    await db.query("INSERT INTO orgs (id,slug,name,kind) VALUES ($1,$2,'Rede sintética','partner')", [orgId, slug]);
    await db.query('INSERT INTO domains (hostname,org_id) VALUES ($1,$2)', [host, orgId]);
    await db.query("INSERT INTO users (id,org_id,email,name,roles,status) VALUES ($1,$2,$3,'Admin teste',ARRAY['org_admin'],'active')", [userId, orgId, `${randomUUID()}@example.test`]);
    return actor(orgId, host, userId);
  }

  const get = (current: Actor, path: string) => app.inject({ method: 'GET', url: `${base}${path}`, headers: headers(current) });
  const post = (current: Actor, path: string, payload: object) => app.inject({ method: 'POST', url: `${base}${path}`, headers: headers(current), payload });
  const patch = (current: Actor, path: string, payload: object) => app.inject({ method: 'PATCH', url: `${base}${path}`, headers: headers(current), payload });
  const end = (current: Actor, path: string) => app.inject({ method: 'DELETE', url: `${base}${path}`, headers: headers(current) });
  const scope = (current: Actor, studentId: string) => app.inject({ method: 'GET', url: `/api/test/student-scope/${studentId}`, headers: headers(current) });

  async function school(admin: Actor, name = 'Escola teste'): Promise<School> {
    const response = await post(admin, '/schools', { name, city: 'Cidade teste', state: 'SP' });
    expect(response.statusCode).toBe(201);
    return response.json().school;
  }

  async function person(admin: Actor, roles: string[], schoolId?: string): Promise<Person> {
    const response = await post(admin, '/people', { name: 'Pessoa teste', email: `${randomUUID()}@example.test`, roles, ...(schoolId ? { schoolId } : {}) });
    expect(response.statusCode).toBe(201);
    return response.json().person;
  }

  async function classroom(admin: Actor, schoolId: string, name = 'Turma teste'): Promise<Class> {
    const response = await post(admin, '/classes', { schoolId, name });
    expect(response.statusCode).toBe(201);
    return response.json().class;
  }

  async function schoolActor(admin: Actor, schoolId: string, role = 'school') {
    const created = await person(admin, [role], schoolId);
    return actor(admin.orgId, admin.host, created.id);
  }

  async function taughtStudent() {
    const admin = await organization();
    const location = await school(admin);
    const student = await person(admin, ['student'], location.id);
    const teacher = await person(admin, ['teacher'], location.id);
    const teacherActor = await actor(admin.orgId, admin.host, teacher.id);
    const classroomValue = await classroom(admin, location.id);
    expect((await post(admin, `/classes/${classroomValue.id}/enrollments`, { studentId: student.id })).statusCode).toBe(201);
    expect((await patch(admin, `/teachers/${teacher.id}`, { approvalStatus: 'approved', certifications: [{ name: 'Certificação teste', issuer: 'Rede teste' }] })).statusCode).toBe(200);
    expect((await post(admin, `/classes/${classroomValue.id}/teachers`, { teacherId: teacher.id })).statusCode).toBe(201);
    expect((await scope(teacherActor, student.id)).statusCode).toBe(200);
    return { admin, location, student, teacher, teacherActor, classroom: classroomValue };
  }

  it('escolas possuem criação, busca, paginação, edição e arquivamento sem exclusão', async () => {
    const admin = await organization();
    const locations = await Promise.all(['Campus A', 'Campus B', 'Campus C'].map(name => school(admin, name)));
    const first = await get(admin, '/schools?search=Campus&page=1&pageSize=2');
    const second = await get(admin, '/schools?search=Campus&page=2&pageSize=2');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(first.json().items.length).toBe(2);
    expect(second.json().items.length).toBe(1);
    const ids = [...first.json().items, ...second.json().items].map((item: School) => item.id);
    expect(new Set(ids).size).toBe(3);
    expect((await patch(admin, `/schools/${locations[0].id}`, { name: 'Campus editado', city: 'Outra cidade', status: 'archived' })).statusCode).toBe(200);
    const archived = await get(admin, '/schools?status=archived');
    expect(archived.json().items.some((item: School) => item.id === locations[0].id && item.name === 'Campus editado')).toBe(true);
    expect((await db.query('SELECT id FROM schools WHERE id=$1 AND org_id=$2', [locations[0].id, admin.orgId])).rowCount).toBe(1);
    expect((await get(admin, '/schools?page=0&pageSize=10000')).statusCode).toBe(400);
  });

  it('gestor escolar enxerga sua escola e não cria escolas nem eleva papéis ou aprova professores', async () => {
    const admin = await organization();
    const first = await school(admin, 'Primeira'), second = await school(admin, 'Segunda');
    const manager = await schoolActor(admin, first.id);
    const teacher = await person(admin, ['teacher'], first.id);
    const list = await get(manager, '/schools');
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item: School) => item.id)).toEqual([first.id]);
    expect((await post(manager, '/schools', { name: 'Indevida' })).statusCode).toBe(403);
    expect((await post(manager, '/people', { name: 'Admin indevido', email: `${randomUUID()}@example.test`, roles: ['org_admin'], schoolId: first.id })).statusCode).toBe(403);
    expect((await post(manager, '/people', { name: 'Papéis mistos', email: `${randomUUID()}@example.test`, roles: ['student', 'org_admin'], schoolId: first.id })).statusCode).toBe(403);
    expect((await post(manager, '/people', { name: 'Aluno alheio', email: `${randomUUID()}@example.test`, roles: ['student'], schoolId: second.id })).statusCode).toBe(403);
    expect((await patch(manager, `/teachers/${teacher.id}`, { approvalStatus: 'approved' })).statusCode).toBe(403);
    expect((await patch(manager, `/people/${teacher.id}`, { status: 'suspended' })).statusCode).toBe(403);
    expect((await post(manager, `/people/${teacher.id}/archive`, {})).statusCode).toBe(403);
    expect((await post(manager, `/schools/${first.id}/staff`, { userId: teacher.id, role: 'school' })).statusCode).toBe(403);
    expect((await get(manager, '/people')).json().items.some((item: Person) => item.roles.includes('org_admin'))).toBe(false);
  });

  it('gestor cadastra alunos e professores locais e gerencia turma e matrícula próprias', async () => {
    const admin = await organization();
    const location = await school(admin);
    const manager = await schoolActor(admin, location.id);
    const student = await person(manager, ['student'], location.id);
    const teacher = await person(manager, ['teacher'], location.id);
    const group = await classroom(manager, location.id);
    expect((await post(manager, `/classes/${group.id}/enrollments`, { studentId: student.id })).statusCode).toBe(201);
    expect((await get(manager, `/people/${teacher.id}`)).json().person.teacherProfile.approvalStatus).toBe('pending');
    expect((await scope(manager, student.id)).statusCode).toBe(200);
    expect((await patch(manager, `/people/${student.id}`, { name: 'Aluno atualizado', profile: { objective: 'Clareza' } })).statusCode).toBe(200);
  });

  it('aluno participa de duas turmas e encerramento preserva matrícula histórica', async () => {
    const admin = await organization();
    const location = await school(admin);
    const student = await person(admin, ['student'], location.id);
    const first = await classroom(admin, location.id, 'Primeira turma');
    const second = await classroom(admin, location.id, 'Segunda turma');
    expect((await post(admin, `/classes/${first.id}/enrollments`, { studentId: student.id })).statusCode).toBe(201);
    expect((await post(admin, `/classes/${second.id}/enrollments`, { studentId: student.id })).statusCode).toBe(201);
    expect((await patch(admin, `/classes/${first.id}`, { status: 'closed' })).statusCode).toBe(200);
    const firstView = await get(admin, `/classes/${first.id}`);
    const secondView = await get(admin, `/classes/${second.id}`);
    expect(firstView.json().enrollments.some((item: { studentId: string; status: string }) => item.studentId === student.id && item.status === 'completed')).toBe(true);
    expect(secondView.json().enrollments.some((item: { studentId: string; status: string }) => item.studentId === student.id && item.status === 'active')).toBe(true);
    const another = await person(admin, ['student'], location.id);
    expect((await post(admin, `/classes/${first.id}/enrollments`, { studentId: another.id })).statusCode).toBe(409);
  });

  it('professor precisa de aprovação e atribuição à turma para acessar aluno', async () => {
    const admin = await organization();
    const location = await school(admin);
    const student = await person(admin, ['student'], location.id);
    const teacher = await person(admin, ['teacher'], location.id);
    const teacherActor = await actor(admin.orgId, admin.host, teacher.id);
    const group = await classroom(admin, location.id);
    expect((await post(admin, `/classes/${group.id}/enrollments`, { studentId: student.id })).statusCode).toBe(201);
    expect((await scope(teacherActor, student.id)).statusCode).toBe(403);
    expect((await post(admin, `/classes/${group.id}/teachers`, { teacherId: teacher.id })).statusCode).toBe(409);
    const approved = await patch(admin, `/teachers/${teacher.id}`, { approvalStatus: 'approved', certifications: [{ name: 'Curso da rede', issuer: 'Organização', issuedOn: '2026-01-10' }] });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().teacher.certifications[0].name).toBe('Curso da rede');
    expect((await scope(teacherActor, student.id)).statusCode).toBe(403);
    expect((await post(admin, `/classes/${group.id}/teachers`, { teacherId: teacher.id })).statusCode).toBe(201);
    expect((await scope(teacherActor, student.id)).statusCode).toBe(200);
    const unassigned = await person(admin, ['student'], location.id);
    expect((await scope(teacherActor, unassigned.id)).statusCode).toBe(403);
  });

  it('matrículas concorrentes não duplicam o vínculo ativo', async () => {
    const admin = await organization();
    const location = await school(admin);
    const student = await person(admin, ['student'], location.id);
    const group = await classroom(admin, location.id);
    const responses = await Promise.all([
      post(admin, `/classes/${group.id}/enrollments`, { studentId: student.id }),
      post(admin, `/classes/${group.id}/enrollments`, { studentId: student.id }),
    ]);
    expect(responses.some(response => response.statusCode === 201)).toBe(true);
    expect(responses.every(response => [200, 201, 409].includes(response.statusCode))).toBe(true);
    const active = await db.query("SELECT id FROM enrollments WHERE org_id=$1 AND class_id=$2 AND student_id=$3 AND status='active'", [admin.orgId, group.id, student.id]);
    expect(active.rowCount).toBe(1);
  });

  it.each(['approval', 'assignment', 'school', 'user'] as const)('revogação %s remove imediatamente o acesso do professor', async reason => {
    const fixture = await taughtStudent();
    if (reason === 'approval') expect((await patch(fixture.admin, `/teachers/${fixture.teacher.id}`, { approvalStatus: 'suspended' })).statusCode).toBe(200);
    if (reason === 'assignment') expect((await end(fixture.admin, `/classes/${fixture.classroom.id}/teachers/${fixture.teacher.id}`)).statusCode).toBe(204);
    if (reason === 'school') expect((await end(fixture.admin, `/schools/${fixture.location.id}/staff/${fixture.teacher.id}`)).statusCode).toBe(204);
    if (reason === 'user') expect((await patch(fixture.admin, `/people/${fixture.teacher.id}`, { status: 'suspended' })).statusCode).toBe(200);
    expect((await scope(fixture.teacherActor, fixture.student.id)).statusCode).toBe(reason === 'user' ? 401 : 403);
  });

  it('transferência preserva identidade e histórico e troca imediatamente os escopos escolares', async () => {
    const fixture = await taughtStudent();
    const destination = await school(fixture.admin, 'Destino');
    const oldManager = await schoolActor(fixture.admin, fixture.location.id);
    const newManager = await schoolActor(fixture.admin, destination.id);
    const studentActor = await actor(fixture.admin.orgId, fixture.admin.host, fixture.student.id);
    const type = await post(fixture.admin, '/group-types', { name: 'Grupo de acompanhamento' });
    const typeId = type.json().groupType.id;
    const oldGroup = await post(fixture.admin, '/groups', { name: 'Grupo da escola antiga', typeId, schoolId: fixture.location.id });
    const organizationGroup = await post(fixture.admin, '/groups', { name: 'Grupo da organização', typeId });
    expect((await post(fixture.admin, `/groups/${oldGroup.json().group.id}/members`, { userId: fixture.student.id })).statusCode).toBe(201);
    expect((await post(fixture.admin, `/groups/${organizationGroup.json().group.id}/members`, { userId: fixture.student.id })).statusCode).toBe(201);
    expect((await scope(oldManager, fixture.student.id)).statusCode).toBe(200);
    expect((await scope(newManager, fixture.student.id)).statusCode).toBe(403);
    const moved = await post(fixture.admin, `/students/${fixture.student.id}/transfer`, { schoolId: destination.id, reason: 'Mudança de unidade' });
    expect(moved.statusCode).toBe(200);
    const details = await get(fixture.admin, `/people/${fixture.student.id}`);
    expect(details.json().person.id).toBe(fixture.student.id);
    expect(details.json().person.schoolId).toBe(destination.id);
    expect(details.json().schoolHistory.map((item: { schoolId: string }) => item.schoolId)).toEqual(expect.arrayContaining([fixture.location.id, destination.id]));
    expect(details.json().enrollments.some((item: { classId: string }) => item.classId === fixture.classroom.id)).toBe(true);
    expect((await scope(oldManager, fixture.student.id)).statusCode).toBe(403);
    expect((await scope(fixture.teacherActor, fixture.student.id)).statusCode).toBe(403);
    expect((await scope(newManager, fixture.student.id)).statusCode).toBe(200);
    expect((await scope(studentActor, fixture.student.id)).statusCode).toBe(200);
    expect((await get(oldManager, `/people/${fixture.student.id}`)).statusCode).toBe(403);
    for (const previousActor of [oldManager, fixture.teacherActor]) {
      const previousRoster = await get(previousActor, `/classes/${fixture.classroom.id}`);
      expect(previousRoster.statusCode).toBe(200);
      expect(previousRoster.json().enrollments.some((item: { studentId: string }) => item.studentId === fixture.student.id)).toBe(false);
      const previousList = await get(previousActor, '/people?role=student');
      expect(previousList.json().items.some((item: Person) => item.id === fixture.student.id)).toBe(false);
    }
    const priorClass = await get(fixture.admin, `/classes/${fixture.classroom.id}`);
    expect(priorClass.json().enrollments.some((item: { studentId: string; status: string }) => item.studentId === fixture.student.id && item.status !== 'active')).toBe(true);
    const memberships = await db.query('SELECT group_id,ended_at FROM group_memberships WHERE org_id=$1 AND user_id=$2', [fixture.admin.orgId, fixture.student.id]);
    expect(memberships.rows.find(row => row.group_id === oldGroup.json().group.id)?.ended_at).toBeInstanceOf(Date);
    expect(memberships.rows.find(row => row.group_id === organizationGroup.json().group.id)?.ended_at).toBeNull();
    expect((await post(newManager, `/students/${fixture.student.id}/transfer`, { schoolId: fixture.location.id })).statusCode).toBe(403);
  });

  it('IDs de outra organização não permitem ler, matricular, atribuir ou transferir', async () => {
    const first = await organization(), second = await organization();
    const firstSchool = await school(first), secondSchool = await school(second);
    const localClass = await classroom(first, firstSchool.id);
    const foreignStudent = await person(second, ['student'], secondSchool.id);
    const foreignTeacher = await person(second, ['teacher'], secondSchool.id);
    const localStudent = await person(first, ['student'], firstSchool.id);
    expect((await get(first, `/people/${foreignStudent.id}`)).statusCode).toBe(404);
    expect((await scope(first, foreignStudent.id)).statusCode).toBe(404);
    expect((await post(first, `/classes/${localClass.id}/enrollments`, { studentId: foreignStudent.id })).statusCode).toBe(404);
    expect((await post(first, `/classes/${localClass.id}/teachers`, { teacherId: foreignTeacher.id })).statusCode).toBe(404);
    expect((await post(first, `/students/${localStudent.id}/transfer`, { schoolId: secondSchool.id })).statusCode).toBe(404);
    expect((await patch(first, `/schools/${secondSchool.id}`, { name: 'Indevido' })).statusCode).toBe(404);
  });

  it('arquivamento mantém pessoa e histórico, revogando sua sessão', async () => {
    const admin = await organization();
    const location = await school(admin);
    const student = await person(admin, ['student'], location.id);
    const studentActor = await actor(admin.orgId, admin.host, student.id);
    expect((await post(admin, `/people/${student.id}/archive`, {})).statusCode).toBe(200);
    expect((await scope(studentActor, student.id)).statusCode).toBe(401);
    expect((await db.query('SELECT id FROM users WHERE id=$1 AND org_id=$2', [student.id, admin.orgId])).rowCount).toBe(1);
  });

  it('último administrador ativo não remove o próprio acesso', async () => {
    const admin = await organization();
    expect((await patch(admin, `/people/${admin.userId}`, { roles: ['student'] })).statusCode).toBe(409);
    expect((await patch(admin, `/people/${admin.userId}`, { status: 'suspended' })).statusCode).toBe(409);
    expect((await post(admin, `/people/${admin.userId}/archive`, {})).statusCode).toBe(409);
    expect((await post(admin, '/schools', { name: 'Acesso preservado' })).statusCode).toBe(201);
  });

  it('grupos rejeitam pai de outra organização e ciclos sem alterar hierarquia', async () => {
    const first = await organization(), second = await organization();
    const firstType = await post(first, '/group-types', { name: 'Região', position: 1 });
    const secondType = await post(second, '/group-types', { name: 'Região', position: 1 });
    expect(firstType.statusCode).toBe(201);
    expect(secondType.statusCode).toBe(201);
    const typeId = firstType.json().groupType.id;
    const parent = await post(first, '/groups', { name: 'Estado', typeId });
    const child = await post(first, '/groups', { name: 'Cidade', typeId, parentId: parent.json().group.id });
    const foreign = await post(second, '/groups', { name: 'Outra região', typeId: secondType.json().groupType.id });
    expect(parent.statusCode).toBe(201);
    expect(child.statusCode).toBe(201);
    expect(foreign.statusCode).toBe(201);
    expect((await post(first, '/groups', { name: 'Pai estrangeiro', typeId, parentId: foreign.json().group.id })).statusCode).toBe(404);
    const cycle = await patch(first, `/groups/${parent.json().group.id}`, { parentId: child.json().group.id });
    expect([400, 409]).toContain(cycle.statusCode);
    const groups = await get(first, '/groups');
    expect(groups.json().items.find((item: { id: string }) => item.id === parent.json().group.id).parentId).toBeNull();
    expect((await post(first, '/groups', { name: 'Tipo estrangeiro', typeId: secondType.json().groupType.id })).statusCode).toBe(404);
  });

  it('chaves compostas também impedem vínculos entre organizações no banco', async () => {
    const first = await organization(), second = await organization();
    const localSchool = await school(first), foreignSchool = await school(second);
    const localStudent = await person(first, ['student'], localSchool.id);
    const foreignStudent = await person(second, ['student'], foreignSchool.id);
    const group = await classroom(first, localSchool.id);
    await expect(db.query('INSERT INTO school_staff (org_id,school_id,user_id,role) VALUES ($1,$2,$3,$4)', [first.orgId, foreignSchool.id, localStudent.id, 'teacher'])).rejects.toMatchObject({ code: '23503' });
    await expect(db.query('INSERT INTO enrollments (org_id,class_id,school_id,student_id) VALUES ($1,$2,$3,$4)', [first.orgId, group.id, localSchool.id, foreignStudent.id])).rejects.toMatchObject({ code: '23503' });
    const otherLocalSchool = await school(first);
    await expect(db.query('INSERT INTO enrollments (org_id,class_id,school_id,student_id) VALUES ($1,$2,$3,$4)', [first.orgId, group.id, otherLocalSchool.id, localStudent.id])).rejects.toMatchObject({ code: '23503' });
    const type = await post(first, '/group-types', { name: 'Tipo local' });
    const foreignType = await post(second, '/group-types', { name: 'Tipo externo' });
    const foreignGroup = await post(second, '/groups', { name: 'Pai externo', typeId: foreignType.json().groupType.id });
    await expect(db.query('INSERT INTO education_groups (org_id,type_id,parent_id,name) VALUES ($1,$2,$3,$4)', [first.orgId, type.json().groupType.id, foreignGroup.json().group.id, 'Filho indevido'])).rejects.toMatchObject({ code: '23503' });
  });

  it('mudanças concorrentes de pai não criam ciclo entre dois grupos', async () => {
    const admin = await organization();
    const type = await post(admin, '/group-types', { name: 'Nível' });
    const typeId = type.json().groupType.id;
    const first = (await post(admin, '/groups', { name: 'A', typeId })).json().group;
    const second = (await post(admin, '/groups', { name: 'B', typeId })).json().group;
    const results = await Promise.all([
      patch(admin, `/groups/${first.id}`, { parentId: second.id }),
      patch(admin, `/groups/${second.id}`, { parentId: first.id }),
    ]);
    expect(results.filter(result => result.statusCode === 200).length).toBe(1);
    expect(results.filter(result => [400, 409].includes(result.statusCode)).length).toBe(1);
    const groups = (await get(admin, '/groups')).json().items;
    const firstParent = groups.find((group: { id: string }) => group.id === first.id).parentId;
    const secondParent = groups.find((group: { id: string }) => group.id === second.id).parentId;
    expect(firstParent === second.id && secondParent === first.id).toBe(false);
  });

  it.each(['suspended', 'role', 'logout'] as const)('requisição enfileirada revalida autorização após revogação %s', async change => {
    const admin = await organization();
    const blocker = await db.pool.connect();
    let pending: ReturnType<typeof post> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [admin.orgId]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = post(admin, '/schools', { name: 'Não deve ser criada' });
      let queued = false;
      for (let attempt = 0; attempt < 200 && !queued; attempt++) {
        const result = await controlDb.query<{ queued: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM pg_locks held JOIN pg_locks waiting
            ON held.locktype=waiting.locktype AND held.database IS NOT DISTINCT FROM waiting.database
            AND held.classid=waiting.classid AND held.objid=waiting.objid AND held.objsubid=waiting.objsubid
          WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted AND NOT waiting.granted
        ) AS queued`, [pid]);
        queued = result.rows[0].queued;
        if (!queued) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(queued).toBe(true);
      if (change === 'suspended') await blocker.query("UPDATE users SET status='suspended' WHERE id=$1", [admin.userId]);
      if (change === 'role') await blocker.query("UPDATE users SET roles=ARRAY['student'] WHERE id=$1", [admin.userId]);
      if (change === 'logout') {
        const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers(admin) });
        expect(logout.statusCode).toBe(204);
      }
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.statusCode).toBe(change === 'role' ? 403 : 401);
      expect((await db.query('SELECT id FROM schools WHERE org_id=$1', [admin.orgId])).rowCount).toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending?.catch(() => {});
    }
  });
});
