import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { registerMentoring } from '../server/mentoring.js';
import { consumeReservation, getWallet, grantCredits, reserveCredits } from '../server/wallet.js';
import type { EvaluationContext } from '../server/evaluation/provider.js';

interface Actor { orgId: string; userId: string; host: string; cookie: string }
const headers = (actor: Actor) => ({ host: actor.host, cookie: actor.cookie, 'x-matraca-request': '1', origin: `http://${actor.host}` });
const sessionInput = () => ({ clientKey: randomUUID(), occurredAt: '2026-11-10T15:00:00-03:00', difficulties: ['Organizar ideias.'], guidance: 'Defina uma mensagem principal.', actions: ['Gravar uma nova tentativa.'], followUpOn: '2026-11-20' });
const planInput = () => ({ clientKey: randomUUID(), kind: 'task', title: 'Praticar mensagem principal', description: 'Gravar três tentativas.', dueOn: '2026-11-20' });

describe('mentorias, revisão humana e plano individual', () => {
  const schema = `mentoring_test_${randomUUID().replaceAll('-', '')}`;
  let app: FastifyInstance, db: ReturnType<typeof createDatabase>, control: ReturnType<typeof createDatabase>, root: string;
  beforeAll(async () => {
    const base = process.env.DATABASE_URL ?? localDatabaseUrl; control = createDatabase(base);
    await control.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base); url.searchParams.set('options', `-c search_path=${schema}`); db = createDatabase(url.toString());
    const migrations = new URL('../server/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(name, migrations), 'utf8'));
    root = await mkdtemp(join(tmpdir(), 'matraca-mentoring-')); app = await createApp({ databaseUrl: url.toString(), storageRoot: join(root, 'objects') });
    if (!app.hasRoute({ method: 'GET', url: '/api/mentoring/students' })) await registerMentoring(app);
  });
  afterAll(async () => {
    await app?.close(); await db?.close();
    if (control) { try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); } }
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function actor(role: string, orgId: string = randomUUID()): Promise<Actor> {
    const host = `mentoring-${orgId}.localhost`;
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,$2,'Mentoria sintética','partner') ON CONFLICT DO NOTHING", [orgId, `mentoring-${orgId}`]);
    await db.query('INSERT INTO domains(hostname,org_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [host, orgId]);
    const userId = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO users(id,org_id,name,email,roles,status) VALUES($1,$2,'Pessoa sintética',$3,$4,'active')", [userId, orgId, `${userId}@example.test`, [role]]);
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [orgId, userId, host, createHash('sha256').update(token).digest('hex')]);
    return { orgId, userId, host, cookie: `matraca_session=${token}` };
  }
  const get = (who: Actor, url: string) => app.inject({ method: 'GET', url, headers: headers(who) });
  const post = (who: Actor, url: string, payload: object) => app.inject({ method: 'POST', url, headers: headers(who), payload });
  const patch = (who: Actor, url: string, payload: object) => app.inject({ method: 'PATCH', url, headers: headers(who), payload });
  const studentPath = (student: Actor, suffix = '') => `/api/mentoring/students/${student.userId}${suffix}`;
  async function fixture() {
    const admin = await actor('org_admin'), student = await actor('student', admin.orgId), teacher = await actor('teacher', admin.orgId), manager = await actor('school', admin.orgId);
    const schoolId = randomUUID(), classId = randomUUID();
    await db.query("INSERT INTO schools(id,org_id,name) VALUES($1,$2,'Escola')", [schoolId, admin.orgId]);
    await db.query("INSERT INTO classes(id,org_id,school_id,name) VALUES($1,$2,$3,'Turma')", [classId, admin.orgId, schoolId]);
    await db.query('INSERT INTO student_schools(org_id,school_id,student_id) VALUES($1,$2,$3)', [admin.orgId, schoolId, student.userId]);
    await db.query('INSERT INTO enrollments(org_id,school_id,class_id,student_id) VALUES($1,$2,$3,$4)', [admin.orgId, schoolId, classId, student.userId]);
    for (const [member, role] of [[teacher, 'teacher'], [manager, 'school']] as const) await db.query('INSERT INTO school_staff(org_id,school_id,user_id,role) VALUES($1,$2,$3,$4)', [admin.orgId, schoolId, member.userId, role]);
    await db.query("INSERT INTO teacher_profiles(org_id,user_id,approval_status) VALUES($1,$2,'approved')", [admin.orgId, teacher.userId]);
    await db.query('INSERT INTO teacher_class_assignments(org_id,school_id,class_id,teacher_id) VALUES($1,$2,$3,$4)', [admin.orgId, schoolId, classId, teacher.userId]);
    return { admin, student, teacher, manager, schoolId, classId };
  }
  async function evaluation(student: Actor) {
    const recordingId = randomUUID(), evaluationId = randomUUID();
    const context: EvaluationContext = { requestId: evaluationId, recording: { id: recordingId, durationMicroseconds: 30_000_000, hasAudio: true, hasVideo: false },
      objective: 'Mensagem principal', purpose: 'free', rubricVersion: 'free-v1', learner: {}, recentResults: [], criteria: [
        { id: 'clarity', title: 'Clareza', weight: 1, modality: 'both', descriptors: ['Inicial', 'Parcial', 'Consistente', 'Flexível'] },
        { id: 'posture', title: 'Postura', weight: 1, modality: 'visual', descriptors: ['Inicial', 'Parcial', 'Consistente', 'Flexível'] },
      ] };
    await db.query(`INSERT INTO recordings(id,org_id,student_id,object_key,filename,mime_type,byte_length,duration_us,has_audio,has_video,container,probe,objective,purpose,scenario,maximum_seconds,source)
      VALUES($1,$2,$3,$4,'fixture.wav','audio/wav',100,30000000,true,false,'wav','{}','Mensagem principal','free','one_on_one',300,'upload')`, [recordingId, student.orgId, student.userId, `synthetic/${recordingId}`]);
    await grantCredits(db, { ...student, amount: 3, eventKey: randomUUID(), source: 'manual', sourceRef: 'fixture', reason: 'Fixture' });
    await reserveCredits(db, { ...student, requestId: evaluationId, durationMicroseconds: 30_000_000 });
    const consumption = await consumeReservation(db, { ...student, requestId: evaluationId });
    await db.query(`INSERT INTO evaluation_requests(id,org_id,student_id,recording_id,client_key,status,scenario,context,credits,completed_at)
      VALUES($1,$2,$3,$4,$5,'completed','success',$6,1,now())`, [evaluationId, student.orgId, student.userId, recordingId, randomUUID(), context]);
    const report = { provider: 'mock', simulated: true, summary: 'Relatório IA sintético preservado.', overallLevel: 2, observations: [{ criterionId: 'clarity', level: 2 }] };
    await db.query('INSERT INTO evaluation_results(request_id,org_id,student_id,report,consumption_entry_id) VALUES($1,$2,$3,$4,$5)', [evaluationId, student.orgId, student.userId, report, consumption.consumption_entry_id]);
    return { evaluationId, recordingId, report };
  }
  const reviewInput = () => ({ clientKey: randomUUID(), summary: 'Revisão humana identificada.', observations: [{ criterionId: 'clarity', note: 'Mensagem ficou clara neste trecho.', level: 3, startUs: 0, endUs: 30_000_000 }] });

  it('painel mostra apenas alunos atribuídos, necessidades e última avaliação', async () => {
    const f = await fixture(), other = await actor('student', f.admin.orgId);
    await evaluation(f.student);
    expect((await post(f.teacher, studentPath(f.student, '/plan'), planInput())).statusCode).toBe(201);
    const list = await get(f.teacher, '/api/mentoring/students?page=1&pageSize=1');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(list.json().items[0]).toMatchObject({ id: f.student.userId, pendingItems: 1, latestLevel: 2 });
    expect(list.json().items.some((item: { id: string }) => item.id === other.userId)).toBe(false);
    expect((await get(f.student, '/api/mentoring/students')).statusCode).toBe(403);
    expect((await get(f.teacher, studentPath(f.student))).json().permissions).toMatchObject({ authorTeacher: true, managePlan: true, ownProgress: false });
  });

  it('mentoria é idempotente, append-only e corrigida por novo registro do autor', async () => {
    const f = await fixture(), input = sessionInput();
    const responses = await Promise.all([post(f.teacher, studentPath(f.student, '/sessions'), input), post(f.teacher, studentPath(f.student, '/sessions'), input)]);
    expect(responses.map(response => response.statusCode)).toEqual([201, 201]);
    const first = responses[0].json().session;
    expect(responses[1].json().session.id).toBe(first.id);
    expect(first).toMatchObject({ teacherId: f.teacher.userId, studentId: f.student.userId, followUpOn: '2026-11-20' });
    expect((await post(f.teacher, studentPath(f.student, '/sessions'), { ...input, guidance: 'Alterado' })).statusCode).toBe(409);
    expect((await post(f.teacher, studentPath(f.student, '/sessions'), { ...sessionInput(), supersedesId: first.id })).statusCode).toBe(201);
    expect((await get(f.student, studentPath(f.student, '/sessions'))).json().total).toBe(2);
    await expect(db.query("UPDATE mentoring_sessions SET guidance='Alterada' WHERE id=$1", [first.id])).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM mentoring_sessions WHERE id=$1', [first.id])).rejects.toThrow('append-only');
  });

  it('revisão humana preserva relatório IA, versão de rubrica e carteira', async () => {
    const f = await fixture(), evaluated = await evaluation(f.student), input = reviewInput();
    const balance = await getWallet(db, f.student);
    const first = await post(f.teacher, `/api/mentoring/evaluations/${evaluated.evaluationId}/reviews`, input);
    expect(first.statusCode).toBe(201);
    expect(first.json().review).toMatchObject({ teacherId: f.teacher.userId, evaluationId: evaluated.evaluationId, source: 'human' });
    expect((await post(f.teacher, `/api/mentoring/evaluations/${evaluated.evaluationId}/reviews`, input)).json().review.id).toBe(first.json().review.id);
    expect((await db.query('SELECT report FROM evaluation_results WHERE request_id=$1', [evaluated.evaluationId])).rows[0].report).toEqual(evaluated.report);
    expect(await getWallet(db, f.student)).toEqual(balance);
    await expect(db.query("UPDATE human_reviews SET summary='Alterada' WHERE id=$1", [first.json().review.id])).rejects.toThrow('append-only');
    const reviewed = await get(f.student, studentPath(f.student, '/reviews'));
    expect(reviewed.json().items[0]).toMatchObject({ teacherName: 'Pessoa sintética', source: 'human' });
  });

  it.each([
    { criterionId: 'missing', note: 'Inválida' },
    { criterionId: 'clarity', note: 'Inválida', startUs: 0 },
    { criterionId: 'clarity', note: 'Inválida', startUs: 1, endUs: 1 },
    { criterionId: 'clarity', note: 'Inválida', startUs: 0, endUs: 30_000_001 },
    { criterionId: 'posture', note: 'Inválida', level: 4 },
  ])('rejeita anotação fora da rubrica, tempo ou modalidade: %j', async invalid => {
    const f = await fixture(), evaluated = await evaluation(f.student);
    const response = await post(f.teacher, `/api/mentoring/evaluations/${evaluated.evaluationId}/reviews`, { ...reviewInput(), observations: [invalid] });
    expect(response.statusCode).toBe(400);
    expect((await get(f.student, studentPath(f.student, '/reviews'))).json().total).toBe(0);
  });

  it('somente professor aprovado e atribuído assina mentoria ou revisão', async () => {
    const f = await fixture(), evaluated = await evaluation(f.student), unassigned = await actor('teacher', f.admin.orgId);
    for (const who of [f.admin, f.manager, f.student, unassigned]) {
      expect((await post(who, studentPath(f.student, '/sessions'), sessionInput())).statusCode).toBe(403);
      expect((await post(who, `/api/mentoring/evaluations/${evaluated.evaluationId}/reviews`, reviewInput())).statusCode).toBe(403);
    }
  });

  it('plano registra orientação, resposta e progresso sem apagar versões', async () => {
    const f = await fixture(), session = (await post(f.teacher, studentPath(f.student, '/sessions'), sessionInput())).json().session;
    const input = { ...planInput(), mentoringSessionId: session.id };
    const created = await post(f.teacher, studentPath(f.student, '/plan'), input);
    expect(created.statusCode).toBe(201);
    const id = created.json().item.id;
    expect((await post(f.teacher, studentPath(f.student, '/plan'), input)).json().item.id).toBe(id);
    expect((await patch(f.manager, `/api/mentoring/plan/${id}`, { expectedRevision: 1, title: 'Objetivo revisado', dueOn: null })).statusCode).toBe(200);
    expect((await patch(f.student, `/api/mentoring/plan/${id}`, { expectedRevision: 2, status: 'completed', response: 'Gravei as três tentativas.' })).statusCode).toBe(200);
    const timeline = (await get(f.student, `/api/mentoring/plan/${id}/history`)).json();
    expect(timeline.total).toBe(3);
    expect(timeline.items[0]).toMatchObject({ revision: 3, actorId: f.student.userId, response: 'Gravei as três tentativas.', snapshot: { status: 'completed', title: 'Objetivo revisado' } });
    expect(timeline.items[2].snapshot.title).toBe(input.title);
    expect((await patch(f.student, `/api/mentoring/plan/${id}`, { expectedRevision: 3, title: 'Alteração indevida' })).statusCode).toBe(403);
    expect((await patch(f.student, `/api/mentoring/plan/${id}`, { expectedRevision: 3, status: 'cancelled' })).statusCode).toBe(403);
    expect((await post(f.student, studentPath(f.student, '/plan'), planInput())).statusCode).toBe(403);
    await expect(db.query("UPDATE individual_plan_history SET response='Alterada' WHERE item_id=$1", [id])).rejects.toThrow('append-only');
  });

  it('revisão otimista impede duas atualizações concorrentes do mesmo estado', async () => {
    const f = await fixture(), item = (await post(f.admin, studentPath(f.student, '/plan'), planInput())).json().item;
    const responses = await Promise.all([
      patch(f.student, `/api/mentoring/plan/${item.id}`, { expectedRevision: 1, status: 'in_progress' }),
      patch(f.teacher, `/api/mentoring/plan/${item.id}`, { expectedRevision: 1, title: 'Outra orientação' }),
    ]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect((await get(f.student, `/api/mentoring/plan/${item.id}/history`)).json().total).toBe(2);
  });

  it('não usa papéis cumulativos para autorizar gestão ou mentoria de si mesmo', async () => {
    const f = await fixture();
    await db.query("UPDATE users SET roles=ARRAY['student','teacher','school'] WHERE id=$1", [f.student.userId]);
    expect((await get(f.student, studentPath(f.student))).json().permissions).toEqual({ authorTeacher: false, managePlan: false, ownProgress: true });
    expect((await post(f.student, studentPath(f.student, '/sessions'), sessionInput())).statusCode).toBe(403);
    expect((await post(f.student, studentPath(f.student, '/plan'), planInput())).statusCode).toBe(403);
  });

  it('isola organizações e vincula evidência e tarefa ao mesmo aluno', async () => {
    const f = await fixture(), foreign = await actor('org_admin'), other = await actor('student', f.admin.orgId), evaluated = await evaluation(other);
    expect((await get(foreign, studentPath(f.student, '/sessions'))).statusCode).toBe(404);
    expect((await post(f.teacher, studentPath(f.student, '/sessions'), { ...sessionInput(), evaluationId: evaluated.evaluationId })).statusCode).toBe(404);
    const session = (await post(f.teacher, studentPath(f.student, '/sessions'), sessionInput())).json().session;
    expect((await post(f.admin, studentPath(other, '/plan'), { ...planInput(), mentoringSessionId: session.id })).statusCode).toBe(404);
    const plan = (await post(f.admin, studentPath(other, '/plan'), planInput())).json().item;
    await expect(db.query('UPDATE individual_plan_items SET mentoring_session_id=$2 WHERE id=$1', [plan.id, session.id])).rejects.toMatchObject({ code: '23503' });
  });

  it('transferência revoga inclusive leitura do autor antigo e preserva histórico do aluno', async () => {
    const f = await fixture(), session = (await post(f.teacher, studentPath(f.student, '/sessions'), sessionInput())).json().session;
    const item = (await post(f.teacher, studentPath(f.student, '/plan'), planInput())).json().item;
    const destination = randomUUID(), newManager = await actor('school', f.admin.orgId);
    await db.query("INSERT INTO schools(id,org_id,name) VALUES($1,$2,'Destino')", [destination, f.admin.orgId]);
    await db.query("INSERT INTO school_staff(org_id,school_id,user_id,role) VALUES($1,$2,$3,'school')", [f.admin.orgId, destination, newManager.userId]);
    expect((await post(f.admin, `/api/education/students/${f.student.userId}/transfer`, { schoolId: destination })).statusCode).toBe(200);
    for (const former of [f.teacher, f.manager]) {
      expect((await get(former, studentPath(f.student, '/sessions'))).statusCode).toBe(403);
      expect((await get(former, `/api/mentoring/plan/${item.id}/history`)).statusCode).toBe(403);
      expect((await patch(former, `/api/mentoring/plan/${item.id}`, { expectedRevision: 1, title: 'Indevido' })).statusCode).toBe(403);
    }
    expect((await get(f.student, studentPath(f.student, '/sessions'))).json().items[0].id).toBe(session.id);
    expect((await patch(newManager, `/api/mentoring/plan/${item.id}`, { expectedRevision: 1, title: 'Nova escola acompanha' })).statusCode).toBe(200);
  });

  it.each(['approval', 'assignment', 'staff', 'account'] as const)('revogação de %s impede leitura e autoria do professor', async cause => {
    const f = await fixture();
    if (cause === 'approval') await db.query("UPDATE teacher_profiles SET approval_status='suspended' WHERE user_id=$1", [f.teacher.userId]);
    else if (cause === 'assignment') await db.query('UPDATE teacher_class_assignments SET ended_at=now() WHERE teacher_id=$1', [f.teacher.userId]);
    else if (cause === 'staff') await db.query('UPDATE school_staff SET ended_at=now() WHERE user_id=$1', [f.teacher.userId]);
    else await db.query("UPDATE users SET status='suspended' WHERE id=$1", [f.teacher.userId]);
    expect((await get(f.teacher, studentPath(f.student, '/sessions'))).statusCode).toBe(cause === 'account' ? 401 : 403);
    expect((await post(f.teacher, studentPath(f.student, '/sessions'), sessionInput())).statusCode).toBe(cause === 'account' ? 401 : 403);
  });

  it.each(['logout', 'approval', 'role'] as const)('pedido em fila revalida %s antes de registrar mentoria', async cause => {
    const f = await fixture(), blocker = await db.pool.connect();
    let pending: ReturnType<typeof post> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [f.admin.orgId]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = post(f.teacher, studentPath(f.student, '/sessions'), sessionInput());
      let queued = false;
      for (let attempt = 0; attempt < 300 && !queued; attempt++) {
        queued = (await control.query<{ queued: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_locks held JOIN pg_locks waiting
          ON held.locktype=waiting.locktype AND held.database IS NOT DISTINCT FROM waiting.database AND held.classid=waiting.classid AND held.objid=waiting.objid AND held.objsubid=waiting.objsubid
          WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted AND NOT waiting.granted) AS queued`, [pid])).rows[0].queued;
        if (!queued) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(queued).toBe(true);
      if (cause === 'logout') expect((await post(f.teacher, '/api/auth/logout', {})).statusCode).toBe(204);
      else if (cause === 'approval') await blocker.query("UPDATE teacher_profiles SET approval_status='suspended' WHERE user_id=$1", [f.teacher.userId]);
      else await blocker.query("UPDATE users SET roles=ARRAY['student'] WHERE id=$1", [f.teacher.userId]);
      await blocker.query('COMMIT');
      expect((await pending).statusCode).toBe(cause === 'logout' ? 401 : 403);
      expect((await db.query('SELECT id FROM mentoring_sessions WHERE org_id=$1', [f.admin.orgId])).rowCount).toBe(0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
  });
});
