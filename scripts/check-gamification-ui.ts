import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type Browser, type BrowserContext } from '@playwright/test';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { emptyCourse } from '../server/course-model.js';
import { createDatabase } from '../server/db.js';
import { DEFAULT_BRANDING } from '../server/organizations.js';
import { awardLearningEvent } from '../server/gamification-core.js';

// Run after npm run build. Uses synthetic records, an isolated schema and private temp storage.
const schema = `gamification_ui_${randomUUID().replaceAll('-', '')}`;
const directory = await mkdtemp(join(tmpdir(), 'matraca-gamification-ui-'));
const control = createDatabase(process.env.DATABASE_URL ?? localDatabaseUrl);
const url = new URL(process.env.DATABASE_URL ?? localDatabaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = createDatabase(url.toString());
const base = 'http://127.0.0.1:3011';
let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const errors: string[] = [];
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../server/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(name, migrations), 'utf8'));
  const orgId = randomUUID(), operatorOrgId = randomUUID(), typeId = randomUUID(), groupId = randomUUID();
  await db.query("INSERT INTO orgs(id,slug,name,kind,branding) VALUES($1,'conquistas-demo','Comunidade da voz','partner',$3),($2,'operacao-demo','Operação Matraca','backoffice',$3)", [orgId, operatorOrgId, { ...DEFAULT_BRANDING, displayName: 'Matraca', _revision: 0, creditSingular: 'voz', creditPlural: 'vozes' }]);
  await db.query("INSERT INTO domains(hostname,org_id) VALUES('127.0.0.1',$1),('localhost',$2)", [orgId, operatorOrgId]);
  await db.query("INSERT INTO group_types(id,org_id,name) VALUES($1,$2,'Comunidade')", [typeId, orgId]);
  await db.query("INSERT INTO education_groups(id,org_id,type_id,name) VALUES($1,$2,$3,'Clube da expressão')", [groupId, orgId, typeId]);

  async function actor(name: string, role: string, org = orgId, host = '127.0.0.1') {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,$3,$4,$5,'active')", [id, org, `${id}@example.test`, name, [role]]);
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [org, id, host, createHash('sha256').update(token).digest('hex')]);
    return { id, token, host };
  }
  const student = await actor('Lia de teste', 'student');
  const second = await actor('Bruno de teste', 'student');
  const third = await actor('Cris de teste', 'student');
  const admin = await actor('Admin de teste', 'org_admin');
  const school = await actor('Gestor de teste', 'school');
  const operator = await actor('Operador de teste', 'operator', operatorOrgId, 'localhost');
  await db.query('INSERT INTO group_memberships(org_id,group_id,user_id) VALUES($1,$2,$3),($1,$2,$4)', [orgId, groupId, student.id, second.id]);
  const eventAt = new Date(Date.now() - 86400000).toISOString();
  async function learning(studentId: string, kind: 'lesson' | 'review' | 'course', groups: string[]) {
    const courseId = randomUUID(), versionId = randomUUID(), enrollmentId = randomUUID(), id = randomUUID();
    await db.transaction(async client => {
      const document = emptyCourse('Prática de demonstração');
      await client.query("INSERT INTO courses(id,org_id,title,status,draft) VALUES($1,$2,'Prática de demonstração','published',$3)", [courseId, orgId, document]);
      await client.query('INSERT INTO course_versions(id,org_id,course_id,version,document) VALUES($1,$2,$3,1,$4)', [versionId, orgId, courseId, document]);
      await client.query("INSERT INTO course_enrollments(id,org_id,course_id,version_id,student_id,source,source_ref) VALUES($1,$2,$3,$4,$5,'demo','ui')", [enrollmentId, orgId, courseId, versionId, studentId]);
      await client.query('INSERT INTO learning_events(id,enrollment_id,org_id,student_id,kind,subject_id,group_ids,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, enrollmentId, orgId, studentId, kind, 'ui', groups, eventAt]);
      await awardLearningEvent(client, { id, orgId, studentId, kind });
    });
  }
  await learning(student.id, 'course', [groupId]); await learning(second.id, 'review', [groupId]); await learning(third.id, 'lesson', []);
  app = await createApp({ databaseUrl: url.toString(), storageRoot: join(directory, 'objects') });
  await app.listen({ host: '127.0.0.1', port: 3011 });
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  async function context(who: { token: string; host: string }): Promise<BrowserContext> {
    const context = await browser!.newContext({ viewport: { width: 1366, height: 960 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'matraca_session', value: who.token, url: `http://${who.host}:3011`, httpOnly: true, sameSite: 'Lax' }]);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return context;
  }
  const adminContext = await context(admin);
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`${base}/admin/gamification`);
  await expect(adminPage.getByRole('heading', { name: 'Campanhas de premiação' })).toBeVisible();
  await adminPage.getByRole('button', { name: 'Pontos e medalhas', exact: true }).click();
  await adminPage.getByLabel('Aula concluída', { exact: true }).fill('40');
  await adminPage.getByRole('button', { name: 'Adicionar medalha' }).click();
  await adminPage.getByLabel('Nome da medalha 5', { exact: true }).fill('Cinco práticas');
  await adminPage.getByLabel('Quantidade da medalha 5', { exact: true }).fill('5');
  await adminPage.getByRole('button', { name: 'Publicar regras' }).click();
  await expect(adminPage.getByRole('status')).toContainText('Regras publicadas');
  const rules = await adminContext.request.get(`${base}/api/gamification/manage/policy`);
  assert.equal(rules.status(), 200);
  const savedRules = await rules.json(); assert.equal(savedRules.policy.points.lesson, 40); assert.equal(savedRules.policy.badges.length, 5);
  const concurrent = await adminContext.request.put(`${base}/api/gamification/manage/policy`, { headers: { 'x-matraca-request': '1' }, data: { expectedRevision: savedRules.revision, policy: { ...savedRules.policy, points: { ...savedRules.policy.points, lesson: 45 } } } });
  assert.equal(concurrent.status(), 200);
  await adminPage.getByLabel('Aula concluída', { exact: true }).fill('60');
  await adminPage.getByRole('button', { name: 'Publicar regras' }).click();
  await expect(adminPage.getByRole('alert')).toContainText('As regras mudaram');
  await adminPage.getByRole('button', { name: 'Recarregar regras' }).click();
  await expect(adminPage.getByLabel('Aula concluída', { exact: true })).toHaveValue('45');
  await adminPage.getByRole('button', { name: 'Campanhas', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Criar campanha', exact: true }).click();
  const dialog = adminPage.getByRole('dialog', { name: 'Nova campanha' });
  await dialog.getByLabel('Nome da campanha', { exact: true }).fill('Semana da voz');
  await dialog.getByLabel('Início (Brasília)', { exact: true }).fill('2020-01-01T00:00');
  // End safely in the past while still including the synthetic events from yesterday.
  const end = new Date(Date.now() - 3600000);
  const endParts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(end).replace(' ', 'T');
  await dialog.getByLabel('Fim (Brasília)', { exact: true }).fill(endParts);
  const created = adminPage.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/gamification/manage/campaigns'));
  await dialog.getByRole('button', { name: 'Criar campanha', exact: true }).click();
  const createdResponse = await created; assert.equal(createdResponse.status(), 201); const campaignId = (await createdResponse.json()).campaign.id;
  await expect(adminPage.getByRole('heading', { name: 'Semana da voz', exact: true })).toBeVisible();
  await expect(adminPage.locator('.game-campaign-detail tbody tr')).toHaveCount(3);
  await adminPage.getByRole('button', { name: 'Encerrar e premiar', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Confirmar encerramento', exact: true }).click();
  await expect(adminPage.getByRole('status')).toContainText('Campanha encerrada');
  await expect(adminPage.getByText('Prêmio concedido', { exact: true })).toBeVisible();
  assert.equal((await db.query("SELECT count(*)::int AS total FROM wallet_entries WHERE org_id=$1 AND source='leaderboard'", [orgId])).rows[0].total, 3);
  const repeated = await adminContext.request.post(`${base}/api/gamification/manage/campaigns/${campaignId}/close`, { headers: { 'x-matraca-request': '1' } });
  assert.equal(repeated.status(), 200);
  assert.equal((await db.query("SELECT count(*)::int AS total FROM wallet_entries WHERE org_id=$1 AND source='leaderboard'", [orgId])).rows[0].total, 3);
  await mkdir(resolve('.data'), { recursive: true });
  await adminPage.evaluate(() => window.scrollTo(0, 0));
  await adminPage.screenshot({ path: resolve('.data/phase11-management.png'), fullPage: true });

  const studentContext = await context(student); const page = await studentContext.newPage();
  await page.goto(`${base}/app/achievements`);
  await expect(page.getByRole('heading', { name: 'Suas medalhas', exact: true })).toBeVisible();
  await expect(page.locator('.game-badge')).toHaveCount(2);
  await expect(page.locator('.game-ranks tbody tr')).toHaveCount(3);
  await expect(page.locator('.game-own-rank')).toContainText('500 pontos');
  await page.getByLabel('Comunidade', { exact: true }).selectOption(groupId);
  await expect(page.locator('.game-ranks tbody tr')).toHaveCount(2);
  await page.getByLabel('Ano', { exact: true }).selectOption('2020');
  await expect(page.getByText('Ainda não há participantes com pontos neste período e nesta comunidade.')).toBeVisible();
  await page.getByLabel('Ano', { exact: true }).selectOption(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'America/Sao_Paulo' }).format(new Date(eventAt)));
  await expect(page.locator('.game-ranks tbody tr')).toHaveCount(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve('.data/phase11-student.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => window.scrollTo(0, 0));
  const mobileImage = await page.screenshot({ path: resolve('.data/phase11-mobile.png'), fullPage: true });
  assert.equal(mobileImage.readUInt32BE(16), 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.goto(`${base}/admin/gamification`);
  await expect(page.getByRole('heading', { name: 'Esta área tem outro perfil de acesso.' })).toBeVisible();

  const schoolContext = await context(school); const schoolPage = await schoolContext.newPage();
  await schoolPage.goto(`${base}/admin/gamification`);
  await expect(schoolPage.getByRole('heading', { name: 'Regras da organização' })).toBeVisible();
  await expect(schoolPage.getByRole('button', { name: 'Criar campanha', exact: true })).toHaveCount(0);

  const centralContext = await context(operator); const centralPage = await centralContext.newPage();
  await centralPage.goto('http://localhost:3011/backoffice/gamification');
  await centralPage.getByLabel('Organização', { exact: true }).selectOption(orgId);
  await expect(centralPage.getByRole('button', { name: /Semana da voz/ })).toBeVisible();
  await centralPage.getByRole('button', { name: 'Pontos e medalhas', exact: true }).click();
  await expect(centralPage.getByLabel('Aula concluída', { exact: true })).toHaveValue('45');

  await db.query("UPDATE orgs SET settings=settings||'{\"leaderboardEnabled\":false}'::jsonb WHERE id=$1", [orgId]);
  await page.goto(`${base}/app/achievements`);
  await expect(page.getByRole('heading', { name: 'O ranking está desativado.' })).toBeVisible();
  await expect(page.locator('.game-badge')).toHaveCount(2);
  assert.deepEqual(errors, []);
  process.stdout.write('F11 UI: regras e conflito CAS, campanha, premiação única, conquistas, ranking/grupos/ano, permissões, backoffice e mobile passaram.\n');
} finally {
  await browser?.close(); await app?.close(); await db.close();
  await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await control.close();
  await rm(directory, { recursive: true, force: true });
}
