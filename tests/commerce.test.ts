import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { registerCommerce, type SimulatedPaymentStatus } from '../server/commerce.js';
import { localDatabaseUrl } from '../server/config.js';
import { emptyCourse } from '../server/course-model.js';
import { createDatabase } from '../server/db.js';
import { getWallet } from '../server/wallet.js';

interface Actor { orgId: string; userId: string; host: string; cookie: string }
const headers = (who: Actor) => ({ host: who.host, origin: `http://${who.host}`, cookie: who.cookie, 'x-matraca-request': '1' });
const creditsInput = { title: 'Dez práticas', kind: 'credits', creditAmount: 10, priceTable: { mode: 'volume', tiers: [{ from: 1, to: 9, unitPriceCents: 100 }, { from: 10, to: null, unitPriceCents: 90 }] } };
const central = (org: { orgId: string }) => `/api/backoffice/commerce/orgs/${org.orgId}`;

describe('catálogo, pedidos e pagamentos locais simulados', () => {
  const schema = `commerce_test_${randomUUID().replaceAll('-', '')}`;
  const database = process.env.DATABASE_URL ?? localDatabaseUrl;
  const url = new URL(database); url.searchParams.set('options', `-c search_path=${schema}`);
  const control = createDatabase(database), db = createDatabase(url.toString());
  let app: FastifyInstance, root: string;
  beforeAll(async () => {
    await control.query(`CREATE SCHEMA ${schema}`);
    const migrations = new URL('../server/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, migrations), 'utf8'));
    root = await mkdtemp(join(tmpdir(), 'matraca-commerce-'));
    app = await createApp({ databaseUrl: url.toString(), storageRoot: join(root, 'objects') });
    if (!app.hasRoute({ method: 'GET', url: '/api/commerce/catalog' })) await registerCommerce(app);
  });
  afterAll(async () => {
    await app?.close(); await db.close();
    try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function person(org: { orgId: string; host: string }, role: string): Promise<Actor> {
    const userId = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,$3,'Pessoa sintética',$4,'active')", [userId, org.orgId, `${userId}@example.test`, [role]]);
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [org.orgId, userId, org.host, createHash('sha256').update(token).digest('hex')]);
    return { ...org, userId, cookie: `matraca_session=${token}` };
  }
  async function tenant(kind = 'matraca', role = 'student') {
    const orgId = randomUUID(), slug = `store-${randomUUID().slice(0, 8)}`, host = `${slug}.localhost`;
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,$2,'Loja sintética',$3)", [orgId, slug, kind]);
    await db.query('INSERT INTO domains(hostname,org_id) VALUES($1,$2)', [host, orgId]);
    return person({ orgId, host }, role);
  }
  async function fixture() { return { student: await tenant(), operator: await tenant('backoffice', 'operator') }; }
  function call(who: Actor, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object, target = app) {
    return target.inject({ method, url: path, headers: headers(who), ...(payload ? { payload } : {}) });
  }
  async function offer(student: Actor, operator: Actor, input: object = creditsInput, published = true) {
    const created = await call(operator, 'POST', `${central(student)}/catalog`, input);
    expect(created.statusCode, created.body).toBe(201);
    if (!published) return created.json().offer;
    const publication = await call(operator, 'POST', `${central(student)}/catalog/${created.json().offer.id}/publish`, { expectedRevision: created.json().offer.revision });
    expect(publication.statusCode, publication.body).toBe(200); return publication.json().offer;
  }
  async function order(student: Actor, offerId: string, key = randomUUID()) {
    const result = await call(student, 'POST', '/api/commerce/orders', { offerId, clientKey: key });
    expect(result.statusCode, result.body).toBe(201); return result.json().order;
  }
  async function course(student: Actor, acquisitionCredits = 7, creditMode: 'acquisition' | 'progress' = 'acquisition') {
    const courseId = randomUUID(), versionId = randomUUID(), document = { ...emptyCourse('Curso publicado'), creditMode, acquisitionCredits };
    await db.query("INSERT INTO courses(id,org_id,title,status,draft) VALUES($1,$2,$3,'published',$4)", [courseId, student.orgId, document.title, document]);
    await db.query('INSERT INTO course_versions(id,org_id,course_id,version,document) VALUES($1,$2,$3,1,$4)', [versionId, student.orgId, courseId, document]);
    return { courseId, versionId };
  }
  const payments = (orgId: string) => db.query('SELECT * FROM commerce_payment_events WHERE org_id=$1', [orgId]);
  const purchases = (orgId: string) => db.query("SELECT * FROM wallet_entries WHERE org_id=$1 AND source='purchase'", [orgId]);

  it('prévia calcula tiers em centavos e catálogo exige publicação com revisão atual', async () => {
    const { student, operator } = await fixture();
    const preview = await call(operator, 'POST', `${central(student)}/catalog/preview`, creditsInput);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ simulated: true, quote: { amountCents: 900 } });
    const draft = await offer(student, operator, creditsInput, false);
    expect(draft).toMatchObject({ status: 'draft', amountCents: 900, revision: 1 });
    expect((await call(student, 'GET', '/api/commerce/catalog')).json().items).toEqual([]);
    const published = await call(operator, 'POST', `${central(student)}/catalog/${draft.id}/publish`, { expectedRevision: 1 });
    expect(published.statusCode).toBe(200); expect(published.json().offer.revision).toBe(2);
    expect((await call(student, 'GET', '/api/commerce/catalog')).json()).toMatchObject({ total: 1, items: [{ id: draft.id, amountCents: 900 }] });
    expect((await call(operator, 'POST', `${central(student)}/catalog/${draft.id}/archive`, { expectedRevision: 1 })).statusCode).toBe(409);
    const updated = await call(operator, 'PUT', `${central(student)}/catalog/${draft.id}`, { ...creditsInput, title: 'Oferta atualizada', expectedRevision: 2 });
    expect(updated.json().offer).toMatchObject({ status: 'draft', revision: 3 });
    expect((await call(student, 'GET', '/api/commerce/catalog')).json().items).toEqual([]);
    expect((await call(operator, 'POST', `${central(student)}/catalog/${draft.id}/archive`, { expectedRevision: 3 })).json().offer).toMatchObject({ status: 'archived', revision: 4 });
    expect((await call(operator, 'GET', `${central(student)}/catalog`)).json().total).toBe(1);
  });

  it.each([
    { mode: 'volume', tiers: [{ from: 2, to: null, unitPriceCents: 100 }] },
    { mode: 'volume', tiers: [{ from: 1, to: 5, unitPriceCents: 100 }, { from: 7, to: null, unitPriceCents: 90 }] },
    { mode: 'progressive', tiers: [{ from: 1, to: 5, unitPriceCents: 100 }, { from: 5, to: null, unitPriceCents: 90 }] },
    { mode: 'progressive', tiers: [{ from: 1, to: null, unitPriceCents: 1.5 }] },
  ])('rejeita tabela de preço inválida sem criar oferta %#', async priceTable => {
    const { student, operator } = await fixture();
    expect((await call(operator, 'POST', `${central(student)}/catalog`, { ...creditsInput, priceTable })).statusCode).toBe(400);
    expect((await db.query('SELECT id FROM commerce_offers WHERE org_id=$1', [student.orgId])).rowCount).toBe(0);
  });

  it('isola compradores, organizações, campos de autoria e gestão central', async () => {
    const { student, operator } = await fixture(); const other = await person(student, 'student'), foreign = await tenant();
    const teacher = await person(student, 'teacher'), admin = await person(student, 'org_admin'), partner = await tenant('partner');
    const item = await offer(student, operator); const purchase = await order(student, item.id);
    for (const denied of [student, teacher, admin]) expect((await call(denied, 'POST', `${central(student)}/catalog`, creditsInput)).statusCode).toBe(403);
    expect((await call(teacher, 'GET', '/api/commerce/catalog')).statusCode).toBe(403);
    expect((await call(partner, 'GET', '/api/commerce/catalog')).statusCode).toBe(404);
    expect((await call(operator, 'POST', `${central(partner)}/catalog`, creditsInput)).statusCode).toBe(404);
    for (const denied of [other, foreign]) {
      expect((await call(denied, 'GET', `/api/commerce/orders/${purchase.id}`)).statusCode).toBe(404);
      expect((await call(denied, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID(), status: 'approved' })).statusCode).toBe(404);
    }
    expect((await call(foreign, 'POST', '/api/commerce/orders', { offerId: item.id, clientKey: randomUUID() })).statusCode).toBe(404);
    expect((await call(student, 'POST', '/api/commerce/orders', { offerId: item.id, clientKey: randomUUID(), studentId: other.userId, amountCents: 1 })).statusCode).toBe(400);
    expect((await call(other, 'GET', '/api/commerce/orders')).json().total).toBe(0);
    expect((await call(operator, 'GET', `${central(student)}/orders/${purchase.id}`)).statusCode).toBe(200);
    expect((await purchases(student.orgId)).rowCount).toBe(0);
  });

  it('preserva snapshot e chave do pedido após editar e arquivar oferta', async () => {
    const { student, operator } = await fixture(); const item = await offer(student, operator), key = randomUUID();
    const purchase = await order(student, item.id, key);
    const edited = await call(operator, 'PUT', `${central(student)}/catalog/${item.id}`, { ...creditsInput, creditAmount: 20, expectedRevision: item.revision });
    expect(edited.statusCode).toBe(200);
    await call(operator, 'POST', `${central(student)}/catalog/${item.id}/archive`, { expectedRevision: edited.json().offer.revision });
    expect(await order(student, item.id, key)).toEqual(purchase);
    expect((await call(student, 'POST', '/api/commerce/orders', { offerId: item.id, clientKey: randomUUID() })).statusCode).toBe(409);
    const paid = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID() });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().order).toMatchObject({ amountCents: 900, creditAmount: 10, status: 'paid', snapshot: { title: creditsInput.title, revision: item.revision, creditAmount: 10 } });
    expect((await getWallet(db, student)).balance).toBe(10);
    await expect(db.query('UPDATE commerce_orders SET amount_cents=1 WHERE id=$1', [purchase.id])).rejects.toThrow('immutable');
  });

  it('cria um pedido por intenção concorrente e não aceita reutilizar a chave para outra oferta', async () => {
    const { student, operator } = await fixture(), key = randomUUID();
    const first = await offer(student, operator), second = await offer(student, operator, { ...creditsInput, title: 'Outra oferta' });
    const [a, b] = await Promise.all([order(student, first.id, key), order(student, first.id, key)]);
    expect(a.id).toBe(b.id);
    expect((await call(student, 'POST', '/api/commerce/orders', { offerId: second.id, clientKey: key })).statusCode).toBe(409);
    expect((await db.query('SELECT id FROM commerce_orders WHERE org_id=$1', [student.orgId])).rowCount).toBe(1);
    const ownKey = await order(await person(student, 'student'), first.id, key); expect(ownKey.id).not.toBe(a.id);
  });

  it('pagamento pendente não concede e aprovações concorrentes concedem uma única vez', async () => {
    const { student, operator } = await fixture(); const item = await offer(student, operator), purchase = await order(student, item.id), eventId = randomUUID();
    const pending = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID(), status: 'pending' });
    expect(pending.json()).toMatchObject({ applied: false, order: { status: 'pending' } });
    expect((await getWallet(db, student)).balance).toBe(0);
    const results = await Promise.all([eventId, eventId, randomUUID()].map(eventId => call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId, status: 'approved' })));
    expect(results.map(result => result.statusCode)).toEqual([200, 200, 200]);
    expect(results.every(result => result.json().order.status === 'paid')).toBe(true);
    expect(results.filter(result => result.json().replay)).toHaveLength(1);
    expect((await purchases(student.orgId)).rowCount).toBe(1);
    expect((await db.query('SELECT * FROM commerce_entitlements WHERE order_id=$1', [purchase.id])).rowCount).toBe(1);
    expect((await getWallet(db, student)).balance).toBe(10);
    expect((await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId, status: 'cancelled' })).statusCode).toBe(409);
    const delayed = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID(), status: 'declined' });
    expect(delayed.json()).toMatchObject({ applied: false, order: { status: 'paid' } });
    const detail = (await call(student, 'GET', `/api/commerce/orders/${purchase.id}`)).json();
    expect(detail.events).toHaveLength(4); expect(detail.entitlement.creditEntryId).toBeTruthy();
    await expect(db.query('DELETE FROM commerce_payment_events WHERE org_id=$1', [student.orgId])).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM commerce_entitlements WHERE order_id=$1', [purchase.id])).rejects.toThrow('append-only');
  });

  it.each(['declined', 'cancelled'] as const)('pagamento %s é terminal e aprovação posterior não concede', async status => {
    const { student, operator } = await fixture(); const purchase = await order(student, (await offer(student, operator)).id);
    const result = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID(), status });
    expect(result.json()).toMatchObject({ applied: true, order: { status } });
    const late = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID(), status: 'approved' });
    expect(late.json()).toMatchObject({ applied: false, order: { status } });
    expect((await purchases(student.orgId)).rowCount).toBe(0);
    expect((await db.query('SELECT * FROM commerce_entitlements WHERE order_id=$1', [purchase.id])).rowCount).toBe(0);
  });

  it('evento de pagamento não pode ser reutilizado para outro pedido', async () => {
    const { student, operator } = await fixture(); const item = await offer(student, operator), first = await order(student, item.id), second = await order(student, item.id), eventId = randomUUID();
    expect((await call(student, 'POST', `/api/commerce/orders/${first.id}/simulate`, { eventId })).statusCode).toBe(200);
    expect((await call(student, 'POST', `/api/commerce/orders/${second.id}/simulate`, { eventId })).statusCode).toBe(409);
    expect((await call(student, 'GET', `/api/commerce/orders/${second.id}`)).json().order.status).toBe('pending');
    expect((await purchases(student.orgId)).rowCount).toBe(1);
  });

  it('compra curso e créditos atomicamente na versão e preço aceitos, mesmo após arquivo', async () => {
    const { student, operator } = await fixture(); const curriculum = await course(student);
    const item = await offer(student, operator, { title: 'Curso com práticas', kind: 'course', courseVersionId: curriculum.versionId, coursePriceCents: 12990, creditAmount: 7 });
    const purchase = await order(student, item.id);
    await db.query("UPDATE courses SET status='archived' WHERE id=$1", [curriculum.courseId]);
    expect((await call(await person(student, 'student'), 'POST', '/api/commerce/orders', { offerId: item.id, clientKey: randomUUID() })).statusCode).toBe(409);
    const result = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID(), status: 'approved' });
    expect(result.statusCode, result.body).toBe(200); expect(result.json().order).toMatchObject({ status: 'paid', amountCents: 12990 });
    const entitlement = (await call(student, 'GET', `/api/commerce/orders/${purchase.id}`)).json().entitlement;
    expect(entitlement.creditEntryId).toBeTruthy(); expect(entitlement.courseEnrollmentId).toBeTruthy();
    expect((await db.query('SELECT version_id,source,source_ref FROM course_enrollments WHERE id=$1', [entitlement.courseEnrollmentId])).rows[0]).toEqual({ version_id: curriculum.versionId, source: 'purchase', source_ref: purchase.id });
    expect((await getWallet(db, student)).balance).toBe(7);
  });

  it('impede compra duplicada de curso e não concede parcialmente se o aluno já foi matriculado', async () => {
    const { student, operator } = await fixture(); const curriculum = await course(student, 5);
    const item = await offer(student, operator, { title: 'Curso', kind: 'course', courseVersionId: curriculum.versionId, coursePriceCents: 1000, creditAmount: 5 });
    const purchase = await order(student, item.id);
    expect((await call(student, 'POST', '/api/commerce/orders', { offerId: item.id, clientKey: randomUUID() })).statusCode).toBe(409);
    await db.query("INSERT INTO course_enrollments(org_id,course_id,version_id,student_id,source,source_ref) VALUES($1,$2,$3,$4,'assignment','other')", [student.orgId, curriculum.courseId, curriculum.versionId, student.userId]);
    const failed = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID(), status: 'approved' });
    expect(failed.statusCode, failed.body).toBe(409);
    expect((await purchases(student.orgId)).rowCount).toBe(0); expect((await payments(student.orgId)).rowCount).toBe(0);
    expect((await call(student, 'GET', `/api/commerce/orders/${purchase.id}`)).json()).toMatchObject({ order: { status: 'pending' }, entitlement: null });
    const cancelled = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID(), status: 'cancelled' });
    expect(cancelled.json().order.status).toBe('cancelled');
    expect((await call(student, 'POST', '/api/commerce/orders', { offerId: item.id, clientKey: randomUUID() })).statusCode).toBe(409);
  });

  it('desativar cursos bloqueia aquisição e pagamento sem afetar pacote de créditos', async () => {
    const { student, operator } = await fixture(); const curriculum = await course(student, 2);
    const courseItem = await offer(student, operator, { title: 'Curso', kind: 'course', courseVersionId: curriculum.versionId, coursePriceCents: 1000, creditAmount: 2 });
    const pack = await offer(student, operator), purchase = await order(student, courseItem.id);
    await db.query("UPDATE orgs SET settings=settings||'{\"coursesEnabled\":false}'::jsonb WHERE id=$1", [student.orgId]);
    expect((await call(student, 'GET', '/api/commerce/catalog')).json().items.map((item: { id: string }) => item.id)).toEqual([pack.id]);
    expect((await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID(), status: 'approved' })).statusCode).toBe(409);
    expect((await purchases(student.orgId)).rowCount).toBe(0);
    const packOrder = await order(student, pack.id);
    expect((await call(student, 'POST', `/api/commerce/orders/${packOrder.id}/simulate`, { eventId: randomUUID() })).json().order.status).toBe('paid');
  });

  it('curso deriva concessão da versão e bloqueia override ou antecipação de créditos de progresso', async () => {
    const { student, operator } = await fixture();
    const acquisition = await course(student, 12), progress = await course(student, 50, 'progress');
    const input = { title: 'Curso derivado', kind: 'course', courseVersionId: acquisition.versionId, coursePriceCents: 1000 };
    const acquired = await offer(student, operator, input);
    expect(acquired.creditAmount).toBe(12);
    expect((await call(operator, 'POST', `${central(student)}/catalog`, { ...input, creditAmount: 13 })).statusCode).toBe(400);
    const progressive = await offer(student, operator, { ...input, courseVersionId: progress.versionId });
    expect(progressive.creditAmount).toBe(0);
    expect((await call(operator, 'POST', `${central(student)}/catalog`, { ...input, courseVersionId: progress.versionId, creditAmount: 50 })).statusCode).toBe(400);
    const purchase = await order(student, progressive.id);
    expect((await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID() })).json().order.status).toBe('paid');
    expect((await purchases(student.orgId)).rowCount).toBe(0);
    const options = await call(operator, 'GET', `${central(student)}/courses`);
    expect(options.statusCode).toBe(200);
    expect(options.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ versionId: acquisition.versionId, creditMode: 'acquisition', acquisitionCredits: 12 }),
      expect.objectContaining({ versionId: progress.versionId, creditMode: 'progress' }),
    ]));
  });

  it('rejeita curso de outra organização e falha no pagamento central para aluno suspenso', async () => {
    const { student, operator } = await fixture(); const outsider = await tenant(), curriculum = await course(outsider);
    expect((await call(operator, 'POST', `${central(student)}/catalog`, { title: 'Alheio', kind: 'course', courseVersionId: curriculum.versionId, coursePriceCents: 100, creditAmount: 0 })).statusCode).toBe(404);
    const purchase = await order(student, (await offer(student, operator)).id);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [student.userId]);
    expect((await call(operator, 'POST', `${central(student)}/orders/${purchase.id}/simulate`, { eventId: randomUUID() })).statusCode).toBe(409);
    expect((await payments(student.orgId)).rowCount).toBe(0); expect((await purchases(student.orgId)).rowCount).toBe(0);
  });

  it.each(['logout', 'suspension', 'role', 'org'] as const)('revalida %s depois de aguardar lock antes de aprovar pagamento', async reason => {
    const { student, operator } = await fixture(); const purchase = await order(student, (await offer(student, operator)).id);
    const blocker = await db.pool.connect(); let pending: ReturnType<typeof call> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [student.orgId]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID() });
      let queued = false;
      for (let i = 0; i < 200 && !queued; i++) {
        queued = (await control.query<{ queued: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_locks h JOIN pg_locks w ON h.locktype=w.locktype AND h.database IS NOT DISTINCT FROM w.database AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid WHERE h.pid=$1 AND h.locktype='advisory' AND h.granted AND NOT w.granted) AS queued`, [pid])).rows[0].queued;
        if (!queued) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(queued).toBe(true);
      if (reason === 'logout') await blocker.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2', [student.orgId, student.userId]);
      else if (reason === 'suspension') await blocker.query("UPDATE users SET status='suspended' WHERE id=$1", [student.userId]);
      else if (reason === 'role') await blocker.query("UPDATE users SET roles=ARRAY['teacher'] WHERE id=$1", [student.userId]);
      else await blocker.query("UPDATE orgs SET status='suspended' WHERE id=$1", [student.orgId]);
      await blocker.query('COMMIT');
      expect((await pending).statusCode).toBe(reason === 'role' ? 403 : 401);
      expect((await payments(student.orgId)).rowCount).toBe(0); expect((await purchases(student.orgId)).rowCount).toBe(0);
      expect((await db.query('SELECT status FROM commerce_orders WHERE id=$1', [purchase.id])).rows[0].status).toBe('pending');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending?.catch(() => {}); }
  });

  it('cenário configurado fora da transação preserva intenção no replay sem status explícito', async () => {
    const { student, operator } = await fixture(); const purchase = await order(student, (await offer(student, operator)).id);
    let status: SimulatedPaymentStatus = 'pending';
    // Isolated module instance exercises the provider injection even after the main app registers its default adapter.
    const injected = Fastify(); await injected.register(cookie); injected.decorate('db', db);
    injected.setErrorHandler((error, _request, reply) => { const problem = error as { statusCode?: number; message?: string }; return reply.code(problem.statusCode ?? 500).send({ error: problem.message }); });
    await registerCommerce(injected, { defaultPaymentScenario: async () => { await db.query('SELECT 1'); return status; } });
    try {
      const eventId = randomUUID();
      const pending = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId }, injected);
      expect(pending.json()).toMatchObject({ applied: false, replay: false, order: { status: 'pending' } });
      status = 'approved';
      const replay = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId }, injected);
      expect(replay.json()).toMatchObject({ applied: false, replay: true, order: { status: 'pending' } });
      expect((await purchases(student.orgId)).rowCount).toBe(0);
      const approved = await call(student, 'POST', `/api/commerce/orders/${purchase.id}/simulate`, { eventId: randomUUID() }, injected);
      expect(approved.json()).toMatchObject({ applied: true, order: { status: 'paid' } });
      expect((await purchases(student.orgId)).rowCount).toBe(1);
    } finally { await injected.close(); }
  });
});
