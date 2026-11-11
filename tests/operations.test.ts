import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { MockEvaluationProvider } from '../server/evaluation/provider.js';
import { runEvaluationJob } from '../server/evaluation/worker.js';
import { defaultOperationPolicy } from '../server/operation-policy.js';
import { getWallet, grantCredits, reserveCredits } from '../server/wallet.js';

interface Actor { orgId: string; userId: string; host: string; cookie: string }

describe('controles operacionais e reconciliação', () => {
  const schema = `operations_test_${randomUUID().replaceAll('-', '')}`;
  const database = process.env.DATABASE_URL ?? localDatabaseUrl;
  const isolated = new URL(database);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  const control = createDatabase(database);
  const db = createDatabase(isolated.toString());
  let directory: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    await control.query(`CREATE SCHEMA ${schema}`);
    const migrations = new URL('../server/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await db.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    directory = await mkdtemp(join(tmpdir(), 'matraca-operations-'));
    app = await createApp({ databaseUrl: isolated.toString(), storageRoot: join(directory, 'objects') });
  });

  afterAll(async () => {
    await app?.close();
    await db.close();
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function actor(role: 'student' | 'org_admin' | 'operator', orgId: string = randomUUID()): Promise<Actor> {
    const userId = randomUUID();
    const slug = `ops-${orgId}`;
    const host = `${slug}.localhost`;
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,$2,'Operação de teste',$3) ON CONFLICT DO NOTHING",
      [orgId, slug, role === 'operator' ? 'backoffice' : 'partner']);
    await db.query('INSERT INTO domains(hostname,org_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [host, orgId]);
    await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,$3,'Pessoa de teste',$4,'active')",
      [userId, orgId, `${userId}@example.test`, [role]]);
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
      [orgId, userId, host, createHash('sha256').update(token).digest('hex')]);
    return { orgId, userId, host, cookie: `matraca_session=${token}` };
  }

  function call(who: Actor, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) {
    return app.inject({ method, url, headers: { host: who.host, cookie: who.cookie, 'x-matraca-request': '1' }, ...(payload ? { payload } : {}) });
  }

  async function recording(who: Actor) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO recordings(id,org_id,student_id,object_key,filename,mime_type,byte_length,duration_us,has_audio,has_video,
       container,probe,objective,purpose,scenario,maximum_seconds,source)
       VALUES($1,$2,$3,$4,'fala.wav','audio/wav',10000,30000000,true,false,'wav','{}','Uma fala de teste','free','one_on_one',300,'upload')`,
      [id, who.orgId, who.userId, `test-recordings/${id}`],
    );
    return id;
  }

  function ops(who: Actor) { return `/api/backoffice/ops/${who.orgId}`; }

  async function fund(who: Actor) {
    await grantCredits(db, { ...who, amount: 5, source: 'manual', sourceRef: 'fixture', eventKey: randomUUID(), reason: 'Teste operacional' });
  }

  it('salva política com CAS, aplica frequência e cenário padrão, preserva replay e custo separado', async () => {
    const student = await actor('student');
    const operator = await actor('operator');
    const admin = await actor('org_admin', student.orgId);
    await fund(student);
    const base = ops(student);
    expect((await call(admin, 'GET', base)).statusCode).toBe(403);
    expect((await call(operator, 'GET', ops(operator))).statusCode).toBe(404);
    const config = { ...defaultOperationPolicy, maxConcurrentEvaluations: 1, maxEvaluationsPerHour: 1, simulatedCentsPerMinute: 83, evaluationScenario: 'transient' };
    const saved = await call(operator, 'PUT', `${base}/policy`, { config, expectedRevision: 0 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await call(operator, 'PUT', `${base}/policy`, { config, expectedRevision: 0 })).statusCode).toBe(409);
    const input = { recordingId: await recording(student), clientKey: randomUUID() };
    const other = { recordingId: await recording(student), clientKey: randomUUID() };
    const requested = await call(student, 'POST', '/api/evaluations', input);
    expect(requested.statusCode, requested.body).toBe(202);
    const id = requested.json().evaluation.id;
    expect((await call(student, 'POST', '/api/evaluations', other)).statusCode).toBe(429);
    await runEvaluationJob(db, new MockEvaluationProvider());
    expect((await db.query('SELECT scenario FROM evaluation_requests WHERE id=$1', [id])).rows[0].scenario).toBe('transient');
    const replay = await call(student, 'POST', '/api/evaluations', input);
    expect(replay.json().evaluation.id).toBe(id);
    const advanced = await call(operator, 'POST', `${base}/jobs/${id}/retry`);
    expect(advanced.statusCode, advanced.body).toBe(200);
    await runEvaluationJob(db, new MockEvaluationProvider());
    expect((await call(student, 'POST', '/api/evaluations', other)).statusCode).toBe(429);
    const dashboard = await call(operator, 'GET', `${base}?studentId=${student.userId}`);
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    expect(dashboard.json()).toMatchObject({
      usage: { recordings: 2, orders: 1, processed: 1, evaluatedMicroseconds: 30_000_000 },
      credits: { granted: 5, consumed: 1, balance: 4, reserved: 0 },
      estimatedCost: { cents: 42, centsPerMinute: 83 },
    });
    expect((await call(operator, 'GET', `${base}/audit?event=evaluation_job_requeued`)).json().total).toBe(1);
    expect((await call(operator, 'POST', `${base}/jobs/${id}/retry`)).statusCode).toBe(409);
  });

  it('reconcilia apenas reserva sem avaliação ativa ou concluída', async () => {
    const student = await actor('student');
    const operator = await actor('operator');
    await fund(student);
    const orphan = await reserveCredits(db, { ...student, requestId: 'fixture-orphan', durationMicroseconds: 30_000_000 });
    const order = await call(student, 'POST', '/api/evaluations', { recordingId: await recording(student), clientKey: randomUUID() });
    expect(order.statusCode, order.body).toBe(202);
    const list = await call(operator, 'GET', `${ops(student)}/reservations`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: orphan.id, canRelease: true }),
      expect.objectContaining({ requestId: order.json().evaluation.id, canRelease: false }),
    ]));
    const active = list.json().items.find((item: { id: string }) => item.id !== orphan.id);
    expect((await call(operator, 'POST', `${ops(student)}/reservations/${active.id}/release`, { reason: 'Teste de proteção' })).statusCode).toBe(409);
    const release = `${ops(student)}/reservations/${orphan.id}/release`;
    expect((await call(operator, 'POST', release, { reason: 'Reserva órfã confirmada' })).statusCode).toBe(200);
    expect((await call(operator, 'POST', release, { reason: 'Reserva órfã confirmada' })).statusCode).toBe(200);
    expect((await getWallet(db, student)).reserved).toBe(1);
    await runEvaluationJob(db, new MockEvaluationProvider());
    expect(await getWallet(db, student)).toMatchObject({ balance: 4, reserved: 0 });
  });

  it('aplica limite de upload e entrega de e-mail simulada sem expor destinatários', async () => {
    const student = await actor('student');
    const operator = await actor('operator');
    const config = { ...defaultOperationPolicy, maxRecordingBytes: 1024, mailMode: 'suppressed' };
    expect((await call(operator, 'PUT', `${ops(student)}/policy`, { config, expectedRevision: 0 })).statusCode).toBe(200);
    const options = await call(student, 'GET', '/api/recordings/options?purpose=free');
    expect(options.json().constraints.maximumBytes).toBe(1024);
    const boundary = 'matraca-ops-file';
    const media = await readFile(new URL('./fixtures/media/media-recorder.webm', import.meta.url));
    expect(media.length).toBeGreaterThan(1024);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify({ purpose: 'free', objective: 'Teste', source: 'upload' })}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.webm"\r\nContent-Type: video/webm\r\n\r\n`),
      media, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.inject({ method: 'POST', url: '/api/recordings', headers: {
      host: student.host, cookie: student.cookie, 'x-matraca-request': '1', 'content-type': `multipart/form-data; boundary=${boundary}`,
    }, payload });
    expect(upload.statusCode, upload.body).toBe(413);
    expect((await db.query('SELECT id FROM recordings WHERE org_id=$1', [student.orgId])).rowCount).toBe(0);
    expect((await call(student, 'POST', '/api/auth/request', { email: `${student.userId}@example.test` })).statusCode).toBe(202);
    expect((await db.query('SELECT id FROM auth_tokens WHERE org_id=$1', [student.orgId])).rowCount).toBe(0);
    expect((await call(operator, 'PUT', `${ops(student)}/policy`, { config: { ...config, mailMode: 'failure' }, expectedRevision: 1 })).statusCode).toBe(200);
    const known = await call(student, 'POST', '/api/auth/request', { email: `${student.userId}@example.test` });
    const unknown = await call(student, 'POST', '/api/auth/request', { email: 'unknown@example.test' });
    expect(known.statusCode).toBe(500);
    expect(unknown.body).toBe(known.body);
  });

  it('usa callbacks reais do app por organização para pagamento omitido e relógio financeiro, preservando replays', async () => {
    const operator = await actor('operator');
    const nativeOrgId = randomUUID();
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,$2,'Matraca sintética','matraca')", [nativeOrgId, `native-${nativeOrgId}`]);
    const buyer = await actor('student', nativeOrgId);
    const partner = await actor('org_admin');
    const prices = { mode: 'volume', tiers: [{ from: 1, to: null, unitPriceCents: 90 }] };
    const catalog = `/api/backoffice/commerce/orgs/${buyer.orgId}/catalog`;
    const created = await call(operator, 'POST', catalog, { title: 'Cinco práticas', kind: 'credits', creditAmount: 5, priceTable: prices });
    expect(created.statusCode, created.body).toBe(201);
    const offerId = created.json().offer.id;
    expect((await call(operator, 'POST', `${catalog}/${offerId}/publish`, { expectedRevision: 1 })).statusCode).toBe(200);

    const nativePolicy = { ...defaultOperationPolicy, paymentScenario: 'declined', clockOverride: '2099-02-02T12:00:00Z' };
    expect((await call(operator, 'PUT', `${ops(buyer)}/policy`, { expectedRevision: 0, config: nativePolicy })).statusCode).toBe(200);
    const declinedOrder = await call(buyer, 'POST', '/api/commerce/orders', { offerId, clientKey: randomUUID() });
    expect(declinedOrder.statusCode, declinedOrder.body).toBe(201);
    const declinedPath = `/api/commerce/orders/${declinedOrder.json().order.id}/simulate`, declinedEvent = { eventId: randomUUID() };
    const declined = await call(buyer, 'POST', declinedPath, declinedEvent); // No status: use target-organization policy.
    expect(declined.statusCode, declined.body).toBe(200);
    expect(declined.json()).toMatchObject({ order: { status: 'declined' }, applied: true, replay: false });
    expect((await db.query("SELECT id FROM wallet_entries WHERE org_id=$1 AND source='purchase'", [buyer.orgId])).rowCount).toBe(0);

    expect((await call(operator, 'PUT', `${ops(buyer)}/policy`, { expectedRevision: 1, config: { ...nativePolicy, paymentScenario: 'approved' } })).statusCode).toBe(200);
    const approvedOrder = await call(buyer, 'POST', '/api/commerce/orders', { offerId, clientKey: randomUUID() });
    expect(approvedOrder.statusCode, approvedOrder.body).toBe(201);
    const approvedPath = `/api/commerce/orders/${approvedOrder.json().order.id}/simulate`, approvedEvent = { eventId: randomUUID() };
    const approved = await call(buyer, 'POST', approvedPath, approvedEvent);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ order: { status: 'paid', creditAmount: 5 }, applied: true, replay: false });
    expect((await call(buyer, 'POST', declinedPath, declinedEvent)).json()).toMatchObject({ order: { status: 'declined' }, replay: true });
    expect((await call(operator, 'PUT', `${ops(buyer)}/policy`, { expectedRevision: 2, config: nativePolicy })).statusCode).toBe(200);
    expect((await call(buyer, 'POST', approvedPath, approvedEvent)).json()).toMatchObject({ order: { status: 'paid' }, replay: true });
    expect((await getWallet(db, buyer)).balance).toBe(5);
    expect((await db.query("SELECT id FROM wallet_entries WHERE org_id=$1 AND source='purchase'", [buyer.orgId])).rowCount).toBe(1);

    // Known synthetic coverage, with fixed historical dates independent of the machine's current month.
    const month = '2025-11', billing = `/api/backoffice/billing/orgs/${partner.orgId}`;
    await db.query("UPDATE billing_observation_coverage SET tracked_since='2025-11-01T03:00:00Z' WHERE org_id=$1", [partner.orgId]);
    const contract = { effectiveFrom: month, expectedRevision: 0, licenses: { organizationCents: 10_000, schoolCents: 1000, studentCents: 100 }, credits: prices };
    expect((await call(operator, 'POST', `${billing}/contracts`, contract)).statusCode).toBe(201);
    const partnerPolicy = { ...defaultOperationPolicy, clockOverride: '2025-11-15T12:00:00Z' };
    expect((await call(operator, 'PUT', `${ops(partner)}/policy`, { expectedRevision: 0, config: partnerPolicy })).statusCode).toBe(200);
    const open = await call(operator, 'GET', `${billing}/preview?month=${month}`);
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json().preview).toMatchObject({ provisional: true, financialNow: '2025-11-15T12:00:00.000Z', cutoff: '2025-12-01T03:00:00.000Z' });
    expect((await call(operator, 'POST', `${billing}/close`, { month })).statusCode).toBe(409);
    // Financial time does not expire or otherwise replace real authentication time.
    expect((await call(partner, 'GET', '/api/auth/session')).statusCode).toBe(200);

    expect((await call(operator, 'PUT', `${ops(partner)}/policy`, { expectedRevision: 1, config: { ...partnerPolicy, clockOverride: '2025-12-02T12:00:00Z' } })).statusCode).toBe(200);
    const closed = await call(operator, 'POST', `${billing}/close`, { month });
    expect(closed.statusCode, closed.body).toBe(201);
    const original = closed.json().invoice;
    expect(original).toMatchObject({ totalCents: 10_000, snapshot: { provisional: false, consumptionMonth: month, licenseMonth: '2025-12', financialNow: '2025-12-02T12:00:00.000Z' } });
    expect((await call(operator, 'PUT', `${ops(partner)}/policy`, { expectedRevision: 2, config: partnerPolicy })).statusCode).toBe(200);
    expect((await call(operator, 'POST', `${billing}/contracts`, { ...contract, expectedRevision: 1, licenses: { ...contract.licenses, organizationCents: 20_000 } })).statusCode).toBe(409);
    const frozen = await call(partner, 'GET', `/api/billing/preview?month=${month}`);
    expect(frozen.statusCode, frozen.body).toBe(200);
    expect(frozen.json()).toEqual({ closedInvoiceId: original.id, preview: original.snapshot });
    const repeated = await call(operator, 'POST', `${billing}/close`, { month });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toEqual({ invoice: original, replay: true });
    expect((await db.query('SELECT id FROM billing_invoices WHERE org_id=$1', [partner.orgId])).rowCount).toBe(1);
  });
});
