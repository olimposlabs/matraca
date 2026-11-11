import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { consumeReservation, getWallet, grantCredits, reserveCredits } from '../server/wallet.js';

interface Actor { orgId: string; userId: string; host: string; cookie: string }
const headers = (actor: Actor) => ({ host: actor.host, origin: `http://${actor.host}`, cookie: actor.cookie, 'x-matraca-request': '1' });
const prefix = '/api/credits';

describe('API de créditos, autorização e orçamento escolar', () => {
  const schema = `credits_test_${randomUUID().replaceAll('-', '')}`;
  let app: FastifyInstance;
  let control: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'matraca-credits-'));
    const baseUrl = process.env.DATABASE_URL ?? localDatabaseUrl;
    control = createDatabase(baseUrl);
    await control.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(baseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    db = createDatabase(url.toString());
    const migrations = new URL('../server/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await db.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    app = await createApp({ databaseUrl: url.toString(), storageRoot: join(root, 'objects') });
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (control) {
      try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await control.close(); }
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function tenant(kind = 'partner', role = 'org_admin'): Promise<Actor> {
    const orgId = randomUUID();
    const slug = `credit-${randomUUID().slice(0, 8)}`;
    const host = `${slug}.matraca.localhost`;
    await db.query('INSERT INTO orgs (id,slug,name,kind) VALUES ($1,$2,$3,$4)', [orgId, slug, 'Organização de teste', kind]);
    await db.query('INSERT INTO domains (hostname,org_id) VALUES ($1,$2)', [host, orgId]);
    return person({ orgId, host }, role);
  }

  async function person(org: { orgId: string; host: string }, role: string, schoolId?: string): Promise<Actor> {
    const userId = randomUUID();
    await db.query("INSERT INTO users (id,org_id,email,name,roles,status) VALUES ($1,$2,$3,$4,$5,'active')", [userId, org.orgId, `${userId}@example.test`, 'Pessoa sintética', [role]]);
    if (schoolId && role === 'student') await db.query('INSERT INTO student_schools (org_id,student_id,school_id) VALUES ($1,$2,$3)', [org.orgId, userId, schoolId]);
    if (schoolId && ['school', 'teacher'].includes(role)) await db.query('INSERT INTO school_staff (org_id,user_id,school_id,role) VALUES ($1,$2,$3,$4)', [org.orgId, userId, schoolId, role]);
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO sessions (org_id,user_id,hostname,token_hash,expires_at) VALUES ($1,$2,$3,$4,now()+interval '1 hour')", [org.orgId, userId, org.host, createHash('sha256').update(token).digest('hex')]);
    return { ...org, userId, cookie: `matraca_session=${token}` };
  }

  async function school(admin: Actor, name = 'Escola sintética') {
    const id = randomUUID();
    await db.query('INSERT INTO schools (id,org_id,name) VALUES ($1,$2,$3)', [id, admin.orgId, name]);
    return id;
  }

  const get = (actor: Actor, path: string) => app.inject({ method: 'GET', url: path, headers: headers(actor) });
  const post = (actor: Actor, path: string, payload: object) => app.inject({ method: 'POST', url: path, headers: headers(actor), payload });
  const patch = (actor: Actor, path: string, payload: object) => app.inject({ method: 'PATCH', url: path, headers: headers(actor), payload });
  const grant = (actor: Actor, target: Actor, amount: number, eventId = randomUUID()) => post(actor, `${prefix}/students/${target.userId}/grant`, { eventId, reason: 'Concessão sintética', amount });
  const fund = (target: Actor, amount: number) => grantCredits(db, { orgId: target.orgId, userId: target.userId, amount, eventKey: randomUUID(), source: 'manual', sourceRef: 'fixture', reason: 'Saldo de teste' });

  async function policy(admin: Actor, enabled: boolean, monthlyLimit = 5) {
    const response = await patch(admin, `${prefix}/policy`, { schoolExtrasEnabled: enabled, defaultSchoolMonthlyLimit: monthlyLimit });
    expect(response.statusCode).toBe(200);
    expect(response.json().policy).toMatchObject({ schoolExtrasEnabled: enabled, defaultSchoolMonthlyLimit: monthlyLimit });
  }

  async function delegated(monthlyLimit = 5) {
    const admin = await tenant();
    const schoolId = await school(admin);
    const manager = await person(admin, 'school', schoolId);
    const student = await person(admin, 'student', schoolId);
    await policy(admin, true, monthlyLimit);
    return { admin, schoolId, manager, student };
  }

  it('aluno lê somente sua carteira; professor e aluno não usam administração de créditos', async () => {
    const admin = await tenant();
    const student = await person(admin, 'student');
    const other = await person(admin, 'student');
    const teacher = await person(admin, 'teacher');
    await fund(student, 3);
    const own = await get(student, '/api/wallet');
    expect(own.statusCode).toBe(200);
    expect(own.json().wallet).toEqual({ balance: 3, reserved: 0, available: 3 });
    expect(own.json().entries[0]).not.toHaveProperty('fingerprint');
    expect((await get(teacher, '/api/wallet')).statusCode).toBe(403);
    for (const forbidden of [student, teacher]) {
      expect((await get(forbidden, `${prefix}/students`)).statusCode).toBe(403);
      expect((await get(forbidden, `${prefix}/students/${other.userId}`)).statusCode).toBe(403);
      expect((await grant(forbidden, other, 1)).statusCode).toBe(403);
    }
  });

  it('admin concede idempotentemente e rejeita reutilizar evento com outro valor ou aluno', async () => {
    const admin = await tenant();
    const student = await person(admin, 'student'), other = await person(admin, 'student');
    const eventId = randomUUID();
    const responses = await Promise.all([grant(admin, student, 3, eventId), grant(admin, student, 3, eventId)]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    expect(new Set(responses.map(response => response.json().entry.id)).size).toBe(1);
    expect((await grant(admin, student, 4, eventId)).statusCode).toBe(409);
    expect((await grant(admin, other, 3, eventId)).statusCode).toBe(409);
    expect(await getWallet(db, { orgId: student.orgId, userId: student.userId })).toEqual({ balance: 3, reserved: 0, available: 3 });
    expect((await getWallet(db, { orgId: other.orgId, userId: other.userId })).balance).toBe(0);
  });

  it('login real concede diagnóstico uma única vez ao aluno', async () => {
    const admin = await tenant();
    const student = await person(admin, 'student');
    const inbox = join(root, 'mailbox', admin.orgId);
    let previous: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const requested = await post(student, '/api/auth/request', { email: `${student.userId}@example.test` });
      expect(requested.statusCode).toBe(202);
      const files = await readdir(inbox);
      const added = files.filter(file => !previous.includes(file));
      expect(added.length).toBe(1);
      const mail = JSON.parse(await readFile(join(inbox, added[0]), 'utf8'));
      const link = new URL(mail.link);
      const consumed = await get(student, `${link.pathname}${link.search}`);
      expect(consumed.headers.location).toBe('/app');
      expect((await getWallet(db, student)).balance).toBe(1);
      previous = files;
    }
    expect((await db.query("SELECT id FROM wallet_entries WHERE org_id=$1 AND user_id=$2 AND source='initial'", [student.orgId, student.userId])).rowCount).toBe(1);
  });

  it('outra organização e o contexto central não podem ser escolhidos por administrador comum', async () => {
    const first = await tenant(), second = await tenant();
    const foreign = await person(second, 'student');
    expect((await get(first, `${prefix}/students/${foreign.userId}`)).statusCode).toBe(404);
    expect((await grant(first, foreign, 2)).statusCode).toBe(404);
    expect((await get(first, `/api/backoffice/credits/orgs/${second.orgId}/students`)).statusCode).toBe(403);
    expect((await post(first, `/api/backoffice/credits/orgs/${second.orgId}/students/${foreign.userId}/grant`, { amount: 2, eventId: randomUUID(), reason: 'Indevido' })).statusCode).toBe(403);
  });

  it('operador no backoffice concede ao aluno direto pelo contexto central explícito', async () => {
    const operator = await tenant('backoffice', 'operator');
    const matraca = await tenant('matraca');
    const student = await person(matraca, 'student');
    const central = `/api/backoffice/credits/orgs/${matraca.orgId}`;
    const result = await post(operator, `${central}/students/${student.userId}/grant`, { amount: 4, eventId: randomUUID(), reason: 'Cortesia operacional' });
    expect(result.statusCode).toBe(200);
    expect(result.json().entry.actor_user_id).toBe(operator.userId);
    expect(result.json().entry.actorName).toBe('Equipe Matraca');
    expect(result.json().wallet.balance).toBe(4);
    expect((await get(operator, `${central}/students/${student.userId}`)).json().wallet.balance).toBe(4);
  });

  it('extrato filtra origem, responsável e dia de São Paulo antes de contar e paginar', async () => {
    const admin = await tenant(), student = await person(admin, 'student');
    const operator = await tenant('backoffice', 'operator');
    await db.query("UPDATE users SET name='Operador privado sintético' WHERE id=$1", [operator.userId]);
    const fixtures = [
      { at: '2026-06-15T02:59:59.999Z', source: 'manual', actor: admin.userId },
      { at: '2026-06-15T03:00:00.000Z', source: 'manual', actor: operator.userId },
      { at: '2026-06-16T02:59:59.999Z', source: 'manual', actor: operator.userId },
      { at: '2026-06-16T03:00:00.000Z', source: 'manual', actor: admin.userId },
      { at: '2026-06-15T12:00:00.000Z', source: 'lesson', actor: admin.userId },
    ];
    // Historical fixtures are inserted with explicit timestamps; immutable entries are never rewritten.
    await db.query('INSERT INTO wallets(org_id,user_id,balance) VALUES($1,$2,$3)', [admin.orgId, student.userId, fixtures.length]);
    for (const fixture of fixtures) {
      const entryId = randomUUID();
      await db.query(`INSERT INTO wallet_entries(id,org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,actor_user_id,reason,created_at)
        VALUES($1::uuid,$2,$3,1,'grant',$4,'filter-fixture',$1::text,'synthetic',$5,'Fixture histórica',$6)`,
      [entryId, admin.orgId, student.userId, fixture.source, fixture.actor, fixture.at]);
      await db.query('INSERT INTO credit_lots(entry_id,org_id,user_id,quantity,remaining,created_at) VALUES($1,$2,$3,1,1,$4)', [entryId, admin.orgId, student.userId, fixture.at]);
    }
    const path = `/api/wallet?source=manual&from=2026-06-15&to=2026-06-15&actorSearch=Equipe%20Matraca&limit=1`;
    const first = await get(student, `${path}&page=1`), second = await get(student, `${path}&page=2`);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ total: 2, page: 1, limit: 1, wallet: { balance: 5 } });
    expect(second.json()).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(first.json().entries[0]).toMatchObject({ created_at: '2026-06-16T02:59:59.999Z', actorName: 'Equipe Matraca', source: 'manual' });
    expect(second.json().entries[0]).toMatchObject({ created_at: '2026-06-15T03:00:00.000Z', actorName: 'Equipe Matraca' });
    expect((await get(student, `${path}&page=3`)).json().entries).toHaveLength(0);
    expect((await get(student, '/api/wallet?actorSearch=Operador%20privado')).json().total).toBe(0);
    expect((await get(student, '/api/wallet?source=lesson&actorSearch=Pessoa')).json().total).toBe(1);
    expect((await get(student, '/api/wallet?from=2026-06-16&to=2026-06-15')).statusCode).toBe(400);
  });

  it('gestor lê alunos próprios com autonomia desligada mas não concede extras', async () => {
    const fixture = await delegated();
    const otherSchool = await school(fixture.admin), otherStudent = await person(fixture.admin, 'student', otherSchool);
    await policy(fixture.admin, false);
    const students = await get(fixture.manager, `${prefix}/students?page=1&pageSize=1`);
    expect(students.statusCode).toBe(200);
    expect(students.json()).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(students.json().items[0].id).toBe(fixture.student.userId);
    expect((await get(fixture.manager, `${prefix}/students/${fixture.student.userId}`)).statusCode).toBe(200);
    expect((await get(fixture.manager, `${prefix}/students/${otherStudent.userId}`)).statusCode).toBe(403);
    expect((await grant(fixture.manager, fixture.student, 1)).statusCode).toBe(403);
    expect((await patch(fixture.manager, `${prefix}/policy`, { schoolExtrasEnabled: true })).statusCode).toBe(403);
    expect((await patch(fixture.manager, `${prefix}/schools/${fixture.schoolId}/limit`, { monthlyLimit: 999 })).statusCode).toBe(403);
  });

  it('limite mensal da escola conta concessões únicas e não concessões do administrador', async () => {
    const fixture = await delegated(2);
    const eventId = randomUUID();
    expect((await grant(fixture.manager, fixture.student, 2, eventId)).statusCode).toBe(200);
    expect((await grant(fixture.manager, fixture.student, 2, eventId)).statusCode).toBe(200);
    expect((await grant(fixture.manager, fixture.student, 1)).statusCode).toBe(409);
    expect((await grant(fixture.admin, fixture.student, 10)).statusCode).toBe(200);
    const limit = (await get(fixture.admin, `${prefix}/schools/${fixture.schoolId}/limit`)).json().limit;
    expect(limit).toMatchObject({ used: 2, remaining: 0, monthlyLimit: 2 });
    const month = (await db.query<{ month: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS month")).rows[0].month;
    expect(String(limit.month).startsWith(month)).toBe(true);
    expect((await patch(fixture.admin, `${prefix}/schools/${fixture.schoolId}/limit`, { monthlyLimit: 3 })).statusCode).toBe(200);
    expect((await grant(fixture.manager, fixture.student, 1)).statusCode).toBe(200);
    expect((await getWallet(db, fixture.student)).balance).toBe(13);
  });

  it('replay também exige autonomia escolar atual, sem repetir o consumo do teto', async () => {
    const fixture = await delegated(2);
    const eventId = randomUUID();
    const initial = await grant(fixture.manager, fixture.student, 2, eventId);
    expect(initial.statusCode).toBe(200);
    await policy(fixture.admin, false, 2);
    expect((await grant(fixture.manager, fixture.student, 2, eventId)).statusCode).toBe(403);
    expect((await getWallet(db, fixture.student)).balance).toBe(2);
    await policy(fixture.admin, true, 2);
    const replay = await grant(fixture.manager, fixture.student, 2, eventId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().entry.id).toBe(initial.json().entry.id);
    expect((await get(fixture.admin, `${prefix}/schools/${fixture.schoolId}/limit`)).json().limit.used).toBe(2);
  });

  it('gestor com papel de aluno não usa o acesso a si mesmo para conceder fora da escola gerida', async () => {
    const fixture = await delegated();
    const otherSchool = await school(fixture.admin, 'Escola não gerida');
    await db.query("UPDATE users SET roles=ARRAY['school','student'] WHERE id=$1", [fixture.manager.userId]);
    await db.query('INSERT INTO student_schools (org_id,student_id,school_id) VALUES ($1,$2,$3)', [fixture.admin.orgId, fixture.manager.userId, otherSchool]);
    expect((await get(fixture.manager, '/api/wallet')).statusCode).toBe(200);
    expect((await get(fixture.manager, `${prefix}/students/${fixture.manager.userId}`)).statusCode).toBe(403);
    expect((await grant(fixture.manager, fixture.manager, 1)).statusCode).toBe(403);
    expect((await get(fixture.manager, `${prefix}/students`)).json().items.some((item: { id: string }) => item.id === fixture.manager.userId)).toBe(false);
    expect((await getWallet(db, fixture.manager)).balance).toBe(0);
  });

  it('gestor com papel de professor não usa a turma lecionada para administrar outra escola', async () => {
    const fixture = await delegated();
    const otherSchool = await school(fixture.admin, 'Escola lecionada sem gestão');
    const student = await person(fixture.admin, 'student', otherSchool);
    await db.query("UPDATE users SET roles=ARRAY['school','teacher'] WHERE id=$1", [fixture.manager.userId]);
    await db.query("INSERT INTO school_staff(org_id,user_id,school_id,role) VALUES($1,$2,$3,'teacher')", [fixture.admin.orgId, fixture.manager.userId, otherSchool]);
    expect((await patch(fixture.admin, `/api/education/teachers/${fixture.manager.userId}`, { approvalStatus: 'approved' })).statusCode).toBe(200);
    const classroom = await post(fixture.admin, '/api/education/classes', { schoolId: otherSchool, name: 'Turma do professor' });
    expect(classroom.statusCode).toBe(201);
    const classId = classroom.json().class.id;
    expect((await post(fixture.admin, `/api/education/classes/${classId}/teachers`, { teacherId: fixture.manager.userId })).statusCode).toBe(201);
    expect((await post(fixture.admin, `/api/education/classes/${classId}/enrollments`, { studentId: student.userId })).statusCode).toBe(201);
    expect((await get(fixture.manager, `/api/education/people/${student.userId}`)).statusCode).toBe(200);
    expect((await get(fixture.manager, `${prefix}/students/${student.userId}`)).statusCode).toBe(403);
    expect((await grant(fixture.manager, student, 1)).statusCode).toBe(403);
    expect((await get(fixture.manager, `${prefix}/students`)).json().items.some((item: { id: string }) => item.id === student.userId)).toBe(false);
  });

  it('dois gestores concorrendo pelo último crédito do limite produzem uma concessão', async () => {
    const fixture = await delegated(1);
    const secondManager = await person(fixture.admin, 'school', fixture.schoolId);
    const secondStudent = await person(fixture.admin, 'student', fixture.schoolId);
    const responses = await Promise.all([grant(fixture.manager, fixture.student, 1), grant(secondManager, secondStudent, 1)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const limit = await get(fixture.admin, `${prefix}/schools/${fixture.schoolId}/limit`);
    expect(limit.json().limit).toMatchObject({ used: 1, remaining: 0 });
    const balances = await Promise.all([getWallet(db, fixture.student), getWallet(db, secondStudent)]);
    expect(balances.reduce((sum, wallet) => sum + wallet.balance, 0)).toBe(1);
  });

  it('escola não ajusta nem estorna consumo mesmo com autonomia ativa', async () => {
    const fixture = await delegated();
    await fund(fixture.student, 2);
    await reserveCredits(db, { ...fixture.student, requestId: 'school-refund', durationMicroseconds: 30_000_000 });
    const consumed = await consumeReservation(db, { ...fixture.student, requestId: 'school-refund' });
    expect((await post(fixture.manager, `${prefix}/students/${fixture.student.userId}/adjust`, { eventId: randomUUID(), reason: 'Indevido', delta: 1 })).statusCode).toBe(403);
    expect((await post(fixture.manager, `${prefix}/students/${fixture.student.userId}/refund`, { eventId: randomUUID(), reason: 'Indevido', entryId: consumed.consumption_entry_id })).statusCode).toBe(403);
    expect((await getWallet(db, fixture.student)).balance).toBe(1);
  });

  it('estorno administrativo é único mesmo com eventos diferentes e ajuste respeita reserva', async () => {
    const admin = await tenant(), student = await person(admin, 'student');
    await fund(student, 3);
    await reserveCredits(db, { ...student, requestId: 'refund', durationMicroseconds: 30_000_000 });
    const consumed = await consumeReservation(db, { ...student, requestId: 'refund' });
    const refundPath = `${prefix}/students/${student.userId}/refund`;
    const first = await post(admin, refundPath, { eventId: randomUUID(), reason: 'Revisão', entryId: consumed.consumption_entry_id });
    const second = await post(admin, refundPath, { eventId: randomUUID(), reason: 'Repetição', entryId: consumed.consumption_entry_id });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().entry.id).toBe(first.json().entry.id);
    expect((await getWallet(db, student)).balance).toBe(3);
    await reserveCredits(db, { ...student, requestId: 'held', durationMicroseconds: 120_000_000 });
    expect((await post(admin, `${prefix}/students/${student.userId}/adjust`, { eventId: randomUUID(), reason: 'Ajuste excessivo', delta: -2 })).statusCode).toBe(402);
    const adjusted = await post(admin, `${prefix}/students/${student.userId}/adjust`, { eventId: randomUUID(), reason: 'Ajuste permitido', delta: -1 });
    expect(adjusted.statusCode).toBe(200);
    expect(adjusted.json().wallet).toEqual({ balance: 2, reserved: 2, available: 0 });
  });

  it('pacote editado ou arquivado não altera concessão anterior nem seu replay', async () => {
    const admin = await tenant(), student = await person(admin, 'student');
    const created = await post(admin, `${prefix}/packages`, { name: 'Pacote teste', amount: 3, description: 'Créditos sintéticos' });
    expect(created.statusCode).toBe(201);
    const packageId = created.json().package.id;
    const eventId = randomUUID();
    const request = { eventId, reason: 'Pacote de boas-vindas', packageId };
    const path = `${prefix}/students/${student.userId}/grant`;
    const first = await post(admin, path, request);
    expect(first.statusCode).toBe(200);
    expect(first.json().entry.delta).toBe(3);
    expect((await patch(admin, `${prefix}/packages/${packageId}`, { amount: 5 })).statusCode).toBe(200);
    const replay = await post(admin, path, request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().entry.id).toBe(first.json().entry.id);
    expect(replay.json().entry.delta).toBe(3);
    expect((await post(admin, path, { ...request, eventId: randomUUID() })).json().entry.delta).toBe(5);
    expect((await patch(admin, `${prefix}/packages/${packageId}`, { status: 'archived' })).statusCode).toBe(200);
    expect((await post(admin, path, request)).json().entry.id).toBe(first.json().entry.id);
    expect((await post(admin, path, { ...request, eventId: randomUUID() })).statusCode).toBe(409);
    expect((await getWallet(db, student)).balance).toBe(8);
  });

  it('pacotes e payloads não permitem escolher origem ou organização alheia', async () => {
    const first = await tenant(), second = await tenant();
    const student = await person(first, 'student');
    const foreignPackage = await post(second, `${prefix}/packages`, { name: 'Pacote externo', amount: 4 });
    const path = `${prefix}/students/${student.userId}/grant`;
    expect((await post(first, path, { eventId: randomUUID(), reason: 'Indevido', packageId: foreignPackage.json().package.id })).statusCode).toBe(404);
    for (const extra of [{ amount: 1, source: 'purchase' }, { amount: 1, orgId: second.orgId }, { amount: 1, packageId: randomUUID() }, { amount: 1.5 }, { amount: 0 }, { amount: -1 }]) {
      expect((await post(first, path, { eventId: randomUUID(), reason: 'Inválido', ...extra })).statusCode).toBe(400);
    }
    expect((await getWallet(db, student)).balance).toBe(0);
  });

  it('transferência mantém saldo e muda gestores sem mover orçamento histórico da escola', async () => {
    const fixture = await delegated(3);
    expect((await grant(fixture.manager, fixture.student, 3)).statusCode).toBe(200);
    const destination = await school(fixture.admin, 'Escola destino');
    const newManager = await person(fixture.admin, 'school', destination);
    const moved = await post(fixture.admin, `/api/education/students/${fixture.student.userId}/transfer`, { schoolId: destination });
    expect(moved.statusCode).toBe(200);
    expect((await getWallet(db, fixture.student)).balance).toBe(3);
    expect((await get(fixture.manager, `${prefix}/students/${fixture.student.userId}`)).statusCode).toBe(403);
    expect((await grant(fixture.manager, fixture.student, 1)).statusCode).toBe(403);
    expect((await grant(newManager, fixture.student, 3)).statusCode).toBe(200);
    expect((await get(fixture.admin, `${prefix}/schools/${fixture.schoolId}/limit`)).json().limit.used).toBe(3);
    expect((await get(fixture.admin, `${prefix}/schools/${destination}/limit`)).json().limit.used).toBe(3);
    expect((await getWallet(db, fixture.student)).balance).toBe(6);
  });

  it.each(['logout', 'target-school', 'policy', 'role'] as const)('concessão em fila revalida %s antes de alterar carteira ou orçamento', async cause => {
    const fixture = await delegated();
    const destination = await school(fixture.admin, 'Destino na fila');
    const blocker = await db.pool.connect();
    let pending: ReturnType<typeof grant> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [fixture.admin.orgId]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = grant(fixture.manager, fixture.student, 2);
      let queued = false;
      for (let attempt = 0; attempt < 200 && !queued; attempt++) {
        const result = await control.query<{ queued: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM pg_locks held JOIN pg_locks waiting
            ON held.locktype=waiting.locktype AND held.database IS NOT DISTINCT FROM waiting.database
            AND held.classid=waiting.classid AND held.objid=waiting.objid AND held.objsubid=waiting.objsubid
          WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted AND NOT waiting.granted
        ) AS queued`, [pid]);
        queued = result.rows[0].queued;
        if (!queued) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(queued).toBe(true);
      if (cause === 'logout') expect((await post(fixture.manager, '/api/auth/logout', {})).statusCode).toBe(204);
      else if (cause === 'target-school') {
        await blocker.query('UPDATE student_schools SET ended_at=now() WHERE org_id=$1 AND student_id=$2 AND ended_at IS NULL', [fixture.admin.orgId, fixture.student.userId]);
        await blocker.query('INSERT INTO student_schools (org_id,student_id,school_id) VALUES ($1,$2,$3)', [fixture.admin.orgId, fixture.student.userId, destination]);
      } else if (cause === 'policy') await blocker.query('UPDATE org_credit_policies SET school_extras_enabled=false WHERE org_id=$1', [fixture.admin.orgId]);
      else await blocker.query("UPDATE users SET roles=ARRAY['student'] WHERE id=$1", [fixture.manager.userId]);
      await blocker.query('COMMIT');
      expect((await pending).statusCode).toBe(cause === 'logout' ? 401 : 403);
      expect((await getWallet(db, fixture.student)).balance).toBe(0);
      expect((await get(fixture.admin, `${prefix}/schools/${fixture.schoolId}/limit`)).json().limit.used).toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending?.catch(() => {});
    }
  });
});
