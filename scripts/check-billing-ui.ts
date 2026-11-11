import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type APIRequestContext, type Browser, type BrowserContext } from '@playwright/test';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { emptyCourse, type CourseDocument } from '../server/course-model.js';
import { createDatabase } from '../server/db.js';
import { DEFAULT_BRANDING } from '../server/organizations.js';
import { MockEvaluationProvider } from '../server/evaluation/provider.js';
import { runEvaluationJob } from '../server/evaluation/worker.js';
import { grantCredits } from '../server/wallet.js';

// Run after npm run build. Real HTTP/API/database, separate schema and storage; only AI is mocked.
// Historical November fixtures are explicitly synthetic, never inferred from current production state.
const port = 3015, consumptionMonth = '2025-11', licenseMonth = '2025-12';
const schema = `billing_ui_${randomUUID().replaceAll('-', '')}`;
const temporary = await mkdtemp(join(tmpdir(), 'matraca-billing-ui-'));
const baseDatabaseUrl = process.env.DATABASE_URL ?? localDatabaseUrl;
const control = createDatabase(baseDatabaseUrl);
const url = new URL(baseDatabaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
const db = createDatabase(url.toString());
const centralBase = `http://localhost:${port}`, partnerBase = `http://127.0.0.1:${port}`;
let app: Awaited<ReturnType<typeof createApp>> | undefined, browser: Browser | undefined;
interface Actor { id: string; token: string; host: string; orgId: string }
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../server/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, migrations), 'utf8'));
  const orgId = randomUUID(), centralOrgId = randomUUID();
  await db.query("INSERT INTO orgs(id,slug,name,kind,branding) VALUES($1,'billing-ui','Escola de demonstração','partner',$3),($2,'billing-operator','Operação Matraca','backoffice',$3)", [orgId, centralOrgId, { ...DEFAULT_BRANDING, _revision: 0 }]);
  await db.query("INSERT INTO domains(hostname,org_id) VALUES('127.0.0.1',$1),('localhost',$2)", [orgId, centralOrgId]);
  await db.query("UPDATE billing_observation_coverage SET tracked_since='2025-11-01T03:00:00Z' WHERE org_id=$1", [orgId]);
  async function actor(roles: string[], targetOrgId: string, host: string, name: string): Promise<Actor> {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,$3,$4,$5,'active')", [id, targetOrgId, `${id}@example.test`, name, roles]);
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [targetOrgId, id, host, createHash('sha256').update(token).digest('hex')]);
    return { id, token, host, orgId: targetOrgId };
  }
  const operator = await actor(['operator'], centralOrgId, 'localhost', 'Operador sintético');
  const manager = await actor(['org_admin'], orgId, '127.0.0.1', 'Administrador sintético');
  const student = await actor(['student', 'teacher'], orgId, '127.0.0.1', 'Aluno com papéis cumulativos');
  const students = [student.id];
  for (let index = 1; index < 50; index++) {
    const id = randomUUID(); students.push(id);
    await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,$3,$4,ARRAY['student'],'active')", [id, orgId, `${id}@example.test`, `Aluno sintético ${index}`]);
  }
  for (const id of students) await db.query("INSERT INTO billing_student_history(org_id,user_id,observed_at,active,student,accepted) VALUES($1,$2,'2025-11-01T04:00:00Z',true,true,true)", [orgId, id]);
  // Exclude teacher-only and unaccepted student, even though both currently have active accounts.
  const teacherOnly = await actor(['teacher'], orgId, '127.0.0.1', 'Professor sem papel aluno');
  const unaccepted = await actor(['student'], orgId, '127.0.0.1', 'Aluno sem aceite no corte');
  await db.query("INSERT INTO billing_student_history(org_id,user_id,observed_at,active,student,accepted) VALUES($1,$2,'2025-11-01T04:00:00Z',true,false,true),($1,$3,'2025-11-01T04:00:00Z',true,true,false)", [orgId, teacherOnly.id, unaccepted.id]);
  const schools = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of schools) {
    await db.query("INSERT INTO schools(id,org_id,name) VALUES($1,$2,'Escola sintética')", [id, orgId]);
    await db.query("INSERT INTO billing_school_history(org_id,school_id,observed_at,active) VALUES($1,$2,'2025-11-01T04:00:00Z',true)", [orgId, id]);
  }
  await db.query('INSERT INTO student_schools(org_id,school_id,student_id) VALUES($1,$2,$3)', [orgId, schools[0], student.id]);
  for (const state of ['active', 'closed']) {
    const classId = randomUUID();
    await db.query('INSERT INTO classes(id,org_id,school_id,name,status) VALUES($1,$2,$3,$4,$5)', [classId, orgId, schools[0], `Turma ${state}`, state]);
    await db.query("INSERT INTO enrollments(org_id,class_id,school_id,student_id,status,ended_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $5='active' THEN NULL ELSE now() END)", [orgId, classId, schools[0], student.id, state === 'active' ? 'active' : 'completed']);
  }
  const grantId = randomUUID(), consumptionId = randomUUID();
  await db.query('INSERT INTO wallets(org_id,user_id) VALUES($1,$2)', [orgId, student.id]);
  await db.query(`INSERT INTO wallet_entries(id,org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,reason,created_at)
    VALUES($1,$2,$3,100,'grant','manual','fixture',$4,'synthetic','Fixture histórica sintética','2025-11-15T15:00:00Z')`, [grantId, orgId, student.id, randomUUID()]);
  await db.query("INSERT INTO credit_lots(entry_id,org_id,user_id,quantity,remaining,created_at) VALUES($1,$2,$3,100,0,'2025-11-15T15:00:00Z')", [grantId, orgId, student.id]);
  await db.query(`INSERT INTO wallet_entries(id,org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,reason,created_at)
    VALUES($1,$2,$3,-100,'consumption','evaluation','fixture',$4,'synthetic','Consumo histórico sintético','2025-11-15T15:00:00Z')`, [consumptionId, orgId, student.id, randomUUID()]);
  await db.query('INSERT INTO credit_allocations(debit_entry_id,lot_entry_id,org_id,user_id,amount) VALUES($1,$2,$3,$4,100)', [consumptionId, grantId, orgId, student.id]);
  await grantCredits(db, { orgId, userId: student.id, amount: 10, source: 'manual', sourceRef: 'billing-ui-course', eventKey: randomUUID(), reason: 'Saldo de teste para avaliação atual.' });

  app = await createApp({ databaseUrl: url.toString(), storageRoot: join(temporary, 'objects'), billingNow: () => new Date('2025-12-02T12:00:00Z') });
  assert.equal(app.hasRoute({ method: 'GET', url: '/api/billing/contracts' }), true, 'Integre registerBilling e construa a UI antes deste teste.');
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const errors: string[] = [];
  async function context(who: Actor): Promise<BrowserContext> {
    const result = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await result.addCookies([{ name: 'matraca_session', value: who.token, url: `http://${who.host}:${port}`, httpOnly: true, sameSite: 'Lax' }]);
    result.on('page', page => page.on('pageerror', error => errors.push(error.message))); return result;
  }
  const operatorContext = await context(operator), managerContext = await context(manager), studentContext = await context(student);
  async function request(requester: APIRequestContext, base: string, method: string, path: string, data?: unknown, expected = 200) {
    const response = await requester.fetch(`${base}${path}`, { method, headers: { 'x-matraca-request': '1' }, ...(data === undefined ? {} : { data }) });
    assert.equal(response.status(), expected, `${method} ${path}: status inesperado`); return response.json();
  }
  // Real course publication, study, media upload, queue and mock AI produce the baseline for J18.
  const courseDocument: CourseDocument = { ...emptyCourse('Clareza original'), completionCreditGrant: 0, modules: [{ id: 'module-1', title: 'Fundamentos', introductionMarkdown: '', units: [{ id: 'lesson-1', title: 'Uma ideia por vez', chapter: 'Clareza', kind: 'lesson', mode: 'content', bodyMarkdown: 'Conteúdo original preservado.', instructionMarkdown: 'Explique uma ideia em até trinta segundos.', checklist: ['Defini uma ideia central.'], references: [], assetIds: [], prerequisites: [], studyCreditGrant: 0, requiresEvaluation: true, activity: { maximumSeconds: 30, acceptedMedia: ['audio', 'video'], scenario: 'one_on_one', criteria: [{ id: 'clarity', title: 'Clareza original', weight: 1, enabled: true, modality: 'both', descriptors: ['Requer apoio', 'Parcial', 'Consistente', 'Flexível'] }] } }] }] };
  const created = await request(managerContext.request, partnerBase, 'POST', '/api/courses/manage', { title: courseDocument.title }, 201);
  const courseId = created.course.id as string;
  await request(managerContext.request, partnerBase, 'PUT', `/api/courses/manage/${courseId}`, { expectedRevision: 0, document: courseDocument });
  const firstVersion = (await request(managerContext.request, partnerBase, 'POST', `/api/courses/manage/${courseId}/publish`, { expectedRevision: 1 })).version;
  await request(managerContext.request, partnerBase, 'POST', `/api/courses/manage/${courseId}/assign`, { versionId: firstVersion.id, studentId: student.id });
  const originalCourse = await request(studentContext.request, partnerBase, 'GET', `/api/courses/${courseId}`);
  await request(studentContext.request, partnerBase, 'PUT', `/api/journey/courses/${originalCourse.enrollmentId}/study`, { unitId: 'lesson-1', checked: [0], completeStudy: true });
  const wav = Buffer.alloc(8044); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
  const uploaded = await studentContext.request.post(`${partnerBase}/api/recordings`, { headers: { 'x-matraca-request': '1' }, multipart: { metadata: JSON.stringify({ purpose: 'course', source: 'upload', enrollmentId: originalCourse.enrollmentId, unitId: 'lesson-1' }), file: { name: 'voz-sintetica.wav', mimeType: 'audio/wav', buffer: wav } } });
  assert.equal(uploaded.status(), 201); const recordingId = (await uploaded.json()).recording.id;
  const evaluationId = (await request(studentContext.request, partnerBase, 'POST', '/api/evaluations', { recordingId, clientKey: randomUUID(), scenario: 'success' }, 202)).evaluation.id;
  assert.equal(await runEvaluationJob(db, new MockEvaluationProvider()), true);
  const originalEvaluation = (await request(studentContext.request, partnerBase, 'GET', `/api/evaluations/${evaluationId}`)).evaluation;
  assert.equal(originalEvaluation.status, 'completed'); assert.equal(originalEvaluation.criteria[0].title, 'Clareza original');

  const page = await operatorContext.newPage();
  await page.goto(`${centralBase}/backoffice/billing`);
  await expect(page.getByRole('combobox', { name: 'Organização parceira', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('combobox', { name: 'Organização parceira', exact: true }).selectOption(orgId);
  await page.getByRole('button', { name: 'Contratos e preços', exact: true }).click();
  await page.getByLabel('Vigência a partir de', { exact: true }).fill(consumptionMonth);
  await page.getByLabel('Faixa 1: preço', { exact: true }).fill('0,90');
  await page.getByRole('button', { name: 'Calcular exemplo', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '1.440,00' })).toBeVisible();
  await page.getByRole('button', { name: 'Publicar contrato', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Versão contratual publicada' })).toBeVisible();
  await page.getByRole('button', { name: 'Prévia mensal', exact: true }).click();
  await page.getByLabel('Mês do consumo', { exact: true }).fill(consumptionMonth);
  await page.getByRole('button', { name: 'Consultar prévia', exact: true }).click();
  await expect(page.locator('.billing-total')).toContainText('1.440,00');
  await expect(page.locator('.billing-totals').first()).toContainText('3 escolas · 50 alunos');
  const closed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/close'));
  await page.getByRole('button', { name: 'Fechar competência simulada', exact: true }).click();
  const closeResponse = await closed; assert.equal(closeResponse.status(), 201); const originalInvoice = (await closeResponse.json()).invoice;
  await expect(page.getByRole('heading', { name: `Consumo de ${consumptionMonth}`, exact: true })).toBeVisible();
  assert.equal(originalInvoice.totalCents, 144000); assert.equal(originalInvoice.snapshot.licenseMonth, licenseMonth);
  assert.equal(originalInvoice.snapshot.snapshot.studentIds.length, 50); assert.equal(new Set(originalInvoice.snapshot.snapshot.studentIds).size, 50);
  assert.equal(originalInvoice.snapshot.usage.netCredits, 100);
  const centralPrefix = `/api/backoffice/billing/orgs/${orgId}`;
  const replay = await request(operatorContext.request, centralBase, 'POST', `${centralPrefix}/close`, { month: consumptionMonth });
  assert.equal(replay.replay, true); assert.equal(replay.invoice.id, originalInvoice.id);
  assert.equal((await db.query('SELECT count(*)::int AS total FROM billing_usage_allocations WHERE org_id=$1', [orgId])).rows[0].total, 1);
  await mkdir(resolve('.data'), { recursive: true });
  await page.screenshot({ path: resolve('.data/phase12-billing-j17.png'), fullPage: true });

  // Publish future prices and a changed rubric; old invoice/course/evaluation remain byte-for-byte stable.
  await page.getByRole('button', { name: 'Contratos e preços', exact: true }).click();
  await page.getByRole('button', { name: 'Usar como base', exact: true }).click();
  await page.getByLabel('Vigência a partir de', { exact: true }).fill('2026-01');
  await page.getByLabel('Organização / mês (R$)', { exact: true }).fill('1200,00');
  await page.getByLabel('Faixa 1: preço', { exact: true }).fill('2,00');
  const published = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/contracts'));
  await page.getByRole('button', { name: 'Publicar contrato', exact: true }).click(); assert.equal((await published).status(), 201);
  await expect(page.locator('.billing-contract-history .billing-panel')).toHaveCount(2);
  const revised = structuredClone(courseDocument); revised.title = 'Clareza revisada'; revised.modules[0].units[0].bodyMarkdown = 'Conteúdo revisado para novas matrículas.'; revised.modules[0].units[0].activity.criteria[0].title = 'Rubrica nova'; revised.modules[0].units[0].activity.criteria[0].weight = 2;
  await request(managerContext.request, partnerBase, 'PUT', `/api/courses/manage/${courseId}`, { expectedRevision: 1, document: revised });
  const nextVersion = (await request(managerContext.request, partnerBase, 'POST', `/api/courses/manage/${courseId}/publish`, { expectedRevision: 2 })).version;
  assert.equal(nextVersion.version, 2);
  const keptCourse = await request(studentContext.request, partnerBase, 'GET', `/api/courses/${courseId}`);
  assert.equal(keptCourse.versionId, firstVersion.id); assert.deepEqual(keptCourse.document, originalCourse.document);
  const keptEvaluation = (await request(studentContext.request, partnerBase, 'GET', `/api/evaluations/${evaluationId}`)).evaluation;
  assert.deepEqual(keptEvaluation.report, originalEvaluation.report); assert.deepEqual(keptEvaluation.criteria, originalEvaluation.criteria);
  const keptInvoice = (await request(operatorContext.request, centralBase, 'GET', `${centralPrefix}/invoices/${originalInvoice.id}`)).invoice;
  assert.deepEqual(keptInvoice.snapshot, originalInvoice.snapshot); assert.equal(keptInvoice.totalCents, 144000);
  const frozen = await request(operatorContext.request, centralBase, 'GET', `${centralPrefix}/preview?month=${consumptionMonth}`);
  assert.equal(frozen.closedInvoiceId, originalInvoice.id); assert.deepEqual(frozen.preview, originalInvoice.snapshot);

  // Organization administrator has the same immutable invoice and read-only controls.
  const partnerPage = await managerContext.newPage(); await partnerPage.goto(`${partnerBase}/admin/billing`);
  await partnerPage.getByRole('button', { name: 'Ver demonstrativo', exact: true }).click();
  await expect(partnerPage.locator('.billing-total')).toContainText('1.440,00');
  await expect(partnerPage.getByRole('button', { name: 'Registrar ajuste', exact: true })).toHaveCount(0);
  await expect(partnerPage.getByRole('button', { name: 'Simular liquidação', exact: true })).toHaveCount(0);
  await request(managerContext.request, partnerBase, 'POST', `${centralPrefix}/close`, { month: consumptionMonth }, 403);
  for (const width of [320, 375, 768, 1440]) {
    await partnerPage.setViewportSize({ width, height: 1000 });
    await partnerPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await partnerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Transbordamento em ${width}px`);
  }
  await partnerPage.setViewportSize({ width: 375, height: 900 }); await partnerPage.screenshot({ path: resolve('.data/phase12-billing-partner-mobile.png'), fullPage: true });

  // Lost responses must keep the same idempotency key for adjustment/settlement retries.
  await page.getByRole('button', { name: 'Faturas', exact: true }).click(); await page.getByRole('button', { name: 'Ver demonstrativo', exact: true }).click();
  await page.getByLabel('Valor do ajuste (R$)', { exact: true }).fill('-10,25'); await page.getByLabel('Motivo', { exact: true }).fill('Correção sintética após fechamento.');
  let adjustmentIntent: unknown;
  await page.route(`**/invoices/${originalInvoice.id}/adjustments`, async route => { adjustmentIntent = route.request().postDataJSON(); const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('failed'); }, { times: 1 });
  await page.getByRole('button', { name: 'Registrar ajuste', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Não foi possível conectar');
  const adjustmentRetry = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/adjustments'));
  await page.getByRole('button', { name: 'Registrar ajuste', exact: true }).click();
  const adjustmentResponse = await adjustmentRetry; assert.equal(adjustmentResponse.status(), 201); assert.deepEqual(adjustmentResponse.request().postDataJSON(), adjustmentIntent);
  await expect(page.getByText('Aguardando próxima competência', { exact: true })).toBeVisible();
  assert.equal((await db.query('SELECT count(*)::int AS total FROM billing_adjustments WHERE source_invoice_id=$1', [originalInvoice.id])).rows[0].total, 1);
  assert.equal((await db.query('SELECT amount_cents::int FROM billing_adjustments WHERE source_invoice_id=$1', [originalInvoice.id])).rows[0].amount_cents, -1025);
  let settlementIntent: unknown;
  await page.route(`**/invoices/${originalInvoice.id}/settle`, async route => { settlementIntent = route.request().postDataJSON(); const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); }, { times: 1 });
  await page.getByRole('button', { name: 'Simular liquidação', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Não foi possível conectar');
  const settlementRetry = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/settle'));
  await page.getByRole('button', { name: 'Simular liquidação', exact: true }).click(); const settled = await settlementRetry;
  assert.deepEqual(settled.request().postDataJSON(), settlementIntent); assert.equal((await settled.json()).replay, true);
  await expect(page.getByRole('button', { name: 'Liquidação já registrada', exact: true })).toBeDisabled();
  assert.equal((await db.query('SELECT count(*)::int AS total FROM billing_settlements WHERE invoice_id=$1', [originalInvoice.id])).rows[0].total, 1);
  assert.deepEqual((await request(operatorContext.request, centralBase, 'GET', `${centralPrefix}/invoices/${originalInvoice.id}`)).invoice.snapshot, originalInvoice.snapshot);
  await page.screenshot({ path: resolve('.data/phase12-billing-settled.png'), fullPage: true });
  assert.deepEqual(errors, []);
  process.stdout.write('F12 faturamento UI/API real: J17 novembro→dezembro R$1.440, 50 alunos únicos em múltiplas turmas/papéis; J18 contrato/curso/rubrica/relatório preservados após novas versões; leitura do parceiro, ajuste/liquidação com resposta perdida e replay, 320–1440px e zero pageerrors passaram.\n');
} finally {
  await browser?.close(); await app?.close(); await db.close();
  try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
  await rm(temporary, { recursive: true, force: true });
}
