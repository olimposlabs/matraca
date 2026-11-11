import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { curriculumToCourse } from '../server/course-model.js';
import { publishCourseInTransaction } from '../server/courses.js';
import { loadCurriculumFromFile } from '../server/curriculum.js';
import { createDatabase } from '../server/db.js';
import { MockEvaluationProvider } from '../server/evaluation/provider.js';
import { startEvaluationWorker } from '../server/evaluation/worker.js';
import { probeMedia } from '../server/media/probe.js';
import { defaultOperationPolicy } from '../server/operation-policy.js';
import { DEFAULT_BRANDING } from '../server/organizations.js';
import { getWallet, grantInitialCredit } from '../server/wallet.js';

// Full J03/J20 acceptance, using the complete authored curriculum and real UI/API/DB.
// Synthetic identity/session/enrollment fixtures avoid coupling this long journey to J01.
// The isolated test organization allows 120 evaluations/hour; the demo keeps its limit.
const schema = `complete_course_ui_${randomUUID().replaceAll('-', '')}`;
const temporary = await mkdtemp(join(tmpdir(), 'matraca-complete-course-ui-'));
const control = createDatabase(process.env.DATABASE_URL ?? localDatabaseUrl);
const url = new URL(process.env.DATABASE_URL ?? localDatabaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = createDatabase(url.toString());
const port = 3018, studentBase = `http://127.0.0.1:${port}`, operatorBase = `http://localhost:${port}`;
let app: Awaited<ReturnType<typeof createApp>> | undefined, browser: Browser | undefined, stopWorker: (() => Promise<void>) | undefined;
type Progress = { versionId: string; status: string; completedUnits: number; units: { id: string; completedAt: string | null }[] };
type Evaluated = { id: string; status: string; credits: number; durationMicroseconds: number; report: { rubricVersion: string; observations: { criterionId: string; level: number | null; evidence: unknown[] }[] } };
const results: { unitId: string; kind: string; checklist: number; consumed: number; durationMicroseconds: number; balance: number }[] = [];
const pageErrors: string[] = [], screenshots: string[] = [];
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../server/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, migrations), 'utf8'));
  const orgId = randomUUID(), operatorOrgId = randomUUID(), studentId = randomUUID(), operatorId = randomUUID(), courseId = randomUUID();
  await db.query("INSERT INTO orgs(id,slug,name,kind,settings,branding) VALUES($1,'matraca','Matraca','matraca',$3,$4),($2,'backoffice','Operação Matraca','backoffice',$3,$4)", [orgId, operatorOrgId, { coursesEnabled: true, strictJourney: false }, { ...DEFAULT_BRANDING, displayName: 'Matraca', _revision: 0 }]);
  await db.query("INSERT INTO domains(hostname,org_id) VALUES('127.0.0.1',$1),('localhost',$2)", [orgId, operatorOrgId]);
  await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,'jornada@example.test','Pessoa da jornada completa',ARRAY['student'],'active'),($3,$4,'operacao@example.test','Operação sintética',ARRAY['operator'],'active')", [studentId, orgId, operatorId, operatorOrgId]);
  await db.query('INSERT INTO operation_policies(org_id,config) VALUES($1,$2)', [orgId, { ...defaultOperationPolicy, maxEvaluationsPerHour: 120 }]);
  const curriculum = await loadCurriculumFromFile(fileURLToPath(new URL('../docs/PLANO_DE_ENSINO.md', import.meta.url)));
  const courseDocument = curriculumToCourse(curriculum), units = courseDocument.modules.flatMap(module => module.units);
  assert.equal(courseDocument.modules.length, 12); assert.equal(units.length, 48);
  assert.equal(units.filter(unit => unit.kind === 'lesson').length, 36); assert.equal(units.filter(unit => unit.kind === 'review').length, 12);
  const version = await db.transaction(async client => {
    await client.query('INSERT INTO courses(id,org_id,title,draft) VALUES($1,$2,$3,$4)', [courseId, orgId, courseDocument.title, courseDocument]);
    return publishCourseInTransaction(client, orgId, courseId, 0, null);
  });
  const enrollmentId = (await db.query("INSERT INTO course_enrollments(org_id,course_id,version_id,student_id,source,source_ref) VALUES($1,$2,$3,$4,'demo','complete-course-ui') RETURNING id", [orgId, courseId, version.id, studentId])).rows[0].id as string;
  const target = { orgId, userId: studentId };
  await grantInitialCredit(db, target);
  const shortFile = join(temporary, 'short.mp4'), reviewFile = join(temporary, 'review-300s.mp4');
  for (const [seconds, output] of [[2, shortFile], [300, reviewFile]] as const) {
    await promisify(execFile)(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=1', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-bf', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', output]);
  }
  const reviewProbe = await probeMedia(reviewFile, { maxDurationSeconds: 301 });
  assert.equal(reviewProbe.durationMicroseconds, 300_000_000); assert.equal(reviewProbe.hasVideo, true); assert.equal(reviewProbe.hasAudio, false);
  app = await createApp({ databaseUrl: url.toString(), storageRoot: join(temporary, 'objects') });
  await app.listen({ host: '127.0.0.1', port });
  stopWorker = startEvaluationWorker(app.db, new MockEvaluationProvider());
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  async function actor(id: string, actorOrgId: string, hostname: string) {
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [actorOrgId, id, hostname, createHash('sha256').update(token).digest('hex')]);
    const context = await browser!.newContext({ viewport: { width: 1440, height: 1024 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'matraca_session', value: token, url: `http://${hostname}:${port}`, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); return page;
  }
  const student = await actor(studentId, orgId, '127.0.0.1');
  async function read<T>(page: Page, path: string): Promise<T> {
    const response = await page.request.get(new URL(path, page.url()).href); assert.equal(response.status(), 200); return response.json();
  }
  async function evaluate(file: string, objective: string): Promise<Evaluated> {
    await expect(student.getByLabel('Selecionar gravação')).toBeAttached();
    await student.locator('#recording-objective').fill(objective);
    await student.getByLabel('Selecionar gravação').setInputFiles(file);
    await student.getByRole('button', { name: 'Salvar gravação', exact: true }).click();
    await expect(student.getByText('Gravação salva. Você já pode ouvir ou assistir à sua prática.', { exact: true })).toBeVisible({ timeout: 30000 });
    await student.getByRole('button', { name: 'Solicitar avaliação', exact: true }).click();
    await expect(student.getByRole('heading', { name: 'Relatório simulado', exact: true })).toBeVisible({ timeout: 30000 });
    return (await read<{ evaluation: Evaluated }>(student, `/api/evaluations/${student.url().split('/').at(-1)}`)).evaluation;
  }
  await mkdir(resolve('.data'), { recursive: true });
  async function screenshot(name: string) {
    for (const [size, width, height] of [['desktop', 1440, 1024], ['mobile', 390, 844]] as const) {
      await student.setViewportSize({ width, height });
      await student.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
      await student.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const path = resolve(`.data/phase14-complete-course-${name}-${size}.png`); await student.screenshot({ path, fullPage: true }); screenshots.push(path);
    }
    await student.setViewportSize({ width: 1440, height: 1024 });
  }
  let expectedBalance = 1, longReviewCompleted = false;
  for (const [index, unit] of units.entries()) {
    await student.goto(`${studentBase}/app/courses/${courseId}?unit=${encodeURIComponent(unit.id)}`, { waitUntil: 'domcontentloaded' });
    const checkboxes = student.locator('.course-study-panel').getByRole('checkbox');
    await expect(checkboxes).toHaveCount(unit.checklist.length);
    for (let item = 0; item < unit.checklist.length; item++) await checkboxes.nth(item).check();
    await student.getByRole('button', { name: 'Concluir estudo e preparar a prática', exact: true }).click();
    expectedBalance += unit.studyCreditGrant;
    await student.getByRole('link', { name: 'Gravar ou enviar minha prática', exact: true }).click();
    const longReview: boolean = unit.kind === 'review' && !longReviewCompleted;
    const evaluation = await evaluate(longReview ? reviewFile : shortFile, `Curso completo: ${unit.title}`);
    const consumed: number = longReview ? 5 : 1; expectedBalance -= consumed;
    assert.equal(evaluation.status, 'completed'); assert.equal(evaluation.credits, consumed);
    assert.equal(evaluation.report.rubricVersion.startsWith(version.id), true);
    if (longReview) {
      assert.equal(evaluation.durationMicroseconds, 300_000_000);
      const vocalCriteria = unit.activity.criteria.filter(criterion => criterion.modality === 'audio');
      assert.equal(vocalCriteria.length, 2);
      for (const criterion of vocalCriteria) {
        const observation = evaluation.report.observations.find(item => item.criterionId === criterion.id);
        assert.equal(observation?.level, null);
        assert.deepEqual(observation.evidence, []);
      }
      const player = student.locator('video[aria-label="Gravação avaliada"]');
      await expect.poll(() => player.evaluate((element: HTMLVideoElement) => Number.isFinite(element.duration) ? element.duration : 0)).toBe(300);
      await student.locator('.evaluation-evidence').first().click();
      await expect.poll(() => player.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
      await player.evaluate((element: HTMLVideoElement) => element.pause());
      longReviewCompleted = true; await screenshot('300s');
    }
    if (index === units.length - 1) expectedBalance += courseDocument.completionCreditGrant;
    const progress = (await read<{ progress: Progress }>(student, `/api/journey/courses/${enrollmentId}`)).progress;
    assert.equal(progress.completedUnits, index + 1); assert.equal(progress.versionId, version.id);
    assert.ok(progress.units.find(item => item.id === unit.id)?.completedAt);
    const wallet = await getWallet(db, target); assert.deepEqual(wallet, { balance: expectedBalance, available: expectedBalance, reserved: 0 });
    results.push({ unitId: unit.id, kind: unit.kind, checklist: unit.checklist.length, consumed, durationMicroseconds: evaluation.durationMicroseconds, balance: wallet.balance });
    if ((index + 1) % 4 === 0) process.stdout.write(`Curso completo: ${index + 1}/48 unidades; saldo ${wallet.balance}.\n`);
  }
  assert.equal(longReviewCompleted, true); assert.equal(expectedBalance, 65);
  await student.goto(`${studentBase}/app/courses/${courseId}?unit=${encodeURIComponent(units.at(-1)!.id)}`, { waitUntil: 'domcontentloaded' });
  await expect(student.getByText('Você concluiu este curso.', { exact: true })).toBeVisible();
  await expect(student.getByRole('progressbar', { name: 'Progresso do curso' })).toHaveAttribute('aria-valuenow', '100');
  await screenshot('finished');
  await student.getByRole('link', { name: 'Estúdio de prática', exact: true }).click();
  await evaluate(shortFile, 'Prática livre com cursos ligados'); expectedBalance--;
  const operator = await actor(operatorId, operatorOrgId, 'localhost');
  await operator.goto(`${operatorBase}/backoffice?org=${orgId}`, { waitUntil: 'domcontentloaded' });
  await operator.getByRole('tab', { name: 'Preferências', exact: true }).click();
  await operator.getByRole('checkbox', { name: /Cursos na plataforma/ }).uncheck();
  await operator.getByRole('button', { name: 'Salvar preferências', exact: true }).click();
  await expect(operator.getByText('Preferências salvas para esta organização.', { exact: true })).toBeVisible();
  await student.getByRole('link', { name: 'Minha jornada', exact: true }).click();
  // A fresh route load obtains the published organization preference.
  await student.reload({ waitUntil: 'domcontentloaded' });
  await expect(student.getByRole('heading', { name: 'Seu espaço de prática continua aqui.', exact: true })).toBeVisible();
  await student.getByRole('link', { name: 'Praticar agora', exact: true }).click();
  await evaluate(shortFile, 'Prática livre com cursos desligados'); expectedBalance--;
  await operator.getByRole('checkbox', { name: /Cursos na plataforma/ }).check();
  await operator.getByRole('button', { name: 'Salvar preferências', exact: true }).click();
  await expect(operator.getByText('Preferências salvas para esta organização.', { exact: true })).toBeVisible();
  await student.goto(`${studentBase}/app/journey`, { waitUntil: 'domcontentloaded' });
  await expect(student.getByText('48 de 48 unidades concluídas', { exact: true })).toBeVisible();
  await screenshot('journey');
  const finalWallet = await getWallet(db, target); assert.deepEqual(finalWallet, { balance: 63, available: 63, reserved: 0 });
  assert.equal(expectedBalance, 63); assert.equal(results.length, 48); assert.equal(results.reduce((sum, unit) => sum + unit.checklist, 0), 192);
  assert.equal((await db.query("SELECT count(*)::int AS total FROM evaluation_requests WHERE status='completed'")).rows[0].total, 50);
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve('.data/phase14-complete-course-results.json'), JSON.stringify({
    ok: true, journeys: ['J03', 'J20'], recordedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    schema, port, testPolicy: { maxEvaluationsPerHour: 120 }, curriculumSha256: curriculum.provenance.sourceSha256,
    completedUnits: 48, evaluations: 50, courseVersion: version.version, versionId: version.id,
    initialCredits: 1, studyCredits: 96, completionCredits: 20, courseConsumption: 52, freePracticeConsumption: 2,
    reviewProbe, finalWallet, units: results, screenshots, pageErrors,
  }, null, 2));
  process.stdout.write('F14 J03/J20: 48/48 unidades autorais, 192 itens, 50 avaliações, revisão300s/player/evidência, carteira63/reservado0, práticas livres cursos ON/OFF, versão preservada e zero pageerrors passaram.\n');
} catch (error) {
  const safeError = (error instanceof Error ? error.message : String(error)).replace(/token=[^\s"'&)<]+/gi, 'token=[REDACTED]');
  await mkdir(resolve('.data'), { recursive: true });
  await writeFile(resolve('.data/phase14-complete-course-results.json'), JSON.stringify({ ok: false, completedUnits: results.length, error: safeError, results, pageErrors, screenshots }, null, 2));
  process.stderr.write(`F14 J03/J20 falhou: ${safeError}\n`); process.exitCode = 1;
} finally {
  await browser?.close(); await stopWorker?.(); await app?.close(); await db.close();
  try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
  await rm(temporary, { recursive: true, force: true });
}
