import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';
import { createApp } from '../server/app.js';
import { mailboxRoot } from '../server/auth.js';
import { localDatabaseUrl } from '../server/config.js';
import { courseDocumentSchema, emptyCourse, validatePublication, type CourseDocument } from '../server/course-model.js';
import { createDatabase } from '../server/db.js';
import { DEFAULT_BRANDING } from '../server/organizations.js';

// npm run build && npm exec tsx -- scripts/check-registration-ui.ts
// Only catalog/operator fixtures use SQL. The student, session, order, payment,
// enrollment, wallet and progress are created by real UI requests in one context.
const schema = `registration_ui_${randomUUID().replaceAll('-', '')}`;
const temporary = await mkdtemp(join(tmpdir(), 'matraca-registration-ui-'));
const control = createDatabase(process.env.DATABASE_URL ?? localDatabaseUrl);
const url = new URL(process.env.DATABASE_URL ?? localDatabaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = createDatabase(url.toString());
const port = 3016, base = `http://127.0.0.1:${port}`;
const originalPublicPort = process.env.APP_PUBLIC_PORT;
const identity = { email: 'primeira-jornada@example.test', name: 'Lia da primeira jornada' };
let app: Awaited<ReturnType<typeof createApp>> | undefined, browser: Browser | undefined;
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../server/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  const orgId = randomUUID(), operatorId = randomUUID(), courseId = randomUUID(), versionId = randomUUID();
  await db.query("INSERT INTO orgs(id,slug,name,kind,branding) VALUES($1,'registration-demo','Matraca','matraca',$2)", [orgId, { ...DEFAULT_BRANDING, displayName: 'Matraca', _revision: 0 }]);
  await db.query("INSERT INTO domains(hostname,org_id) VALUES('127.0.0.1',$1)", [orgId]);
  await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,'catalogo@example.test','Catálogo sintético',ARRAY['operator'],'active')", [operatorId, orgId]);
  const courseDocument: CourseDocument = {
    ...emptyCourse('Sua primeira apresentação'), catalogVisible: true,
    creditMode: 'acquisition', acquisitionCredits: 7, completionCreditGrant: 0,
    description: 'Curso sintético para verificar cadastro, compra e início da jornada.',
    modules: [{ id: 'fundamentos', title: 'Começar com clareza', introductionMarkdown: '', units: [{
      id: 'primeira-fala', title: 'Uma ideia de cada vez', kind: 'lesson', chapter: '', mode: 'content',
      bodyMarkdown: '## A intenção da sua fala\n\nEscolha uma ideia central e formule uma frase que seu público consiga recordar.',
      instructionMarkdown: 'Escreva a ideia que deseja transmitir em sua próxima apresentação.',
      checklist: ['Escolhi uma ideia central.', 'Consigo resumir minha intenção em uma frase.'],
      references: [], assetIds: [], prerequisites: [], studyCreditGrant: 2, requiresEvaluation: false,
      activity: { maximumSeconds: 30, acceptedMedia: ['audio', 'video'], scenario: 'one_on_one', criteria: [{
        id: 'clareza', title: 'Clareza', enabled: true, weight: 1, modality: 'both',
        descriptors: ['A ideia ainda precisa de foco.', 'Há uma ideia inicial.', 'A ideia está clara.', 'A ideia é clara e concisa.'],
      }] },
    }] }],
  };
  courseDocumentSchema.parse(courseDocument); assert.deepEqual(validatePublication(courseDocument), []);
  await db.query("INSERT INTO courses(id,org_id,title,status,draft) VALUES($1,$2,$3,'published',$4)", [courseId, orgId, courseDocument.title, courseDocument]);
  await db.query('INSERT INTO course_versions(id,org_id,course_id,version,document) VALUES($1,$2,$3,1,$4)', [versionId, orgId, courseId, courseDocument]);
  await db.query("INSERT INTO commerce_offers(org_id,title,kind,status,data,course_id,course_version_id,created_by) VALUES($1,'Comece sua jornada','course','published',$2,$3,$4,$5)", [orgId, { creditAmount: 7, coursePriceCents: 12990 }, courseId, versionId, operatorId]);
  assert.equal((await db.query("SELECT count(*)::int AS total FROM users WHERE 'student'=ANY(roles)")).rows[0].total, 0);
  process.env.APP_PUBLIC_PORT = String(port);
  app = await createApp({ databaseUrl: url.toString(), storageRoot: join(temporary, 'objects') });
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'Acessar minha área', exact: true }).click();
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
  await page.getByLabel('Como podemos chamar você?', { exact: true }).fill(identity.name);
  await page.getByLabel('Seu e-mail', { exact: true }).fill(identity.email);
  const registered = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Criar conta e receber link', exact: true }).click();
  assert.equal((await registered).status(), 202);
  await expect(page.getByText('SOLICITAÇÃO RECEBIDA', { exact: true })).toBeVisible();
  assert.equal((await db.query('SELECT count(*)::int AS total FROM sessions')).rows[0].total, 0);
  const mailbox = join(mailboxRoot(join(temporary, 'objects')), orgId);
  async function consumeLatestMessage() {
    const messages = await Promise.all((await readdir(mailbox)).filter(file => file.endsWith('.json')).map(async file => JSON.parse(await readFile(join(mailbox, file), 'utf8')) as { orgId: string; to: string; hostname: string; createdAt: string; link: string }));
    const mail = messages.filter(item => item.orgId === orgId && item.to === identity.email && item.hostname === '127.0.0.1').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    assert.ok(mail, 'Mensagem local para o cadastro deve existir.');
    assert.equal(new URL(mail.link).origin, base);
    // Never log the one-use link or session cookie.
    await page.goto(mail.link, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(`${base}/app/journey`);
  }
  await consumeLatestMessage();
  const session = await (await page.request.get(`${base}/api/auth/session`)).json();
  assert.equal(session.user.email, identity.email); assert.deepEqual(session.user.roles, ['student']); assert.equal(session.org.id, orgId);
  const studentId = session.user.id as string;
  async function balance() { return (await (await page.request.get(`${base}/api/wallet`)).json()).wallet; }
  assert.deepEqual(await balance(), { balance: 1, reserved: 0, available: 1 });
  await page.getByLabel('Profissão ou atividade', { exact: true }).fill('Analista de projetos');
  await page.getByLabel('Experiência em apresentações', { exact: true }).selectOption('beginner');
  await page.getByLabel('Objetivo 1', { exact: true }).fill('Apresentar uma ideia com clareza nas reuniões.');
  await page.getByRole('radio', { name: /Começar pela base/ }).check();
  await page.getByRole('button', { name: 'Salvar meu perfil', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Analista de projetos', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Loja', exact: true }).click();
  await page.locator('.shop-offer').filter({ has: page.getByRole('heading', { name: 'Comece sua jornada', exact: true }) }).getByRole('button', { name: 'Revisar pedido', exact: true }).click();
  const created = page.waitForResponse(response => response.url().endsWith('/api/commerce/orders') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Continuar para pagamento', exact: true }).click();
  const orderResponse = await created; assert.equal(orderResponse.status(), 201);
  const order = (await orderResponse.json()).order;
  assert.equal(order.amountCents, 12990); assert.equal(order.creditAmount, 7); assert.equal(order.courseVersionId, versionId);
  await expect(page.locator('.shop-order-detail')).toContainText('129,90');
  await expect(page.getByLabel('Resultado do pagamento simulado', { exact: true })).toHaveValue('default');
  await page.getByRole('button', { name: 'Simular pagamento', exact: true }).click();
  await expect(page.locator('.shop-notice')).toContainText('confirmado');
  assert.deepEqual(await balance(), { balance: 8, reserved: 0, available: 8 });
  await mkdir(resolve('.data'), { recursive: true });
  await page.screenshot({ path: resolve('.data/phase14-registration-checkout.png'), fullPage: true });
  await page.getByRole('link', { name: 'Ver minha jornada', exact: true }).click();
  await expect(page.getByRole('heading', { name: courseDocument.title, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Continuar a jornada', exact: true }).click();
  await page.getByRole('button', { name: 'Uma ideia de cada vez', exact: true }).click();
  await expect(page.locator('.course-practice-brief')).toContainText('Estudar esta unidade não gera uma nova concessão.');
  await expect(page.locator('.course-study-credit-note')).toContainText('sem uma nova concessão');
  await expect(page.locator('.course-study-panel input[type="checkbox"]')).toHaveCount(2);
  for (const checkbox of await page.locator('.course-study-panel input[type="checkbox"]').all()) await checkbox.check();
  await page.getByRole('button', { name: 'Concluir esta unidade', exact: true }).click();
  await expect(page.getByText('Você concluiu este curso.', { exact: true })).toBeVisible();
  assert.deepEqual(await balance(), { balance: 8, reserved: 0, available: 8 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Você concluiu este curso.', { exact: true })).toBeVisible();
  await expect(page.locator('.course-study-panel input[type="checkbox"]').first()).toBeChecked();
  await page.screenshot({ path: resolve('.data/phase14-registration-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText('Você concluiu este curso.', { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve('.data/phase14-registration-mobile.png'), fullPage: true });

  // The first purchase already occurred in the signup session. A fresh real login
  // additionally checks persistence and that welcome/acquisition grants do not repeat.
  await page.getByRole('link', { name: 'Minha jornada', exact: true }).click();
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Seu e-mail', { exact: true }).fill(identity.email);
  await page.getByRole('button', { name: 'Receber link de acesso', exact: true }).click();
  await expect(page.getByText('SOLICITAÇÃO RECEBIDA', { exact: true })).toBeVisible();
  await consumeLatestMessage();
  await expect(page.getByRole('heading', { name: 'Analista de projetos', exact: true })).toBeVisible();
  await expect(page.locator('.journey-course-grid')).toContainText('1 de 1 unidades concluídas');
  assert.deepEqual(await balance(), { balance: 8, reserved: 0, available: 8 });
  await page.getByRole('link', { name: 'Loja', exact: true }).click();
  await page.getByRole('button', { name: 'Meus pedidos', exact: true }).click();
  await expect(page.locator('.shop-order-row')).toHaveCount(1);
  await expect(page.locator('.shop-order-row')).toContainText('Comece sua jornada');
  await expect(page.locator('.shop-order-row')).toContainText('Confirmado');
  const enrollment = (await db.query('SELECT version_id,status FROM course_enrollments WHERE org_id=$1 AND student_id=$2', [orgId, studentId])).rows;
  assert.equal(enrollment.length, 1); assert.equal(enrollment[0].version_id, versionId);
  assert.equal((await db.query("SELECT count(*)::int AS total FROM wallet_entries WHERE org_id=$1 AND user_id=$2 AND source='purchase'", [orgId, studentId])).rows[0].total, 1);
  assert.equal((await db.query("SELECT count(*)::int AS total FROM users WHERE 'student'=ANY(roles)")).rows[0].total, 1);
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve('.data/phase14-registration-results.json'), JSON.stringify({
    ok: true, journey: 'J01', recordedAt: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirtyPaths: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean),
    browser: 'Chromium', port, schema, sameContextSignupAndPurchase: true,
    studentCreatedThroughUi: true, magicLinksConsumed: 2, paidOrders: 1,
    courseVersion: 1, completedUnits: 1, initialCredits: 1, acquisitionCredits: 7,
    finalWallet: await balance(), pageErrors,
    screenshots: ['phase14-registration-checkout.png', 'phase14-registration-desktop.png', 'phase14-registration-mobile.png'],
  }, null, 2));
  process.stdout.write('F14 J01: visitante, cadastro, magic link real, compra na mesma sessão, perfil, matrícula v1, estudo sem concessão duplicada, recarga e novo login persistentes, saldo 8, mobile e zero pageerrors passaram.\n');
} catch (error) {
  const safeError = (error instanceof Error ? error.message : String(error)).replace(/token=[^\s"'&)<]+/gi, 'token=[REDACTED]');
  await mkdir(resolve('.data'), { recursive: true });
  await writeFile(resolve('.data/phase14-registration-results.json'), JSON.stringify({ ok: false, journey: 'J01', recordedAt: new Date().toISOString(), error: safeError }, null, 2));
  process.stderr.write(`F14 J01 falhou: ${safeError}\n`); process.exitCode = 1;
} finally {
  if (originalPublicPort === undefined) delete process.env.APP_PUBLIC_PORT; else process.env.APP_PUBLIC_PORT = originalPublicPort;
  await browser?.close(); await app?.close(); await db.close();
  try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
  await rm(temporary, { recursive: true, force: true });
}
