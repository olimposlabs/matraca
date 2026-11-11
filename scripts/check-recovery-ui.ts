import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type APIRequestContext, type Browser, type BrowserContext } from '@playwright/test';
import { createApp } from '../server/app.js';
import { nextMonth } from '../server/billing-preview.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { MockEvaluationProvider, type EvaluationProvider } from '../server/evaluation/provider.js';
import { runEvaluationJob } from '../server/evaluation/worker.js';
import { defaultOperationPolicy } from '../server/operation-policy.js';
import { DEFAULT_BRANDING } from '../server/organizations.js';
import { getWallet, grantCredits } from '../server/wallet.js';

const workerMode = process.argv[2];
if (workerMode === '--worker-hold' || workerMode === '--worker-once') {
  const databaseUrl = process.env.MATRACA_RECOVERY_DATABASE;
  if (!databaseUrl) throw new Error('Worker de validação exige banco isolado.');
  const db = createDatabase(databaseUrl);
  try {
    const provider: EvaluationProvider = workerMode === '--worker-hold' ? {
      evaluate: async context => {
        process.send?.({ type: 'claimed', requestId: context.requestId });
        return new Promise(() => {}); // The parent kills this process after the real claim commits.
      },
    } : new MockEvaluationProvider();
    const processed = await runEvaluationJob(db, provider, { timeoutMs: workerMode === '--worker-hold' ? 120_000 : 8000 });
    process.send?.({ type: 'done', processed });
  } finally { await db.close(); process.disconnect?.(); }
} else {
  await checkRecovery();
}

interface Actor { orgId: string; userId: string; token: string; host: string; name: string }
async function checkRecovery() {
  // Run after build. Every identity, grant and media file is synthetic and isolated from the demo.
  const port = 3017, partnerBase = `http://127.0.0.1:${port}`, centralBase = `http://localhost:${port}`;
  const schema = `recovery_ui_${randomUUID().replaceAll('-', '')}`;
  const temporary = await mkdtemp(join(tmpdir(), 'matraca-recovery-ui-'));
  const databaseUrl = process.env.DATABASE_URL ?? localDatabaseUrl;
  const control = createDatabase(databaseUrl), isolated = new URL(databaseUrl);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(isolated.toString());
  const children = new Set<ChildProcess>();
  let app: Awaited<ReturnType<typeof createApp>> | undefined, browser: Browser | undefined;
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    const migrations = new URL('../server/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, migrations), 'utf8'));
    const orgId = randomUUID(), operatorOrgId = randomUUID();
    await db.query("INSERT INTO orgs(id,slug,name,kind,branding) VALUES($1,'recovery-school','Escola de recuperação','partner',$3),($2,'recovery-operator','Operação Matraca','backoffice',$3)", [orgId, operatorOrgId, { ...DEFAULT_BRANDING, _revision: 0 }]);
    await db.query("INSERT INTO domains(hostname,org_id) VALUES('127.0.0.1',$1),('localhost',$2)", [orgId, operatorOrgId]);
    async function actor(role: string, name: string, targetOrg = orgId, host = '127.0.0.1'): Promise<Actor> {
      const userId = randomUUID(), token = randomBytes(32).toString('base64url');
      await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,$3,$4,$5,'active')", [userId, targetOrg, `${userId}@example.test`, name, [role]]);
      await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [targetOrg, userId, host, createHash('sha256').update(token).digest('hex')]);
      return { orgId: targetOrg, userId, token, host, name };
    }
    const operator = await actor('operator', 'Operador sintético', operatorOrgId, 'localhost');
    const admin = await actor('org_admin', 'Administrador sintético');
    const school = await actor('school', 'Gestor escolar sintético');
    const raceStudent = await actor('student', 'Disputa de último crédito');
    const timeoutStudent = await actor('student', 'Falha por timeout');
    const transientStudent = await actor('student', 'Falha transitória');
    const permanentStudent = await actor('student', 'Falha definitiva');
    const restartStudent = await actor('student', 'Retomada de processo');
    const schoolStudent = await actor('student', 'Aluno da escola');
    for (const who of [raceStudent, timeoutStudent, transientStudent, permanentStudent, restartStudent]) await grantCredits(db, { ...who, amount: 1, source: 'manual', sourceRef: 'recovery-fixture', eventKey: randomUUID(), reason: 'Saldo sintético de uma prática.' });
    const schoolId = randomUUID();
    await db.query("INSERT INTO schools(id,org_id,name) VALUES($1,$2,'Unidade sintética')", [schoolId, orgId]);
    await db.query("INSERT INTO school_staff(org_id,school_id,user_id,role) VALUES($1,$2,$3,'school')", [orgId, schoolId, school.userId]);
    await db.query('INSERT INTO student_schools(org_id,school_id,student_id) VALUES($1,$2,$3)', [orgId, schoolId, schoolStudent.userId]);
    app = await createApp({ databaseUrl: isolated.toString(), storageRoot: join(temporary, 'objects') });
    await app.listen({ host: '127.0.0.1', port });
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const pageErrors: string[] = [];
    async function context(who: Actor): Promise<BrowserContext> {
      const value = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      await value.addCookies([{ name: 'matraca_session', value: who.token, url: `http://${who.host}:${port}`, httpOnly: true, sameSite: 'Lax' }]);
      value.on('page', page => page.on('pageerror', error => pageErrors.push(error.message))); return value;
    }
    const operatorContext = await context(operator), adminContext = await context(admin), schoolContext = await context(school);
    const raceContext = await context(raceStudent), timeoutContext = await context(timeoutStudent), transientContext = await context(transientStudent), permanentContext = await context(permanentStudent), restartContext = await context(restartStudent), schoolStudentContext = await context(schoolStudent);
    async function call(requester: APIRequestContext, method: string, path: string, payload?: unknown, expected = 200, central = false) {
      const response = await requester.fetch(`${central ? centralBase : partnerBase}${path}`, { method, headers: { 'x-matraca-request': '1' }, ...(payload === undefined ? {} : { data: payload }) });
      assert.equal(response.status(), expected, `${method} ${path}: status inesperado`); return response.json();
    }
    const wav = Buffer.alloc(8044); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
    async function upload(requester: APIRequestContext, objective: string) {
      const response = await requester.post(`${partnerBase}/api/recordings`, { headers: { 'x-matraca-request': '1' }, multipart: { metadata: JSON.stringify({ purpose: 'free', source: 'upload', objective }), file: { name: 'pratica-sintetica.wav', mimeType: 'audio/wav', buffer: wav } } });
      assert.equal(response.status(), 201); return (await response.json()).recording.id as string;
    }
    async function requestEvaluation(requester: APIRequestContext, objective: string, scenario: string) {
      const recordingId = await upload(requester, objective);
      const response = await call(requester, 'POST', '/api/evaluations', { recordingId, clientKey: randomUUID(), scenario }, 202);
      return response.evaluation.id as string;
    }
    async function counts(who: Actor) {
      return (await db.query(`SELECT (SELECT count(*)::int FROM evaluation_results WHERE org_id=$1 AND student_id=$2) AS results,
        (SELECT count(*)::int FROM wallet_entries WHERE org_id=$1 AND user_id=$2 AND kind='consumption') AS consumptions`, [who.orgId, who.userId])).rows[0];
    }
    const provider = new MockEvaluationProvider();
    // J14: two distinct HTTP requests, two real recordings and only one available credit.
    const firstRecording = await upload(raceContext.request, 'Primeira solicitação concorrente');
    const secondRecording = await upload(raceContext.request, 'Segunda solicitação concorrente');
    const raced = await Promise.all([firstRecording, secondRecording].map(recordingId => raceContext.request.post(`${partnerBase}/api/evaluations`, { headers: { 'x-matraca-request': '1' }, data: { recordingId, clientKey: randomUUID(), scenario: 'success' } })));
    assert.deepEqual(raced.map(response => response.status()).sort(), [202, 402]);
    const winnerId = (await raced.find(response => response.status() === 202)!.json()).evaluation.id as string;
    assert.deepEqual(await getWallet(db, raceStudent), { balance: 1, reserved: 1, available: 0 });
    assert.equal((await db.query('SELECT id FROM credit_reservations WHERE org_id=$1 AND user_id=$2', [orgId, raceStudent.userId])).rowCount, 1);
    assert.equal(await runEvaluationJob(db, provider), true);
    assert.deepEqual(await getWallet(db, raceStudent), { balance: 0, reserved: 0, available: 0 });
    assert.deepEqual(await counts(raceStudent), { results: 1, consumptions: 1 });
    const racePage = await raceContext.newPage(); await racePage.goto(`${partnerBase}/app/evaluations/${winnerId}`);
    await expect(racePage.getByRole('heading', { name: 'Relatório simulado', exact: true })).toBeVisible();
    await mkdir(resolve('.data'), { recursive: true });
    await racePage.screenshot({ path: resolve('.data/phase14-recovery-j14.png'), fullPage: true });

    const opsPage = await operatorContext.newPage(); await opsPage.goto(`${centralBase}/backoffice/operations`);
    await opsPage.getByLabel('Organização para acompanhar', { exact: true }).selectOption(orgId);
    await opsPage.getByRole('button', { name: 'Fila de avaliações', exact: true }).click();
    async function retryOnScreen(id: string) {
      await opsPage.getByRole('button', { name: 'Atualizar fila', exact: true }).click();
      const row = opsPage.locator('tbody tr').filter({ hasText: id });
      await row.getByRole('button', { name: 'Retomar na fila', exact: true }).click();
      await expect(opsPage.getByRole('status').filter({ hasText: 'reserva original foi mantida' })).toBeVisible();
    }
    // J15: real timeout path, with an 80 ms test deadline instead of the production 8 s deadline.
    const timeoutId = await requestEvaluation(timeoutContext.request, 'Prática com prazo excedido', 'timeout');
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(await runEvaluationJob(db, provider, { timeoutMs: 80 }), true);
      const state = (await call(timeoutContext.request, 'GET', `/api/evaluations/${timeoutId}`)).evaluation;
      assert.equal(state.attempts, attempt);
      if (attempt < 3) {
        assert.equal(state.status, 'queued'); assert.deepEqual(await getWallet(db, timeoutStudent), { balance: 1, reserved: 1, available: 0 });
        await retryOnScreen(timeoutId);
      } else { assert.equal(state.status, 'failed'); assert.equal(state.errorCode, 'timeout'); }
    }
    assert.deepEqual(await getWallet(db, timeoutStudent), { balance: 1, reserved: 0, available: 1 });
    assert.deepEqual(await counts(timeoutStudent), { results: 0, consumptions: 0 });
    const timeoutPage = await timeoutContext.newPage(); await timeoutPage.goto(`${partnerBase}/app/evaluations/${timeoutId}`);
    await expect(timeoutPage.getByText('O simulador excedeu o tempo de resposta. Os créditos reservados foram liberados.', { exact: true })).toBeVisible();
    await timeoutPage.screenshot({ path: resolve('.data/phase14-recovery-timeout.png'), fullPage: true });
    const permanentId = await requestEvaluation(permanentContext.request, 'Prática com falha definitiva', 'permanent');
    assert.equal(await runEvaluationJob(db, provider), true);
    assert.equal((await call(permanentContext.request, 'GET', `/api/evaluations/${permanentId}`)).evaluation.status, 'failed');
    assert.deepEqual(await getWallet(db, permanentStudent), { balance: 1, reserved: 0, available: 1 });
    const transientId = await requestEvaluation(transientContext.request, 'Prática com falha recuperável', 'transient');
    assert.equal(await runEvaluationJob(db, provider), true); await retryOnScreen(transientId);
    assert.equal(await runEvaluationJob(db, provider), true);
    assert.equal((await call(transientContext.request, 'GET', `/api/evaluations/${transientId}`)).evaluation.status, 'completed');
    assert.deepEqual(await counts(transientStudent), { results: 1, consumptions: 1 });

    function spawnWorker(mode: '--worker-hold' | '--worker-once') {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), mode], { cwd: process.cwd(), env: { ...process.env, MATRACA_RECOVERY_DATABASE: isolated.toString() }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.add(child); child.on('exit', () => children.delete(child)); return child;
    }
    async function runSeparateWorker() {
      const child = spawnWorker('--worker-once'); const exit = once(child, 'exit');
      const [message] = await once(child, 'message') as [{ type: string; processed: boolean }];
      assert.equal(message.type, 'done'); const [code] = await exit; assert.equal(code, 0); return message.processed;
    }
    // J13: school grant through its real UI, authorization revoked on server and no charge at grant time.
    await call(adminContext.request, 'PATCH', '/api/credits/policy', { schoolExtrasEnabled: false, defaultSchoolMonthlyLimit: 10 });
    await call(schoolContext.request, 'POST', `/api/credits/students/${schoolStudent.userId}/grant`, { eventId: randomUUID(), amount: 5, reason: 'Tentativa bloqueada' }, 403);
    const schoolPage = await schoolContext.newPage(); await schoolPage.goto(`${partnerBase}/admin/credits`);
    await schoolPage.getByRole('button', { name: `Ver carteira de ${schoolStudent.name}`, exact: true }).click();
    await expect(schoolPage.getByRole('button', { name: 'Conceder créditos', exact: true })).toHaveCount(0);
    await call(adminContext.request, 'PATCH', '/api/credits/policy', { schoolExtrasEnabled: true }); await schoolPage.reload();
    await schoolPage.getByRole('button', { name: `Ver carteira de ${schoolStudent.name}`, exact: true }).click();
    await schoolPage.getByRole('button', { name: 'Conceder créditos', exact: true }).click();
    const dialog = schoolPage.getByRole('dialog', { name: 'Conceder créditos', exact: true });
    await dialog.getByLabel('Quantidade de créditos', { exact: true }).fill('5');
    await dialog.getByLabel('Motivo da movimentação', { exact: true }).fill('Práticas extras da escola, fixture sintética.');
    await dialog.getByRole('button', { name: 'Conceder créditos', exact: true }).click();
    await expect(dialog).not.toBeVisible(); assert.deepEqual(await getWallet(db, schoolStudent), { balance: 5, reserved: 0, available: 5 });
    assert.equal((await db.query('SELECT id FROM billing_invoices WHERE org_id=$1', [orgId])).rowCount, 0);
    const schoolEvaluation = await requestEvaluation(schoolStudentContext.request, 'Uma prática da concessão escolar', 'success');
    assert.equal(await runEvaluationJob(db, provider), true); assert.equal((await call(schoolStudentContext.request, 'GET', `/api/evaluations/${schoolEvaluation}`)).evaluation.status, 'completed');
    assert.deepEqual(await getWallet(db, schoolStudent), { balance: 4, reserved: 0, available: 4 });
    await call(adminContext.request, 'PATCH', '/api/credits/policy', { schoolExtrasEnabled: false });
    await call(schoolContext.request, 'POST', `/api/credits/students/${schoolStudent.userId}/grant`, { eventId: randomUUID(), amount: 1, reason: 'Concessão após revogação' }, 403);
    await schoolPage.reload(); await expect(schoolPage.getByText(/As concessões extras pelas escolas estão desativadas/)).toBeVisible();
    await schoolPage.screenshot({ path: resolve('.data/phase14-recovery-school-disabled.png'), fullPage: true });

    // Kill an actual worker process only after its claim transaction has committed. Never restart PostgreSQL.
    const restartId = await requestEvaluation(restartContext.request, 'Prática que sobrevive ao worker', 'success');
    const dyingWorker = spawnWorker('--worker-hold');
    const [claimed] = await once(dyingWorker, 'message') as [{ type: string; requestId: string }];
    assert.deepEqual(claimed, { type: 'claimed', requestId: restartId });
    assert.deepEqual(await getWallet(db, restartStudent), { balance: 1, reserved: 1, available: 0 });
    const exited = once(dyingWorker, 'exit'); dyingWorker.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
    assert.equal(await runSeparateWorker(), false, 'Um worker novo não pode roubar lease ainda válido.');
    const restartPage = await restartContext.newPage(); await restartPage.goto(`${partnerBase}/app/evaluations/${restartId}`);
    await expect(restartPage.getByRole('button', { name: 'Cancelar avaliação', exact: true })).toBeVisible();
    await restartPage.screenshot({ path: resolve('.data/phase14-recovery-reserved-after-kill.png'), fullPage: true });

    // Wait for the real 30-second lease; no database clock or lease timestamp is rewritten.
    await expect.poll(async () => (await db.query('SELECT lease_until<=clock_timestamp() AS expired FROM evaluation_jobs WHERE request_id=$1', [restartId])).rows[0].expired, { timeout: 40_000, intervals: [250, 500, 1000] }).toBe(true);
    assert.equal(await runSeparateWorker(), true); assert.equal(await runSeparateWorker(), false);
    const recovered = (await call(restartContext.request, 'GET', `/api/evaluations/${restartId}`)).evaluation;
    assert.equal(recovered.status, 'completed'); assert.equal(recovered.attempts, 2);
    assert.deepEqual(await getWallet(db, restartStudent), { balance: 0, reserved: 0, available: 0 }); assert.deepEqual(await counts(restartStudent), { results: 1, consumptions: 1 });
    await expect(restartPage.getByRole('heading', { name: 'Relatório simulado', exact: true })).toBeVisible({ timeout: 10_000 });
    await restartPage.screenshot({ path: resolve('.data/phase14-recovery-worker-restored.png'), fullPage: true });
    const deliveredMedia = await restartContext.request.get(`${partnerBase}/api/recordings/${recovered.recordingId}/media`); assert.equal(deliveredMedia.status(), 200); assert.deepEqual(await deliveredMedia.body(), wav);

    const realNow = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(realNow);
    const month = `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
    const billing = `/api/backoffice/billing/orgs/${orgId}`;
    await call(operatorContext.request, 'POST', `${billing}/contracts`, { effectiveFrom: month, expectedRevision: 0, licenses: { organizationCents: 0, schoolCents: 0, studentCents: 0 }, credits: { mode: 'volume', tiers: [{ from: 1, to: null, unitPriceCents: 90 }] } }, 201, true);
    await call(operatorContext.request, 'PUT', `/api/backoffice/ops/${orgId}/policy`, { expectedRevision: 0, config: { ...defaultOperationPolicy, clockOverride: `${nextMonth(month)}-02T12:00:00Z` } }, 200, true);
    const invoice = (await call(operatorContext.request, 'POST', `${billing}/close`, { month }, 201, true)).invoice;
    assert.equal(invoice.snapshot.usage.netCredits, 4); assert.equal(invoice.totalCents, 360);
    const schoolAllocation = await db.query('SELECT a.credits,a.amount_cents::int FROM billing_usage_allocations a JOIN wallet_entries e ON e.id=a.consumption_entry_id AND e.org_id=a.org_id WHERE a.org_id=$1 AND e.user_id=$2', [orgId, schoolStudent.userId]);
    assert.deepEqual(schoolAllocation.rows, [{ credits: 1, amount_cents: 90 }]);
    assert.equal((await db.query("SELECT count(*)::int AS total FROM wallet_entries WHERE org_id=$1 AND user_id=$2 AND kind='grant'", [orgId, schoolStudent.userId])).rows[0].total, 1);
    await call(schoolContext.request, 'GET', '/api/billing/invoices', undefined, 403);
    const operatorBilling = await operatorContext.newPage(); await operatorBilling.goto(`${centralBase}/backoffice/billing`);
    await operatorBilling.getByRole('combobox', { name: 'Organização parceira', exact: true }).selectOption(orgId);
    await operatorBilling.getByRole('button', { name: 'Ver demonstrativo', exact: true }).click();
    await expect(operatorBilling.locator('.billing-total')).toContainText('3,60');
    await operatorBilling.screenshot({ path: resolve('.data/phase14-recovery-central-billing.png'), fullPage: true });
    assert.deepEqual(pageErrors, []);
    process.stdout.write('F14 J13–15 UI/API real: corrida202/402 pelo último crédito; timeout3tentativas/80ms e liberação; falha definitiva e transitória com retomada operacional; SIGKILL real após claim, lease30s protegido e worker novo concluindo uma única vez; concessão escolar autorizada/bloqueada e só1crédito/90centavos consumido na fatura central; mídia preservada; zero pageerrors.\n');
  } finally {
    for (const child of children) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    await browser?.close(); await app?.close(); await db.close();
    try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
    await rm(temporary, { recursive: true, force: true });
  }
}
