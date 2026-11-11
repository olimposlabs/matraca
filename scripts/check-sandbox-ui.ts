import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect, type Page } from '@playwright/test';

const port = 3020;
const name = `persist_${randomUUID().slice(0, 8)}`;
const label = name.replaceAll('_', '-');
const direct = `http://${label}.matraca.localhost:${port}`;
const partner = `http://parceiro.${label}.matraca.localhost:${port}`;
const office = `http://backoffice.${label}.matraca.localhost:${port}`;
const folder = resolve('.data', 'sandboxes', name);
const mailbox = resolve(folder, 'mailbox');
const command = ['--import', 'tsx', 'scripts/sandbox.ts'];
const run = promisify(execFile);
const reset = ['reset', '--name', name, '--confirm', name];
let service: ChildProcess | undefined;
let exited: Promise<unknown> | undefined;
let output = '';

async function start(examples: boolean) {
  output = '';
  service = spawn(process.execPath, [...command, 'start', '--name', name, '--port', String(port), ...(examples ? ['--examples'] : [])]);
  for (const pipe of [service.stdout, service.stderr]) pipe?.on('data', chunk => { output += String(chunk); });
  exited = new Promise((done, reject) => {
    service?.once('exit', done);
    service?.once('error', reject);
  });
  await expect.poll(async () => {
    if (service?.exitCode !== null) throw new Error(output);
    try {
      const response = await fetch(`${direct}/api/context`);
      return response.ok && (await response.json()).org?.slug === 'matraca';
    } catch { return false; }
  }, { timeout: 45_000 }).toBe(true);
}

async function stop() {
  if (!service) return;
  if (service.exitCode === null) service.kill('SIGTERM');
  await exited;
  service = undefined;
}

async function login(page: Page, base: string, email: string) {
  await page.goto(`${base}/login`);
  await page.getByRole('textbox', { name: /e-mail/i }).fill(email);
  await page.getByRole('button', { name: 'Receber link de acesso' }).click();
  await expect.poll(async () => {
    try { return (await readdir(mailbox)).length; } catch { return 0; }
  }).toBeGreaterThan(0);
  const hostname = new URL(base).hostname;
  let link = '';
  await expect.poll(async () => {
    for (const org of await readdir(mailbox)) {
      for (const name of await readdir(resolve(mailbox, org))) {
        const message = JSON.parse(await readFile(resolve(mailbox, org, name), 'utf8'));
        if (message.hostname === hostname && message.to === email) link = message.link;
      }
    }
    return Boolean(link);
  }).toBe(true);
  await page.goto(link);
  await expect(page).toHaveURL(/\/(app(?:\/journey)?|backoffice)$/);
}

async function data(page: Page, base: string, endpoint: string) {
  const response = await page.request.get(`${base}${endpoint}`);
  assert.equal(response.status(), 200, endpoint);
  return await response.json();
}

async function assess(page: Page, url: string, objective: string) {
  await page.goto(url);
  await page.locator('#recording-objective').fill(objective);
  await page.getByLabel('Selecionar gravação', { exact: true }).setInputFiles(
    fileURLToPath(new URL('../tests/fixtures/media/media-recorder.webm', import.meta.url)),
  );
  const upload = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/recordings'));
  await page.getByRole('button', { name: 'Salvar gravação', exact: true }).click();
  const saved = await upload;
  assert.equal(saved.status(), 201);
  await page.getByRole('button', { name: 'Solicitar avaliação', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Relatório simulado', exact: true })).toBeVisible();
  return (await saved.json()).recording.id as string;
}

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  await start(true);
  const ids = JSON.parse(output.match(/^\{"orderId".+\}$/m)?.[0] ?? '{}');
  for (const key of ['orderId', 'evaluationId', 'recordingId', 'mentoringId', 'invoiceId']) assert.ok(ids[key], key);
  await assert.rejects(run(process.execPath, [...command, 'reset', '--name', name, '--confirm', 'outro']), /confirme o nome exato/);
  await assert.rejects(run(process.execPath, [...command, ...reset]), /está em execução/);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const directPage = await context.newPage(), partnerPage = await context.newPage(), officePage = await context.newPage();
  await directPage.goto(direct);
  await directPage.keyboard.press('Tab');
  await expect(directPage.getByRole('link', { name: 'Ir para o conteúdo' })).toBeFocused();
  await directPage.keyboard.press('Enter');
  await expect(directPage.locator('main#conteudo')).toBeFocused();
  await login(directPage, direct, 'aluno2@matraca.test');
  await login(partnerPage, partner, 'aluno2@parceiro.test');
  await login(officePage, office, 'operador@matraca.test');
  const partnerId = (await data(partnerPage, partner, '/api/context')).org.id;

  async function snapshot() {
    await directPage.goto(`${direct}/app/store`);
    await expect(directPage.getByRole('heading', { name: 'Continue sua próxima conversa.' }).first()).toBeVisible();
    await directPage.getByRole('button', { name: 'Meus pedidos', exact: true }).click();
    await expect(directPage.getByText('Pacote de prática · 10 créditos', { exact: true })).toBeVisible();
    await partnerPage.goto(`${partner}/app/evaluations/${ids.evaluationId}`);
    await expect(partnerPage.getByRole('heading', { name: 'Relatório simulado' })).toBeVisible();
    await expect.poll(() => partnerPage.locator('.evaluation-player video').evaluate((video: HTMLVideoElement) => video.duration)).toBeGreaterThan(0);
    await partnerPage.locator('.evaluation-player video').evaluate((video: HTMLVideoElement) => { video.muted = true; return video.play(); });
    await expect.poll(() => partnerPage.locator('.evaluation-player video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
    const media = await partnerPage.request.get(`${partner}/api/recordings/${ids.recordingId}/media`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(media.status(), 206);
    const mediaHash = createHash('sha256').update(await media.body()).digest('hex');
    const portal = await data(partnerPage, partner, '/api/journey');
    const orders = await data(directPage, direct, `/api/commerce/orders/${ids.orderId}`);
    const invoice = await data(officePage, office, `/api/backoffice/billing/orgs/${partnerId}/invoices/${ids.invoiceId}`);
    assert.equal(orders.order.status, 'paid');
    assert.equal(invoice.invoice.id, ids.invoiceId);
    const directAccount = await data(directPage, direct, '/api/auth/session');
    const partnerAccount = await data(partnerPage, partner, '/api/auth/session');
    const wallet = await data(directPage, direct, '/api/wallet');
    assert.notEqual(directAccount.user.id, partnerAccount.user.id);
    await officePage.goto(`${office}/backoffice/billing`);
    await officePage.getByRole('combobox', { name: 'Organização parceira', exact: true }).selectOption(partnerId);
    await officePage.getByRole('button', { name: 'Faturas', exact: true }).click();
    const total = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(invoice.invoice.totalCents / 100);
    await expect(officePage.getByText(total, { exact: true })).toBeVisible();
    for (const page of [directPage, partnerPage, officePage]) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    return { directAccount, partnerAccount, wallet, portal, order: orders.order, invoice: invoice.invoice, mediaHash };
  }

  const administration = await browser.newContext();
  const administrator = await administration.newPage();
  await login(administrator, partner, 'admin@parceiro.test');
  const invitation = await administrator.request.post(`${partner}/api/education/people`, {
    headers: { 'x-matraca-request': '1' },
    data: { name: 'Docente pendente de teste', email: 'pendente@exemplo.test', roles: ['teacher'] },
  });
  assert.equal(invitation.status(), 201);
  const pendingTeacher = (await invitation.json()).person;
  assert.equal(pendingTeacher.teacherProfile.approvalStatus, 'pending');
  assert.deepEqual(pendingTeacher.schoolIds, []);
  const before = await snapshot();
  await stop();
  assert.equal(await fetch(`${direct}/api/health`).then(() => true, () => false), false);
  await start(false);
  const after = await snapshot();
  assert.deepEqual(after, before);
  const currentTeacher = (await data(administrator, partner, `/api/education/people/${pendingTeacher.id}`)).person;
  assert.equal(currentTeacher.teacherProfile.approvalStatus, 'pending');
  assert.deepEqual(currentTeacher.schoolIds, []);
  await administration.close();
  await mkdir(resolve('.data'), { recursive: true });
  await partnerPage.screenshot({ path: resolve('.data/phase14-sandbox-media.png'), fullPage: true });
  await officePage.screenshot({ path: resolve('.data/phase14-sandbox-invoice.png'), fullPage: true });
  await officePage.goto(`${office}/backoffice?org=${partnerId}`);
  await officePage.getByRole('tab', { name: 'Preferências' }).click();
  await officePage.getByRole('checkbox', { name: /Seguir todas as etapas/ }).check();
  await officePage.getByRole('button', { name: 'Salvar preferências', exact: true }).click();
  await expect(officePage.getByText('Preferências salvas para esta organização.', { exact: true })).toBeVisible();

  const sameEmail = await browser.newContext({ viewport: { width: 1280, height: 880 } });
  sameEmail.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const anaDirect = await sameEmail.newPage(), anaPartner = await sameEmail.newPage();
  await login(anaDirect, direct, 'ana@exemplo.test');
  await login(anaPartner, partner, 'ana@exemplo.test');
  const directIdentity = await data(anaDirect, direct, '/api/auth/session');
  const partnerIdentity = await data(anaPartner, partner, '/api/auth/session');
  assert.equal(directIdentity.user.email, partnerIdentity.user.email);
  assert.notEqual(directIdentity.user.id, partnerIdentity.user.id);
  await anaDirect.getByLabel('Profissão ou atividade', { exact: true }).fill('Analista de projetos');
  await anaDirect.getByLabel('Experiência em apresentações').selectOption('intermediate');
  await anaDirect.getByLabel('Objetivo 1', { exact: true }).fill('Concluir uma proposta com um pedido claro.');
  await anaDirect.getByRole('radio', { name: /Conhecer meu ponto de partida/ }).check();
  await anaDirect.getByRole('button', { name: 'Salvar meu perfil' }).click();
  await expect(anaDirect.getByRole('heading', { name: 'Analista de projetos' })).toBeVisible();
  const diagnosticRecording = await assess(anaDirect, `${direct}/app/recordings?purpose=diagnostic`, 'Diagnóstico da conta direta');
  await anaDirect.goto(`${direct}/app/journey`);
  await expect(anaDirect.getByRole('heading', { name: 'Prioridades do diagnóstico simulado.' })).toBeVisible();

  const partnerJourney = await data(anaPartner, partner, '/api/journey');
  assert.equal(partnerJourney.strictJourney, true);
  assert.equal(partnerJourney.diagnostic.evaluationId, null);
  const { courseId } = partnerJourney.courses[0];
  const course = await data(anaPartner, partner, `/api/courses/${courseId}`);
  const [first, second] = course.document.modules[0].units;
  await anaPartner.goto(`${partner}/app/courses/${courseId}?unit=${second.id}`);
  await expect(anaPartner.getByRole('heading', { name: 'Conclua as etapas anteriores para avançar.' })).toBeVisible();
  await anaPartner.goto(`${partner}/app/courses/${courseId}?unit=${first.id}`);
  const study = anaPartner.locator('.course-study-panel');
  await expect(study.getByRole('checkbox')).toHaveCount(first.checklist.length);
  for (const checkbox of await study.getByRole('checkbox').all()) await checkbox.check();
  await study.getByRole('button', { name: 'Concluir estudo e preparar a prática' }).click();
  const practice = study.getByRole('link', { name: 'Gravar ou enviar minha prática' });
  await expect(practice).toBeVisible();
  const partnerRecording = await assess(anaPartner, new URL((await practice.getAttribute('href'))!, partner).href, 'Aula na conta parceira');
  assert.equal((await data(anaPartner, partner, '/api/journey')).courses[0].completedUnits, 1);
  assert.equal((await data(anaDirect, direct, '/api/journey')).courses[0].completedUnits, 0);
  assert.equal((await data(anaDirect, direct, '/api/wallet')).wallet.balance, 0);
  assert.equal((await data(anaPartner, partner, '/api/wallet')).wallet.balance, first.studyCreditGrant);
  assert.equal((await anaDirect.request.get(`${direct}/api/recordings/${partnerRecording}/media`)).status(), 404);
  assert.equal((await anaPartner.request.get(`${partner}/api/recordings/${diagnosticRecording}/media`)).status(), 404);
  assert.equal((await anaPartner.request.get(`${partner}/api/commerce/orders/${ids.orderId}`)).status(), 404);
  assert.equal((await anaDirect.request.get(`${direct}/api/billing/invoices/${ids.invoiceId}`)).status(), 403);
  const groups = (await data(anaPartner, partner, '/api/gamification')).groups;
  assert.ok(groups.length);
  assert.equal((await anaDirect.request.get(`${direct}/api/gamification/leaderboard?groupId=${groups[0].id}`)).status(), 404);
  await anaDirect.goto(`${direct}/app/journey`);
  await anaDirect.getByRole('button', { name: 'Sair da conta' }).first().click();
  await expect(anaDirect).toHaveURL(/\/login$/);
  assert.equal((await anaDirect.request.get(`${direct}/api/auth/session`)).status(), 401);
  assert.equal((await data(anaPartner, partner, '/api/auth/session')).user.id, partnerIdentity.user.id);
  await sameEmail.close();

  const faculty = await browser.newContext();
  faculty.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const teacher = await faculty.newPage();
  await login(teacher, partner, 'professor1@parceiro.test');
  await teacher.goto(`${partner}/teacher/mentoring`);
  await teacher.getByRole('searchbox', { name: 'Buscar aluno por nome ou e-mail' }).fill('aluno2@parceiro.test');
  await teacher.getByRole('button', { name: 'Acompanhar Bruno Lima' }).click();
  await teacher.getByRole('button', { name: 'Mentorias', exact: true }).click();
  await teacher.getByRole('button', { name: 'Ver gravação de referência' }).click();
  let dialog = teacher.getByRole('dialog');
  await expect(dialog.getByText('Relatório original da IA · simulação')).toBeVisible();
  await dialog.getByRole('button', { name: 'Fechar janela' }).click();
  await teacher.getByRole('button', { name: 'Avaliações e gravações' }).click();
  await teacher.getByRole('button', { name: 'Revisar gravação' }).first().click();
  dialog = teacher.getByRole('dialog');
  await dialog.getByLabel('Apreciação geral').fill('Faça uma pausa depois da mensagem principal.');
  await dialog.getByLabel('Observação', { exact: true }).fill('Observe a transição depois da abertura.');
  await dialog.getByLabel('Início do trecho (segundos)').fill('0');
  await dialog.getByLabel('Fim do trecho (segundos)').fill('0.2');
  await dialog.getByRole('button', { name: 'Registrar revisão humana' }).click();
  await expect(dialog).toHaveCount(0);

  await partnerPage.goto(`${partner}/app/mentoring`);
  const task = partnerPage.locator('.mentoring-card').filter({ has: partnerPage.getByRole('heading', { name: 'Praticar uma abertura em uma frase' }) });
  await task.getByRole('button', { name: 'Atualizar progresso' }).click();
  dialog = partnerPage.getByRole('dialog');
  await dialog.getByLabel('Estado').selectOption('completed');
  await dialog.getByLabel('Como foi a prática?').fill('Fiz a pausa antes de apresentar o exemplo.');
  await dialog.getByRole('button', { name: 'Salvar atualização' }).click();
  await expect(dialog).toHaveCount(0);
  const objective = 'Nova tentativa depois da mentoria';
  await assess(partnerPage, `${partner}/app/recordings`, objective);
  await teacher.getByRole('button', { name: 'Plano individual' }).click();
  await teacher.getByRole('button', { name: 'Histórico e respostas' }).click();
  await expect(teacher.getByRole('dialog').getByText('Fiz a pausa antes de apresentar o exemplo.')).toBeVisible();
  await teacher.getByRole('dialog').getByRole('button', { name: 'Fechar janela' }).click();
  await teacher.getByRole('button', { name: 'Avaliações e gravações' }).click();
  const newAttempt = teacher.locator('.mentoring-card').filter({ has: teacher.getByRole('heading', { name: objective }) });
  await newAttempt.getByRole('button', { name: 'Revisar gravação' }).click();
  await expect(teacher.getByRole('dialog').getByText('Relatório original da IA · simulação')).toBeVisible();
  await faculty.close();

  assert.deepEqual(errors, []);
  await context.close();
  await stop();
  await run(process.execPath, [...command, ...reset]);
  await assert.rejects(readdir(folder), { code: 'ENOENT' });
  process.stdout.write('J05, J08, J10, J11 e J19: diagnóstico, mentoria com nova tentativa, isolamento, persistência e reset verificados.\n');
} catch (error) {
  process.stderr.write(output);
  throw error;
} finally {
  await browser.close();
  await stop();
  await run(process.execPath, [...command, ...reset]);
}
