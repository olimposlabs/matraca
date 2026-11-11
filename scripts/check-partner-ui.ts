import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { DEFAULT_BRANDING } from '../server/organizations.js';
import { seedCourses } from './seed-courses.js';

// Run after npm run build. Only bootstrap identities and the published Matraca base are fixtures.
// Partner, contract, branding, copied course, school, staff and classes are created through the UI.
// Login delivery uses the private local mailbox; no email or payment leaves this process.
const port = 3019;
const schema = `partner_ui_${randomUUID().replaceAll('-', '')}`;
const temporary = await mkdtemp(join(tmpdir(), 'matraca-partner-ui-'));
const databaseUrl = process.env.DATABASE_URL ?? localDatabaseUrl;
const control = createDatabase(databaseUrl);
const scopedUrl = new URL(databaseUrl); scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
const db = createDatabase(scopedUrl.toString());
const centralHost = 'backoffice.matraca.localhost';
const slug = `jornadas-${randomUUID().slice(0, 8)}`;
const partnerHost = `${slug}.matraca.localhost`;
const centralBase = `http://${centralHost}:${port}`, partnerBase = `http://${partnerHost}:${port}`;
const resultFile = resolve('.data/phase14-partner-results.json');
let app: Awaited<ReturnType<typeof createApp>> | undefined, browser: Browser | undefined;
const pageErrors: string[] = [];
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../server/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, migrations), 'utf8'));
  const centralOrgId = randomUUID(), matracaOrgId = randomUUID();
  await db.query("INSERT INTO orgs(id,slug,name,kind,branding) VALUES($1,'backoffice','Operação de teste','backoffice',$3),($2,'matraca','Matraca','matraca',$3)", [centralOrgId, matracaOrgId, { ...DEFAULT_BRANDING, _revision: 0 }]);
  await db.query("INSERT INTO domains(hostname,org_id) VALUES($1,$2),('matraca.localhost',$3)", [centralHost, centralOrgId, matracaOrgId]);
  await db.query("INSERT INTO users(org_id,email,name,roles,status) VALUES($1,'operador@example.test','Operador sintético',ARRAY['operator'],'active')", [centralOrgId]);
  const ids = new Map<string, string>([['matraca', matracaOrgId]]);
  await db.transaction(client => seedCourses(client, key => { if (!ids.has(key)) ids.set(key, randomUUID()); return ids.get(key)!; }));
  const baseCourseId = ids.get('course:matraca:base')!;
  app = await createApp({ databaseUrl: scopedUrl.toString(), storageRoot: join(temporary, 'objects') });
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1'] });
  await mkdir(resolve('.data'), { recursive: true });

  async function login(host: string, orgId: string, email: string): Promise<Page> {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    const base = `http://${host}:${port}`;
    await page.goto(`${base}/login`);
    await page.getByLabel('Seu e-mail', { exact: true }).fill(email);
    const delivery = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/auth/request'));
    await page.getByRole('button', { name: 'Receber link de acesso', exact: true }).click();
    assert.equal((await delivery).status(), 202);
    const folder = join(temporary, 'mailbox', orgId);
    const messages = await Promise.all((await readdir(folder)).map(async file => JSON.parse(await readFile(join(folder, file), 'utf8')) as { to: string; link: string }));
    const message = messages.find(item => item.to === email); assert.ok(message);
    const link = new URL(message.link); assert.equal(link.hostname, host); link.port = String(port);
    await page.goto(link.toString());
    await expect(page).toHaveURL(new RegExp(`/${host === centralHost ? 'backoffice' : 'app(?:/journey)?'}$`));
    const session = await context.request.get(`${base}/api/auth/session`); assert.equal(session.status(), 200);
    assert.equal((await session.json()).org.id, orgId);
    return page;
  }
  async function mutation(page: Page, path: string, method: string, action: () => Promise<unknown>, status = 201) {
    const waiting = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path);
    await action(); const response = await waiting; assert.equal(response.status(), status, `Falha em ${method} ${path}`); return response.json();
  }
  async function selectLoaded(dialog: Locator, label: string, value: string) {
    const select = dialog.getByLabel(label, { exact: true });
    await expect(select.locator(`option[value="${value}"]`)).toHaveCount(1);
    await expect(select).toBeEnabled(); await select.selectOption(value);
  }
  async function tab(page: Page, name: string) { await page.locator('.education-tabs').getByRole('button', { name, exact: true }).click(); }
  async function detail(page: Page, name: string) { await page.getByRole('button', { name: `Ver ${name}`, exact: true }).click(); return page.getByRole('dialog', { name, exact: true }); }
  async function closeDetail(page: Page, name: string) { await page.getByRole('dialog', { name, exact: true }).getByRole('button', { name: 'Fechar janela', exact: true }).click(); }

  const operator = await login(centralHost, centralOrgId, 'operador@example.test');
  await operator.getByRole('button', { name: 'Nova organização', exact: true }).click();
  await operator.getByLabel('Nome da organização', { exact: true }).fill('Horizonte das jornadas');
  await operator.getByLabel(/Identificador do portal/).fill(slug);
  await operator.getByLabel('Nome do administrador', { exact: true }).fill('Administração Horizonte');
  await operator.getByLabel('E-mail do administrador', { exact: true }).fill('administracao@example.test');
  const created = await mutation(operator, '/api/backoffice/orgs', 'POST', () => operator.getByRole('button', { name: 'Criar organização', exact: true }).click());
  const orgId = created.org.id as string; assert.equal(created.org.hostname, partnerHost);
  await operator.goto(`${centralBase}/backoffice/billing`);
  await operator.getByRole('combobox', { name: 'Organização parceira', exact: true }).selectOption(orgId);
  await operator.getByRole('button', { name: 'Contratos e preços', exact: true }).click();
  const month = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date());
  await operator.getByLabel('Vigência a partir de', { exact: true }).fill(month);
  await operator.getByLabel('Faixa 1: preço', { exact: true }).fill('0,90');
  await operator.getByRole('button', { name: 'Calcular exemplo', exact: true }).click();
  await expect(operator.getByRole('status').filter({ hasText: '1.440,00' })).toBeVisible();
  await operator.getByRole('button', { name: 'Publicar contrato', exact: true }).click();
  await expect(operator.getByRole('status').filter({ hasText: 'Versão contratual publicada' })).toBeVisible();
  await operator.screenshot({ path: resolve('.data/phase14-partner-contract.png'), fullPage: true });

  const admin = await login(partnerHost, orgId, 'administracao@example.test');
  await admin.goto(`${partnerBase}/admin`);
  await admin.getByLabel('Nome exibido no portal', { exact: true }).fill('Horizonte · sua voz');
  await admin.getByLabel('Cor principal', { exact: true }).fill('#24514a');
  await admin.getByLabel('Nome no singular', { exact: true }).fill('voz');
  await admin.getByLabel('Nome no plural', { exact: true }).fill('vozes');
  await mutation(admin, '/api/org/branding', 'PUT', () => admin.getByRole('button', { name: 'Publicar identidade', exact: true }).click(), 200);
  await expect(admin.getByRole('status').filter({ hasText: 'Identidade publicada' })).toBeVisible();
  const publishedBranding = await admin.context().request.get(`${partnerBase}/api/context`);
  assert.equal((await publishedBranding.json()).org.branding.creditPlural, 'vozes');
  await admin.screenshot({ path: resolve('.data/phase14-partner-branding.png'), fullPage: true });
  await admin.goto(`${partnerBase}/admin/courses`);
  await admin.getByRole('button', { name: 'Criar curso', exact: true }).click();
  const copyDialog = admin.getByRole('dialog', { name: 'Criar programa de ensino', exact: true });
  await copyDialog.getByLabel('Nome do curso', { exact: true }).fill('Horizonte · programa completo');
  await selectLoaded(copyDialog, 'Ponto de partida do curso', baseCourseId);
  const copy = await mutation(admin, '/api/courses/manage', 'POST', () => copyDialog.getByRole('button', { name: 'Criar cópia independente', exact: true }).click());
  const courseId = copy.course.id as string;
  await expect(admin.locator('.course-editor-top')).toContainText('48 unidades');
  await admin.getByRole('button', { name: 'Publicação e alunos', exact: true }).click();
  await mutation(admin, `/api/courses/manage/${courseId}/publish`, 'POST', () => admin.getByRole('button', { name: 'Publicar versão', exact: true }).click(), 200);
  await expect(admin.getByRole('status').filter({ hasText: 'Versão 1 publicada' })).toBeVisible();
  await admin.screenshot({ path: resolve('.data/phase14-partner-course.png'), fullPage: true });

  await admin.goto(`${partnerBase}/admin/education`); await tab(admin, 'Escolas');
  await admin.getByRole('button', { name: 'Cadastrar escola', exact: true }).click();
  const schoolForm = admin.getByRole('dialog', { name: 'Cadastrar escola', exact: true });
  await schoolForm.getByLabel('Nome', { exact: true }).fill('Horizonte Centro');
  await schoolForm.getByLabel('Cidade', { exact: true }).fill('São Paulo');
  await schoolForm.getByLabel('Estado', { exact: true }).fill('SP');
  const schoolId = (await mutation(admin, '/api/education/schools', 'POST', () => schoolForm.getByRole('button', { name: 'Salvar', exact: true }).click())).school.id as string;
  await tab(admin, 'Pessoas');
  async function person(page: Page, name: string, email: string, role: 'Professor' | 'Gestor de escola' | 'Aluno', school?: string) {
    await tab(page, 'Pessoas'); await page.getByRole('button', { name: 'Cadastrar pessoa', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Cadastrar pessoa', exact: true });
    await dialog.getByLabel('Nome', { exact: true }).fill(name); await dialog.getByLabel('E-mail', { exact: true }).fill(email);
    if (role !== 'Aluno') { await dialog.getByRole('checkbox', { name: 'Aluno', exact: true }).uncheck(); await dialog.getByRole('checkbox', { name: role, exact: true }).check(); }
    if (school) await selectLoaded(dialog, 'Escola', school);
    const result = await mutation(page, '/api/education/people', 'POST', () => dialog.getByRole('button', { name: 'Salvar', exact: true }).click());
    await expect(dialog).not.toBeVisible(); return result.person.id as string;
  }
  const teacherId = await person(admin, 'Professor Horizonte', 'professor@example.test', 'Professor', schoolId);
  const managerId = await person(admin, 'Gestora Centro', 'gestora@example.test', 'Gestor de escola');
  // Explicit delegation is performed separately from user creation.
  await tab(admin, 'Escolas');
  const schoolDetail = await detail(admin, 'Horizonte Centro');
  await schoolDetail.getByRole('button', { name: 'Vincular profissional', exact: true }).click();
  const staffDialog = admin.getByRole('dialog', { name: 'Vincular profissional', exact: true });
  await selectLoaded(staffDialog, 'Pessoa', managerId);
  await staffDialog.getByLabel('Papel na escola', { exact: true }).selectOption('school');
  await mutation(admin, `/api/education/schools/${schoolId}/staff`, 'POST', () => staffDialog.getByRole('button', { name: 'Salvar', exact: true }).click());
  await expect(schoolDetail).toContainText('Gestora Centro');
  await closeDetail(admin, 'Horizonte Centro');

  const teacher = await login(partnerHost, orgId, 'professor@example.test');
  await teacher.goto(`${partnerBase}/teacher`);
  await expect(teacher.getByRole('heading', { name: 'Sua aprovação está em andamento.', exact: true })).toBeVisible();
  await tab(admin, 'Pessoas');
  const teacherDetail = await detail(admin, 'Professor Horizonte');
  await teacherDetail.getByRole('button', { name: 'Aprovação e certificações', exact: true }).click();
  const approval = admin.getByRole('dialog', { name: 'Aprovação · Professor Horizonte', exact: true });
  await approval.getByLabel('Situação do professor', { exact: true }).selectOption('approved');
  await approval.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await approval.getByLabel('Nome da certificação', { exact: true }).fill('Formação em facilitação');
  await approval.getByLabel('Instituição emissora', { exact: true }).fill('Horizonte de teste');
  await mutation(admin, `/api/education/teachers/${teacherId}`, 'PATCH', () => approval.getByRole('button', { name: 'Salvar aprovação', exact: true }).click(), 200);
  await expect(teacherDetail).toContainText('Aprovado');
  await admin.screenshot({ path: resolve('.data/phase14-partner-teacher.png'), fullPage: true });
  await closeDetail(admin, 'Professor Horizonte');

  const manager = await login(partnerHost, orgId, 'gestora@example.test');
  await manager.goto(`${partnerBase}/admin/education`);
  await tab(manager, 'Escolas'); await expect(manager.getByRole('button', { name: 'Cadastrar escola', exact: true })).toHaveCount(0);
  const studentId = await person(manager, 'Aluna Horizonte', 'aluna@example.test', 'Aluno', schoolId);
  const classIds: string[] = [];
  for (const name of ['Expressão de manhã', 'Apresentações à noite']) {
    await tab(manager, 'Turmas'); await manager.getByRole('button', { name: 'Criar turma', exact: true }).click();
    const classForm = manager.getByRole('dialog', { name: 'Criar turma', exact: true });
    await classForm.getByLabel('Nome', { exact: true }).fill(name); await selectLoaded(classForm, 'Escola', schoolId);
    const classId = (await mutation(manager, '/api/education/classes', 'POST', () => classForm.getByRole('button', { name: 'Salvar', exact: true }).click())).class.id as string;
    classIds.push(classId);
    const classDetail = await detail(manager, name);
    await classDetail.getByRole('button', { name: 'Matricular aluno', exact: true }).click();
    const enrollment = manager.getByRole('dialog', { name: 'Matricular aluno', exact: true });
    await selectLoaded(enrollment, 'Aluno', studentId);
    await mutation(manager, `/api/education/classes/${classId}/enrollments`, 'POST', () => enrollment.getByRole('button', { name: 'Salvar', exact: true }).click());
    await expect(classDetail).toContainText('Aluna Horizonte');
    await classDetail.getByRole('button', { name: 'Atribuir professor', exact: true }).click();
    const assignment = manager.getByRole('dialog', { name: 'Atribuir professor', exact: true });
    await selectLoaded(assignment, 'Professor', teacherId);
    await mutation(manager, `/api/education/classes/${classId}/teachers`, 'POST', () => assignment.getByRole('button', { name: 'Salvar', exact: true }).click());
    await expect(classDetail).toContainText('Professor Horizonte'); await closeDetail(manager, name);
  }
  const student = await login(partnerHost, orgId, 'aluna@example.test');
  await student.goto(`${partnerBase}/app/classes`);
  await expect(student.locator('.education-student-view')).toContainText('Expressão de manhã');
  await expect(student.locator('.education-student-view')).toContainText('Apresentações à noite');
  await student.screenshot({ path: resolve('.data/phase14-partner-multiple-classes.png'), fullPage: true });
  assert.equal((await db.query("SELECT count(*)::int AS count FROM enrollments WHERE org_id=$1 AND student_id=$2 AND status='active'", [orgId, studentId])).rows[0].count, 2);
  await teacher.reload();
  await teacher.locator('.education-tabs').getByRole('button', { name: 'Alunos atribuídos', exact: true }).click();
  await expect(teacher.locator('.education-record-list')).toContainText('Aluna Horizonte');
  await teacher.screenshot({ path: resolve('.data/phase14-partner-teacher-assigned.png'), fullPage: true });
  // Closing one class retains both rows and leaves the other enrollment active.
  await manager.getByRole('button', { name: 'Editar Expressão de manhã', exact: true }).click();
  const editClass = manager.getByRole('dialog', { name: 'Editar turma', exact: true });
  await editClass.getByLabel('Situação', { exact: true }).selectOption('closed');
  await mutation(manager, `/api/education/classes/${classIds[0]}`, 'PATCH', () => editClass.getByRole('button', { name: 'Salvar', exact: true }).click(), 200);
  await student.reload(); await expect(student.locator('.education-student-view .education-history-row').filter({ hasText: 'Expressão de manhã' })).toContainText('Encerrado');
  await student.screenshot({ path: resolve('.data/phase14-partner-retained-history.png'), fullPage: true });
  const enrollmentStates = (await db.query('SELECT status FROM enrollments WHERE org_id=$1 AND student_id=$2 ORDER BY status', [orgId, studentId])).rows.map(row => row.status);
  assert.deepEqual(enrollmentStates, ['active', 'completed']);
  assert.equal((await student.context().request.get(`${partnerBase}/api/backoffice/orgs`)).status(), 403);
  assert.equal((await manager.context().request.post(`${partnerBase}/api/education/schools`, { headers: { 'x-matraca-request': '1' }, data: { name: 'Sem permissão' } })).status(), 403);
  // J09: create a distinct destination school and manager; transfer through the administrator UI.
  const walletBefore = (await db.query('SELECT balance,reserved FROM wallets WHERE org_id=$1 AND user_id=$2', [orgId, studentId])).rows[0];
  const mentoringPath = `${partnerBase}/api/mentoring/students/${studentId}`;
  assert.equal((await teacher.context().request.get(mentoringPath)).status(), 200);
  assert.equal((await manager.context().request.get(mentoringPath)).status(), 200);
  await tab(admin, 'Escolas'); await admin.getByRole('button', { name: 'Cadastrar escola', exact: true }).click();
  const destinationForm = admin.getByRole('dialog', { name: 'Cadastrar escola', exact: true });
  await destinationForm.getByLabel('Nome', { exact: true }).fill('Horizonte Sul');
  await destinationForm.getByLabel('Cidade', { exact: true }).fill('São Paulo');
  await destinationForm.getByLabel('Estado', { exact: true }).fill('SP');
  const destinationSchoolId = (await mutation(admin, '/api/education/schools', 'POST', () => destinationForm.getByRole('button', { name: 'Salvar', exact: true }).click())).school.id as string;
  await person(admin, 'Gestora Sul', 'gestora-sul@example.test', 'Gestor de escola', destinationSchoolId);
  const destinationManager = await login(partnerHost, orgId, 'gestora-sul@example.test');
  await destinationManager.goto(`${partnerBase}/admin/education`);
  assert.equal((await destinationManager.context().request.get(mentoringPath)).status(), 403);
  await tab(admin, 'Pessoas');
  const studentDetail = await detail(admin, 'Aluna Horizonte');
  await studentDetail.getByRole('button', { name: 'Transferir de escola', exact: true }).click();
  const transferForm = admin.getByRole('dialog', { name: 'Transferir aluno', exact: true });
  await selectLoaded(transferForm, 'Escola', destinationSchoolId);
  await transferForm.getByLabel('Motivo da transferência', { exact: true }).fill('Mudança de unidade solicitada pela aluna.');
  const transferred = await mutation(admin, `/api/education/students/${studentId}/transfer`, 'POST', () => transferForm.getByRole('button', { name: 'Transferir aluno', exact: true }).click(), 200);
  assert.equal(transferred.transferred, true); assert.equal(transferred.person.id, studentId); assert.equal(transferred.person.schoolId, destinationSchoolId);
  await expect(studentDetail).toContainText('Horizonte Sul');
  await admin.screenshot({ path: resolve('.data/phase14-partner-transfer.png'), fullPage: true });
  // The existing sessions must immediately gain or lose scope without logging in again.
  for (const former of [teacher, manager]) {
    assert.equal((await former.context().request.get(mentoringPath)).status(), 403);
    assert.equal((await former.context().request.get(`${mentoringPath}/sessions`)).status(), 403);
    assert.equal((await former.context().request.get(`${partnerBase}/api/education/people/${studentId}`)).status(), 403);
  }
  await teacher.reload();
  await teacher.locator('.education-tabs').getByRole('button', { name: 'Alunos atribuídos', exact: true }).click();
  await expect(teacher.getByRole('button', { name: 'Ver Aluna Horizonte', exact: true })).toHaveCount(0);
  await expect(teacher.getByText('Nenhum registro encontrado. Ajuste a busca ou cadastre o primeiro.', { exact: true })).toBeVisible();
  await manager.reload(); await tab(manager, 'Pessoas');
  await expect(manager.getByRole('button', { name: 'Ver Aluna Horizonte', exact: true })).toHaveCount(0);
  await destinationManager.reload();
  const destinationDetail = await detail(destinationManager, 'Aluna Horizonte');
  await expect(destinationDetail).toContainText('Expressão de manhã');
  await expect(destinationDetail).toContainText('Apresentações à noite');
  await expect(destinationDetail).toContainText('Horizonte Centro');
  await expect(destinationDetail).toContainText('Horizonte Sul');
  assert.equal((await destinationManager.context().request.get(mentoringPath)).status(), 200);
  assert.equal((await destinationManager.context().request.get(`${mentoringPath}/sessions`)).status(), 200);
  await destinationManager.screenshot({ path: resolve('.data/phase14-partner-destination-access.png'), fullPage: true });
  await student.reload();
  await expect(student.locator('.education-student-view')).toContainText('Horizonte Sul');
  await expect(student.locator('.education-student-view')).toContainText('Expressão de manhã');
  const transferredStates = (await db.query('SELECT status FROM enrollments WHERE org_id=$1 AND student_id=$2 ORDER BY status', [orgId, studentId])).rows.map(row => row.status);
  assert.deepEqual(transferredStates, ['completed', 'transferred']);
  assert.deepEqual((await db.query('SELECT balance,reserved FROM wallets WHERE org_id=$1 AND user_id=$2', [orgId, studentId])).rows[0], walletBefore);
  const schoolHistory = (await db.query('SELECT school_id,ended_at IS NULL AS active FROM student_schools WHERE org_id=$1 AND student_id=$2 ORDER BY started_at', [orgId, studentId])).rows;
  assert.deepEqual(schoolHistory, [{ school_id: schoolId, active: false }, { school_id: destinationSchoolId, active: true }]);
  const copied = (await db.query('SELECT source_course_id,draft FROM courses WHERE org_id=$1 AND id=$2', [orgId, courseId])).rows[0];
  assert.equal(copied.source_course_id, baseCourseId); assert.equal(copied.draft.modules.flatMap((module: { units: unknown[] }) => module.units).length, 48);
  assert.deepEqual(pageErrors, []);
  const result = { journeys: ['J06', 'J07', 'J09'], observedAt: new Date().toISOString(), browser: 'Chromium', port, bootstrapFixtures: ['backoffice and Matraca organizations', 'operator identity', 'published full Matraca base course'], ui: ['magic-link logins for operator/admin/manager/teacher/student', 'partner, hostname and administrator creation', 'contract preview and publication', 'partner branding publication', 'independent 48-unit base copy and publication', 'school creation', 'manager delegation', 'teacher pending gate, certification and approval', 'school creates student and two classes', 'same student enrolled in both classes', 'approved teacher assigned to both classes and sees student', 'student sees both classes and retained closed-class history', 'administrator transfers student to second school', 'former school and teacher immediately lose student access', 'distinct destination manager sees retained class and school history'], assertions: { activeEnrollmentsBeforeClosure: 2, closedClassEnrollmentStates: enrollmentStates, finalEnrollmentStates: transferredStates, formerTeacherMentoring: 403, formerManagerMentoring: 403, destinationManagerMentoring: 200, identityAndWalletPreserved: true, copiedUnits: 48, pageErrors: pageErrors.length, unauthorizedSchoolCreation: 403, studentBackofficeAccess: 403 }, externalMocks: ['private local email delivery; no proof of email ownership'], cleanup: 'isolated schema and private temporary storage removed in finally' };
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, journeys: result.journeys, resultFile, assertions: result.assertions }));
} catch (error) {
  if (browser) for (const [index, context] of browser.contexts().entries()) { const page = context.pages().at(-1); if (page) await page.screenshot({ path: resolve(`.data/phase14-partner-failure-${index}.png`), fullPage: true }).catch(() => undefined); }
  throw error;
} finally {
  await browser?.close(); await app?.close(); await db.close();
  await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await control.close(); await rm(temporary, { recursive: true, force: true });
}
