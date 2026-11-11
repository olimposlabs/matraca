import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type Browser, type BrowserContext } from '@playwright/test';
import { createApp } from '../server/app.js';
import { registerCommerce } from '../server/commerce.js';
import { localDatabaseUrl } from '../server/config.js';
import { emptyCourse } from '../server/course-model.js';
import { createDatabase } from '../server/db.js';
import { DEFAULT_BRANDING } from '../server/organizations.js';

// Run after npm run build. Isolated schema and storage; all identities and purchases are synthetic.
const schema = `commerce_ui_${randomUUID().replaceAll('-', '')}`;
const root = await mkdtemp(join(tmpdir(), 'matraca-commerce-ui-'));
const control = createDatabase(process.env.DATABASE_URL ?? localDatabaseUrl);
const url = new URL(process.env.DATABASE_URL ?? localDatabaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
const db = createDatabase(url.toString());
const studentBase = 'http://127.0.0.1:3012', centralBase = 'http://localhost:3012';
let app: Awaited<ReturnType<typeof createApp>> | undefined, browser: Browser | undefined;
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../server/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, migrations), 'utf8'));
  const orgId = randomUUID(), operatorOrgId = randomUUID(), courseId = randomUUID(), versionId = randomUUID();
  await db.query("INSERT INTO orgs(id,slug,name,kind,branding) VALUES($1,'store-demo','Matraca de demonstração','matraca',$3),($2,'operator-demo','Operação Matraca','backoffice',$3)", [orgId, operatorOrgId, { ...DEFAULT_BRANDING, _revision: 0 }]);
  await db.query("INSERT INTO domains(hostname,org_id) VALUES('127.0.0.1',$1),('localhost',$2)", [orgId, operatorOrgId]);
  async function actor(role: 'student' | 'operator', org: string, host: string) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,$3,$4,$5,'active')", [id, org, `${id}@example.test`, role === 'student' ? 'Lia de teste' : 'Operação de teste', [role]]);
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [org, id, host, createHash('sha256').update(token).digest('hex')]);
    return { id, token, host };
  }
  const student = await actor('student', orgId, '127.0.0.1'), operator = await actor('operator', operatorOrgId, 'localhost');
  const courseDocument = { ...emptyCourse('Sua primeira apresentação'), creditMode: 'acquisition' as const, acquisitionCredits: 7 };
  await db.query("INSERT INTO courses(id,org_id,title,status,draft) VALUES($1,$2,$3,'published',$4)", [courseId, orgId, courseDocument.title, courseDocument]);
  await db.query('INSERT INTO course_versions(id,org_id,course_id,version,document) VALUES($1,$2,$3,1,$4)', [versionId, orgId, courseId, courseDocument]);
  app = await createApp({ databaseUrl: url.toString(), storageRoot: join(root, 'objects') });
  if (!app.hasRoute({ method: 'GET', url: '/api/commerce/catalog' })) await registerCommerce(app);
  await app.listen({ host: '127.0.0.1', port: 3012 });
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const errors: string[] = [];
  async function context(who: { token: string; host: string }): Promise<BrowserContext> {
    const context = await browser!.newContext({ viewport: { width: 1366, height: 960 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'matraca_session', value: who.token, url: `http://${who.host}:3012`, httpOnly: true, sameSite: 'Lax' }]);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message))); return context;
  }
  const operatorContext = await context(operator), admin = await operatorContext.newPage();
  await admin.goto(`${centralBase}/backoffice/commerce`);
  await admin.getByLabel('Organização', { exact: true }).selectOption(orgId);
  await admin.getByRole('button', { name: 'Nova oferta', exact: true }).click();
  let editor = admin.getByRole('dialog', { name: 'Nova oferta', exact: true });
  await editor.getByLabel('Nome da oferta', { exact: true }).fill('Dez conversas');
  await editor.getByRole('button', { name: 'Adicionar faixa' }).click();
  await editor.getByLabel('Fim da faixa 1', { exact: true }).fill('9');
  await editor.getByLabel('Início da faixa 2', { exact: true }).fill('10');
  await editor.getByLabel('Preço da faixa 2', { exact: true }).fill('0,90');
  await editor.getByRole('button', { name: 'Calcular prévia' }).click();
  await expect(editor.locator('.shop-preview > strong')).toHaveText(/9,00/);
  await editor.getByLabel('Cálculo do preço', { exact: true }).selectOption('progressive');
  await editor.getByRole('button', { name: 'Calcular prévia' }).click();
  await expect(editor.locator('.shop-preview > strong')).toHaveText(/9,90/);
  await editor.getByLabel('Cálculo do preço', { exact: true }).selectOption('volume');
  await editor.getByRole('button', { name: 'Salvar rascunho' }).click();
  await expect(admin.locator('.shop-offer')).toHaveCount(1);
  await admin.locator('.shop-offer').getByRole('button', { name: 'Publicar', exact: true }).click();
  await admin.getByRole('button', { name: 'Confirmar publicação', exact: true }).click();
  await expect(admin.locator('.shop-offer .shop-status')).toHaveText('Publicado');

  await admin.getByRole('button', { name: 'Nova oferta', exact: true }).click();
  editor = admin.getByRole('dialog', { name: 'Nova oferta', exact: true });
  await editor.getByLabel('Nome da oferta', { exact: true }).fill('Curso para sua voz');
  await editor.getByLabel('Tipo de oferta', { exact: true }).selectOption('course');
  await editor.getByLabel('Curso e versão', { exact: true }).selectOption(versionId);
  await editor.getByLabel('Preço do curso (R$)', { exact: true }).fill('129,90');
  await expect(editor.locator('.shop-course-benefit')).toContainText('7 créditos');
  await editor.getByRole('button', { name: 'Calcular prévia' }).click();
  await expect(editor.locator('.shop-preview > strong')).toHaveText(/129,90/);
  await editor.getByRole('button', { name: 'Salvar rascunho' }).click();
  const courseCard = admin.locator('.shop-offer').filter({ has: admin.getByRole('heading', { name: 'Curso para sua voz', exact: true }) });
  await courseCard.getByRole('button', { name: 'Publicar', exact: true }).click();
  await admin.getByRole('button', { name: 'Confirmar publicação', exact: true }).click();
  await expect(courseCard.locator('.shop-status')).toHaveText('Publicado');
  await mkdir(resolve('.data'), { recursive: true });
  await admin.evaluate(() => window.scrollTo(0, 0)); await admin.screenshot({ path: resolve('.data/phase12-commerce-admin.png'), fullPage: true });

  const studentContext = await context(student), page = await studentContext.newPage();
  await page.goto(`${studentBase}/app/store`);
  await expect(page.locator('.shop-offer')).toHaveCount(2);
  await page.screenshot({ path: resolve('.data/phase12-commerce-catalog.png'), fullPage: true });
  async function buy(title: string) {
    await page.getByRole('button', { name: 'Cursos e pacotes', exact: true }).click();
    await page.locator('.shop-offer').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button', { name: 'Revisar pedido' }).click();
    const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/commerce/orders'));
    await page.getByRole('button', { name: 'Continuar para pagamento', exact: true }).click();
    const response = await created; assert.equal(response.status(), 201); const order = (await response.json()).order;
    await expect(page.getByRole('region', { name: `Pedido ${title}`, exact: true })).toBeVisible(); return order.id as string;
  }
  const purchaseId = await buy('Dez conversas');
  await page.getByLabel('Resultado do pagamento simulado', { exact: true }).selectOption('pending');
  await page.getByRole('button', { name: 'Simular pagamento', exact: true }).click();
  await expect(page.locator('.shop-notice')).toContainText('continua pendente');
  assert.equal((await db.query("SELECT count(*)::int AS total FROM wallet_entries WHERE org_id=$1 AND source='purchase'", [orgId])).rows[0].total, 0);
  await page.getByLabel('Resultado do pagamento simulado', { exact: true }).selectOption('approved');
  const paymentPath = `**/api/commerce/orders/${purchaseId}/simulate`;
  let firstIntent: unknown;
  await page.route(paymentPath, async route => { firstIntent = route.request().postDataJSON(); const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); }, { times: 1 });
  await page.getByRole('button', { name: 'Simular pagamento', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível conectar');
  const retried = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/orders/${purchaseId}/simulate`));
  await page.getByRole('button', { name: 'Simular pagamento', exact: true }).click();
  const retryResponse = await retried; assert.deepEqual(retryResponse.request().postDataJSON(), firstIntent); assert.equal((await retryResponse.json()).replay, true);
  await expect(page.locator('.shop-notice')).toContainText('confirmado');
  assert.equal((await db.query("SELECT count(*)::int AS total FROM wallet_entries WHERE org_id=$1 AND source='purchase'", [orgId])).rows[0].total, 1);
  assert.equal((await db.query('SELECT balance FROM wallets WHERE org_id=$1 AND user_id=$2', [orgId, student.id])).rows[0].balance, 10);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve('.data/phase12-commerce-checkout.png'), fullPage: true });

  const courseOrderId = await buy('Curso para sua voz');
  await expect(page.getByLabel('Resultado do pagamento simulado', { exact: true })).toHaveValue('default');
  const defaultPayment = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/orders/${courseOrderId}/simulate`));
  await page.getByRole('button', { name: 'Simular pagamento', exact: true }).click();
  assert.equal(Object.hasOwn((await defaultPayment).request().postDataJSON(), 'status'), false);
  await expect(page.locator('.shop-entitlements')).toContainText('matrícula nesta versão');
  assert.equal((await db.query('SELECT balance FROM wallets WHERE org_id=$1 AND user_id=$2', [orgId, student.id])).rows[0].balance, 17);
  assert.equal((await db.query("SELECT version_id FROM course_enrollments WHERE org_id=$1 AND student_id=$2 AND source='purchase'", [orgId, student.id])).rows[0].version_id, versionId);
  for (const status of ['declined', 'cancelled']) {
    await buy('Dez conversas');
    await page.getByLabel('Resultado do pagamento simulado', { exact: true }).selectOption(status);
    await page.getByRole('button', { name: 'Simular pagamento', exact: true }).click();
    await expect(page.locator('.shop-notice')).toContainText(status === 'declined' ? 'recusado' : 'cancelado');
  }
  assert.equal((await db.query('SELECT balance FROM wallets WHERE org_id=$1 AND user_id=$2', [orgId, student.id])).rows[0].balance, 17);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => window.scrollTo(0, 0));
  const mobile = await page.screenshot({ path: resolve('.data/phase12-commerce-mobile.png'), fullPage: true });
  assert.equal(mobile.readUInt32BE(16), 390); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await admin.getByRole('button', { name: 'Pedidos', exact: true }).click();
  await expect(admin.locator('.shop-order-row')).toHaveCount(4);
  await expect(admin.locator('.shop-order-row').first()).toContainText('Lia de teste');
  await admin.getByRole('button', { name: 'Catálogo', exact: true }).click();
  const packCard = admin.locator('.shop-offer').filter({ has: admin.getByRole('heading', { name: 'Dez conversas', exact: true }) });
  await packCard.getByRole('button', { name: 'Editar', exact: true }).click();
  const reprice = admin.getByRole('dialog');
  await reprice.getByLabel('Preço da faixa 2', { exact: true }).fill('1,20');
  await reprice.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
  await expect(packCard.locator('.shop-price')).toContainText('12,00');
  await packCard.getByRole('button', { name: 'Publicar', exact: true }).click();
  await admin.getByRole('button', { name: 'Confirmar publicação', exact: true }).click();
  await expect(packCard.locator('.shop-status')).toHaveText('Publicado');
  await page.getByRole('button', { name: 'Cursos e pacotes', exact: true }).click();
  await expect(page.locator('.shop-offer').filter({ hasText: 'Dez conversas' }).locator('.shop-price')).toContainText('12,00');
  await page.getByRole('button', { name: 'Meus pedidos', exact: true }).click();
  const previousPurchase = page.locator('.shop-order-row').filter({ hasText: 'Dez conversas' }).filter({ has: page.locator('.shop-status.paid') });
  await expect(previousPurchase).toContainText('9,00');
  await previousPurchase.click();
  await expect(page.getByRole('region', { name: 'Pedido Dez conversas', exact: true })).toContainText('9,00');
  await packCard.getByRole('button', { name: 'Arquivar', exact: true }).click();
  await admin.getByRole('button', { name: 'Confirmar arquivo', exact: true }).click();
  await expect(packCard.locator('.shop-status')).toHaveText('Arquivado');
  await page.getByRole('button', { name: 'Cursos e pacotes', exact: true }).click();
  await expect(page.locator('.shop-offer')).toHaveCount(1);
  await page.goto(`${studentBase}/backoffice/commerce`);
  await expect(page.getByRole('heading', { name: 'Esta área tem outro perfil de acesso.' })).toBeVisible();
  assert.deepEqual(errors, []);
  process.stdout.write('F12 comércio UI: catálogo/tiers, prévia, publicação/arquivo, curso com créditos derivados, pagamento pendente/aprovado/recusado/cancelado, resposta perdida e replay, carteira/matrícula, preço histórico após republicação, pedidos centrais e mobile passaram.\n');
} finally {
  await browser?.close(); await app?.close(); await db.close();
  try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
  await rm(root, { recursive: true, force: true });
}
