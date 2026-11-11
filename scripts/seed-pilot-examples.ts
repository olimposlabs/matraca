import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import type { HTTPMethods, LightMyRequestResponse } from 'fastify';
import { createApp } from '../server/app.js';
import { closeBillingPeriod } from '../server/billing.js';
import { nextMonth } from '../server/billing-preview.js';
import { configuration } from '../server/config.js';
import type { CourseDocument } from '../server/course-model.js';
import { MockEvaluationProvider } from '../server/evaluation/provider.js';
import { runEvaluationJob } from '../server/evaluation/worker.js';
import { seedId } from './seed-id.js';

const { values } = parseArgs({ options: { invoice: { type: 'boolean', default: false } } });
const config = configuration();
const database = new URL(config.databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)) {
  throw new Error('Exemplos sintéticos exigem um PostgreSQL local.');
}
const schema = new URLSearchParams(database.search).get('options')?.match(/^-c search_path=(matraca_sandbox_[a-z][a-z0-9_]*)$/)?.[1];
if (values.invoice && !schema) throw new Error('Emita a fatura de exemplo em um sandbox para preservar a competência principal.');

const app = await createApp(config);
const guard = await app.db.pool.connect();
const sessions: { host: string; cookie: string }[] = [];
type Session = (method: HTTPMethods, url: string, payload?: object | Buffer, contentType?: string) => Promise<LightMyRequestResponse>;
const direct = { id: seedId('matraca'), host: 'matraca.localhost' };
const partner = { id: seedId('parceiro'), host: 'parceiro.matraca.localhost' };
const office = { id: seedId('backoffice'), host: 'backoffice.matraca.localhost' };
const directStudentId = seedId('matraca:aluno2@matraca.test');
const partnerStudentId = seedId('parceiro:aluno2@parceiro.test');
const operatorId = seedId('backoffice:operador@matraca.test');
const teacherId = seedId('parceiro:professor1@parceiro.test');
const priceTable = { mode: 'volume', tiers: [{ from: 1, to: 9, unitPriceCents: 100 }, { from: 10, to: null, unitPriceCents: 90 }] };

async function session(org: typeof direct, id: string): Promise<Session> {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  const token = await app.db.query(`
    INSERT INTO auth_tokens(org_id,user_id,hostname,token_hash,purpose,expires_at)
    SELECT org_id,id,$3,$4,'login',now()+interval '1 minute'
    FROM users WHERE org_id=$1 AND id=$2 AND status='active' AND archived_at IS NULL
  `, [org.id, id, org.host, hash]);
  if (!token.rowCount) throw new Error('Persona ativa do seed não encontrada.');
  const login = await app.inject({ method: 'GET', url: `/api/auth/consume?token=${raw}`, headers: { host: org.host } });
  const cookie = login.cookies.find(item => item.name === 'matraca_session');
  if (!cookie) throw new Error('Não foi possível iniciar a sessão da persona sintética.');
  const credential = { host: org.host, cookie: `${cookie.name}=${cookie.value}` };
  sessions.push(credential);
  return async (method, url, payload, contentType) => {
    const response = await app.inject({
      method, url, payload, headers: { ...credential, 'x-matraca-request': '1', ...(contentType ? { 'content-type': contentType } : {}) },
    });
    if (response.statusCode >= 300) throw new Error(`${method} ${url} retornou ${response.statusCode}. ${response.json<{ error: string }>().error}`);
    return response;
  };
}

async function seedCatalog() {
  const { rows: [course] } = await app.db.query<{ id: string; version_id: string; document: CourseDocument }>(`
    SELECT c.id,v.id AS version_id,v.document
    FROM courses c JOIN course_versions v ON v.course_id=c.id AND v.org_id=c.org_id
    WHERE c.org_id=$1 AND c.id=$2 AND c.status='published' ORDER BY v.version DESC LIMIT 1
  `, [direct.id, seedId('course:matraca:base')]);
  if (!course) throw new Error('Publique o curso base do seed antes de incluir os exemplos.');
  const offerId = seedId('catalog:pack:10');
  await app.db.transaction(async client => {
    await client.query(`
      INSERT INTO commerce_offers(id,org_id,title,kind,status,data,created_by)
      VALUES($1,$2,'Pacote de prática · 10 créditos','credits','published',$3,$4) ON CONFLICT (id) DO NOTHING
    `, [offerId, direct.id, { creditAmount: 10, priceTable }, operatorId]);
    await client.query(`
      INSERT INTO commerce_offers(id,org_id,title,kind,status,data,course_id,course_version_id,created_by)
      VALUES($1,$2,'Curso de oratória Matraca','course','published',$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING
    `, [seedId('catalog:course:base'), direct.id, {
      creditAmount: course.document.creditMode === 'acquisition' ? course.document.acquisitionCredits : 0,
      coursePriceCents: 9900,
    }, course.id, course.version_id, operatorId]);
  });
  return offerId;
}

async function seedPurchase(offerId: string) {
  const clientKey = seedId('pilot:purchase');
  const old = await app.db.query<{ id: string; status: string }>(`
    SELECT id,status FROM commerce_orders WHERE org_id=$1 AND student_id=$2 AND client_key=$3
  `, [direct.id, directStudentId, clientKey]);
  if (old.rows[0]?.status === 'paid') return old.rows[0].id;
  const request = await session(direct, directStudentId);
  const { order } = (await request('POST', '/api/commerce/orders', { offerId, clientKey })).json<{ order: { id: string } }>();
  const paid = (await request('POST', `/api/commerce/orders/${order.id}/simulate`, {
    eventId: seedId('pilot:payment'), status: 'approved',
  })).json<{ order: { status: string } }>();
  if (paid.order.status !== 'paid') throw new Error('O pedido sintético não foi confirmado.');
  return order.id;
}

async function seedEvaluation() {
  const clientKey = seedId('pilot:evaluation');
  const previous = (await app.db.query<{ id: string }>('SELECT id FROM evaluation_requests WHERE org_id=$1 AND student_id=$2 AND client_key=$3',
    [partner.id, partnerStudentId, clientKey])).rows[0];
  if (previous) return await finishEvaluation(previous.id);
  const { rows: [enrollment] } = await app.db.query<{ id: string; document: CourseDocument }>(`
    SELECT e.id,v.document FROM course_enrollments e JOIN course_versions v ON v.id=e.version_id AND v.org_id=e.org_id
    WHERE e.org_id=$1 AND e.student_id=$2 AND e.course_id=$3 AND e.status='active'
  `, [partner.id, partnerStudentId, seedId('course:parceiro:base')]);
  const unit = enrollment?.document.modules[0]?.units[0];
  if (!unit) throw new Error('A primeira aula da matrícula sintética não está disponível.');
  const request = await session(partner, partnerStudentId);
  const studied = await app.db.query('SELECT 1 FROM course_unit_progress WHERE enrollment_id=$1 AND unit_id=$2 AND studied_at IS NOT NULL', [enrollment.id, unit.id]);
  if (!studied.rowCount) await request('PUT', `/api/journey/courses/${enrollment.id}/study`, {
    unitId: unit.id, checked: unit.checklist.map((_, index) => index), completeStudy: true,
  });
  const objective = 'Demonstração sintética · praticar uma abertura clara';
  const oldRecording = (await app.db.query<{ id: string }>(`
    SELECT id FROM recordings WHERE org_id=$1 AND student_id=$2 AND enrollment_id=$3 AND unit_id=$4 AND objective=$5 ORDER BY created_at LIMIT 1
  `, [partner.id, partnerStudentId, enrollment.id, unit.id, objective])).rows[0];
  let recordingId = oldRecording?.id;
  if (!recordingId) {
    const media = await readFile(new URL('../tests/fixtures/media/media-recorder.webm', import.meta.url));
    const form = new FormData();
    form.append('metadata', JSON.stringify({ purpose: 'course', source: 'upload', objective, enrollmentId: enrollment.id, unitId: unit.id }));
    form.append('file', new Blob([new Uint8Array(media)], { type: 'video/webm' }), 'demonstracao-sintetica.webm');
    const body = new Response(form);
    const response = await request('POST', '/api/recordings', Buffer.from(await body.arrayBuffer()), body.headers.get('content-type') ?? undefined);
    recordingId = response.json<{ recording: { id: string } }>().recording.id;
  }
  const response = await request('POST', '/api/evaluations', { recordingId, clientKey, scenario: 'success' });
  return await finishEvaluation(response.json<{ evaluation: { id: string } }>().evaluation.id);
}

async function finishEvaluation(id: string) {
  const provider = new MockEvaluationProvider();
  for (let attempt = 0; attempt < 20; attempt++) {
    const { rows: [job] } = await app.db.query<{ status: string; recording_id: string; completed_at: Date }>(
      'SELECT status,recording_id,completed_at FROM evaluation_requests WHERE org_id=$1 AND id=$2', [partner.id, id],
    );
    if (job.status === 'completed') return { id, ...job };
    if (job.status !== 'queued' && job.status !== 'processing') break;
    if (!await runEvaluationJob(app.db, provider)) await delay(250);
  }
  throw new Error('A avaliação sintética não foi concluída. Consulte os jobs no backoffice.');
}

async function seedMentoring(evaluation: Awaited<ReturnType<typeof finishEvaluation>>) {
  const clientKey = seedId('pilot:mentoring');
  const existing = (await app.db.query<{ id: string }>('SELECT id FROM mentoring_sessions WHERE org_id=$1 AND teacher_id=$2 AND client_key=$3',
    [partner.id, teacherId, clientKey])).rows[0];
  const planKey = seedId('pilot:plan');
  if (existing && (await app.db.query('SELECT 1 FROM individual_plan_items WHERE org_id=$1 AND created_by=$2 AND client_key=$3', [partner.id, teacherId, planKey])).rowCount) return existing.id;
  const request = await session(partner, teacherId);
  const path = `/api/mentoring/students/${partnerStudentId}`;
  const mentoringId = existing?.id ?? (await request('POST', `${path}/sessions`, {
    clientKey, occurredAt: evaluation.completed_at.toISOString(), evaluationId: evaluation.id,
    difficulties: ['Começar com uma mensagem principal.'], guidance: 'Exemplo de mentoria com dados sintéticos. Comece pela ideia que o público deve lembrar.',
    actions: ['Gravar uma abertura com uma frase e uma pausa.'],
  })).json<{ session: { id: string } }>().session.id;
  await request('POST', `${path}/plan`, {
    clientKey: planKey, kind: 'task', title: 'Praticar uma abertura em uma frase', mentoringSessionId: mentoringId,
  });
  return mentoringId;
}

async function seedBilling() {
  const { rows: [period] } = await app.db.query<{ month: string }>("SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS month");
  if (!(await app.db.query('SELECT 1 FROM billing_contract_versions WHERE org_id=$1 LIMIT 1', [partner.id])).rowCount) {
    const request = await session(office, operatorId);
    await request('POST', `/api/backoffice/billing/orgs/${partner.id}/contracts`, {
      effectiveFrom: period.month, expectedRevision: 0,
      licenses: { organizationCents: 100000, schoolCents: 10000, studentCents: 100 },
      credits: priceTable, extraTerms: 'Valores ilustrativos para a demonstração local.',
    });
  }
  if (!values.invoice) return undefined;
  const seeded = await app.db.query<{ month: string }>(
    "SELECT value->>'month' AS month FROM app_metadata WHERE key='pilot_example_invoice'",
  );
  const month = seeded.rows[0]?.month ?? period.month;
  const next = nextMonth(month);
  const { invoice } = await closeBillingPeriod(app.db, {
    orgId: partner.id, month, actorId: operatorId, now: new Date(`${next}-02T12:00:00Z`),
  });
  await app.db.query("INSERT INTO app_metadata(key,value) VALUES('pilot_example_invoice',$1) ON CONFLICT (key) DO NOTHING", [{ month, invoiceId: invoice.id }]);
  return invoice.id;
}

try {
  await guard.query("SELECT pg_advisory_lock(hashtextextended(current_schema() || ':pilot-examples',14))");
  const demo = await guard.query("SELECT 1 FROM app_metadata WHERE key='demo' AND value->>'createdBy'='seed'");
  if (!demo.rowCount) throw new Error('Execute o seed local antes dos exemplos.');
  const orderId = await seedPurchase(await seedCatalog());
  const evaluation = await seedEvaluation();
  const mentoringId = await seedMentoring(evaluation);
  const invoiceId = await seedBilling();
  process.stdout.write(JSON.stringify({ orderId, evaluationId: evaluation.id, recordingId: evaluation.recording_id, mentoringId, invoiceId }) + '\n');
} finally {
  try {
    for (const credential of sessions) {
      await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...credential, 'x-matraca-request': '1' } });
    }
  } finally {
    guard.release(true);
    await app.close();
  }
}
