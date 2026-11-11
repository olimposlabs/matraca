import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { emptyCourse } from '../server/course-model.js';
import { createDatabase } from '../server/db.js';
import { awardLearningEvent, defaultGamificationPolicy } from '../server/gamification-core.js';
import { getWallet } from '../server/wallet.js';

interface Actor { orgId: string; userId: string; host: string; cookie: string }
const manager = '/api/gamification/manage';

describe('XP, rankings históricos e prêmios', () => {
  const schema = `gamification_test_${randomUUID().replaceAll('-', '')}`;
  const database = process.env.DATABASE_URL ?? localDatabaseUrl;
  const url = new URL(database);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const control = createDatabase(database);
  const db = createDatabase(url.toString());
  let root: string;
  let app: FastifyInstance;
  beforeAll(async () => {
    await control.query(`CREATE SCHEMA ${schema}`);
    const migrations = new URL('../server/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await db.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    root = await mkdtemp(join(tmpdir(), 'matraca-gamification-'));
    app = await createApp({ databaseUrl: url.toString(), storageRoot: root });
  });
  afterAll(async () => {
    await app?.close();
    await db.close();
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function actor(role: 'student' | 'org_admin' | 'operator', name: string, orgId: string = randomUUID()): Promise<Actor> {
    const userId = randomUUID();
    const slug = `xp-${orgId}`;
    const host = `${slug}.localhost`;
    const kind = role === 'operator' ? 'backoffice' : 'partner';
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,$2,'XP teste',$3) ON CONFLICT DO NOTHING", [orgId, slug, kind]);
    await db.query('INSERT INTO domains(hostname,org_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [host, orgId]);
    await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,$3,$4,$5,'active')", [userId, orgId, `${userId}@example.test`, name, [role]]);
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
      [orgId, userId, host, createHash('sha256').update(token).digest('hex')]);
    return { orgId, userId, host, cookie: `matraca_session=${token}` };
  }

  async function createLearningEvent(student: Actor, timestamp: string, groupIds: string[] = [], kind: 'lesson' | 'review' | 'course' = 'lesson') {
    const courseId = randomUUID();
    const versionId = randomUUID();
    const enrollmentId = randomUUID();
    const event = { id: randomUUID(), orgId: student.orgId, studentId: student.userId, kind };
    await db.transaction(async client => {
      const document = emptyCourse('Curso sintético');
      await client.query("INSERT INTO courses(id,org_id,title,status,draft) VALUES($1,$2,'Curso sintético','published',$3)", [courseId, student.orgId, document]);
      await client.query('INSERT INTO course_versions(id,org_id,course_id,version,document) VALUES($1,$2,$3,1,$4)', [versionId, student.orgId, courseId, document]);
      await client.query("INSERT INTO course_enrollments(id,org_id,course_id,version_id,student_id,source,source_ref) VALUES($1,$2,$3,$4,$5,'demo','fixture')",
        [enrollmentId, student.orgId, courseId, versionId, student.userId]);
      await client.query('INSERT INTO learning_events(id,enrollment_id,org_id,student_id,kind,subject_id,group_ids,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [event.id, enrollmentId, student.orgId, student.userId, kind, 'lesson-test', groupIds, timestamp]);
      await awardLearningEvent(client, event);
    });
    return event;
  }

  function call(who: Actor, method: 'GET' | 'POST' | 'PUT', url: string, body?: object) {
    return app.inject({ method, url, headers: { host: who.host, cookie: who.cookie, 'x-matraca-request': '1' }, ...(body ? { payload: body } : {}) });
  }

  it('aplica regras prospectivas, concede medalhas uma vez e não gera créditos por XP', async () => {
    const admin = await actor('org_admin', 'Admin');
    const student = await actor('student', 'Aluno', admin.orgId);
    const first = await createLearningEvent(student, '2020-04-01T14:00:00Z');
    await db.transaction(client => awardLearningEvent(client, first));
    const before = await call(student, 'GET', '/api/gamification');
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({ totals: { xp: 20, lesson: 1 }, badges: [{ id: 'first-lesson' }] });
    const policy = { ...defaultGamificationPolicy, points: { ...defaultGamificationPolicy.points, lesson: 35 } };
    expect((await call(admin, 'PUT', `${manager}/policy`, { expectedRevision: 0, policy })).statusCode).toBe(200);
    expect((await call(admin, 'PUT', `${manager}/policy`, { expectedRevision: 0, policy })).statusCode).toBe(409);
    await createLearningEvent(student, '2020-04-02T14:00:00Z');
    const after = await call(student, 'GET', '/api/gamification');
    expect(after.json()).toMatchObject({ totals: { xp: 55, lesson: 2 }, badges: [{ id: 'first-lesson' }] });
    expect(await getWallet(db, student)).toMatchObject({ balance: 0, reserved: 0 });
  });

  it('respeita corte de São Paulo, empate, grupo histórico, transferência e isolamento', async () => {
    const earlier = await actor('student', 'Anterior');
    const later = await actor('student', 'Posterior', earlier.orgId);
    const outside = await actor('student', 'Outra organização');
    const type = randomUUID();
    const oldGroup = randomUUID();
    const newGroup = randomUUID();
    await db.query("INSERT INTO group_types(id,org_id,name) VALUES($1,$2,'Cidade')", [type, earlier.orgId]);
    await db.query("INSERT INTO education_groups(id,org_id,type_id,name) VALUES($1,$3,$4,'Origem'),($2,$3,$4,'Destino')", [oldGroup, newGroup, earlier.orgId, type]);
    await db.query('INSERT INTO group_memberships(org_id,group_id,user_id) VALUES($1,$2,$3),($1,$4,$5)',
      [earlier.orgId, newGroup, earlier.userId, oldGroup, later.userId]);
    await createLearningEvent(earlier, '2020-01-01T02:59:59Z', [oldGroup], 'course');
    await createLearningEvent(earlier, '2020-01-01T03:00:00Z', [oldGroup]);
    await createLearningEvent(later, '2020-03-01T12:00:00Z', [oldGroup]);
    const ranking = await call(later, 'GET', `/api/gamification/leaderboard?year=2020&groupId=${oldGroup}`);
    expect(ranking.statusCode, ranking.body).toBe(200);
    expect(ranking.json()).toMatchObject({
      total: 2,
      own: { position: 2, studentId: later.userId, points: 20 },
      items: [{ position: 1, studentId: earlier.userId, points: 20 }, { position: 2, studentId: later.userId, points: 20 }],
    });
    expect((await call(earlier, 'GET', `/api/gamification/leaderboard?year=2020&groupId=${newGroup}`)).json().items).toEqual([]);
    expect((await call(earlier, 'GET', `/api/gamification/leaderboard?year=2020&groupId=${oldGroup}`)).statusCode).toBe(404);
    expect((await call(outside, 'GET', `/api/gamification/leaderboard?year=2020&groupId=${oldGroup}`)).statusCode).toBe(404);
    expect((await call(outside, 'GET', '/api/gamification/leaderboard?year=2020')).json().items).toEqual([]);
    await db.query("UPDATE orgs SET settings=settings||'{\"leaderboardEnabled\":false}'::jsonb WHERE id=$1", [earlier.orgId]);
    expect((await call(later, 'GET', '/api/gamification/leaderboard?year=2020')).statusCode).toBe(403);
    expect((await call(later, 'GET', '/api/gamification')).json()).toMatchObject({ leaderboardEnabled: false, totals: { xp: 20 } });
  });

  it('fecha campanha uma vez e mantém classificação e lançamentos após reenvio', async () => {
    const admin = await actor('org_admin', 'Admin');
    const first = await actor('student', 'Primeira', admin.orgId);
    const second = await actor('student', 'Segunda', admin.orgId);
    await createLearningEvent(first, '2020-04-01T14:00:00Z', [], 'course');
    await createLearningEvent(second, '2020-04-02T14:00:00Z');
    const input = {
      clientKey: randomUUID(), title: 'Campanha 2020', startsAt: '2020-01-01T00:00:00-03:00', endsAt: '2021-01-01T00:00:00-03:00',
      groupId: null, prizes: [{ position: 1, credits: 3 }, { position: 2, credits: 2 }, { position: 3, credits: 1 }],
    };
    const created = await call(admin, 'POST', `${manager}/campaigns`, input);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().campaign.id;
    expect((await call(admin, 'POST', `${manager}/campaigns`, input)).json().campaign.id).toBe(id);
    expect((await call(admin, 'POST', `${manager}/campaigns`, { ...input, title: 'Outro' })).statusCode).toBe(409);
    const [closed, repeated] = await Promise.all([
      call(admin, 'POST', `${manager}/campaigns/${id}/close`),
      call(admin, 'POST', `${manager}/campaigns/${id}/close`),
    ]);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(repeated.json()).toEqual(closed.json());
    expect(closed.json().ranking.items).toMatchObject([
      { position: 1, studentId: first.userId, name: 'Primeira', credits: 3 },
      { position: 2, studentId: second.userId, name: 'Segunda', credits: 2 },
    ]);
    expect(await getWallet(db, first)).toMatchObject({ balance: 3, reserved: 0 });
    expect(await getWallet(db, second)).toMatchObject({ balance: 2, reserved: 0 });
    await db.query("UPDATE users SET name='Nome posterior' WHERE id=$1", [first.userId]);
    expect((await call(admin, 'GET', `${manager}/campaigns/${id}`)).json().ranking.items[0].name).toBe('Primeira');
    expect((await db.query("SELECT id FROM wallet_entries WHERE org_id=$1 AND source='leaderboard'", [admin.orgId])).rowCount).toBe(2);
    expect((await call(first, 'POST', `${manager}/campaigns/${id}/close`)).statusCode).toBe(403);
  });
});
