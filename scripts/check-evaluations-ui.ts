import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, type Browser } from '@playwright/test';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { MockEvaluationProvider } from '../server/evaluation/provider.js';
import { startEvaluationWorker } from '../server/evaluation/worker.js';
import { getWallet, grantCredits } from '../server/wallet.js';

const schema = `evaluation_ui_${randomUUID().replaceAll('-', '')}`;
const base = 'http://127.0.0.1:3008';
const temp = await mkdtemp(join(tmpdir(), 'matraca-evaluation-ui-'));
const control = createDatabase(process.env.DATABASE_URL ?? localDatabaseUrl);
const url = new URL(process.env.DATABASE_URL ?? localDatabaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = createDatabase(url.toString());
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let browser: Browser | undefined;
let stopWorker: (() => Promise<void>) | undefined;
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../server/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(name, migrations), 'utf8'));
  }
  const orgId = randomUUID();
  const userId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,'evaluation-demo','Matraca','matraca')", [orgId]);
  await db.query("INSERT INTO domains(hostname,org_id) VALUES('127.0.0.1',$1)", [orgId]);
  await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,'aluno@example.test','Pessoa sintética',ARRAY['student'],'active')", [userId, orgId]);
  await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,'127.0.0.1',$3,now()+interval '1 hour')",
    [orgId, userId, createHash('sha256').update(token).digest('hex')]);
  await grantCredits(db, { orgId, userId, amount: 5, eventKey: 'evaluation-ui', reason: 'Validação local', source: 'manual', sourceRef: 'fixture' });
  const audio = join(temp, 'fala.wav');
  await promisify(execFile)(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=2', '-c:a', 'pcm_s16le', audio]);
  app = await createApp({ databaseUrl: url.toString(), storageRoot: join(temp, 'objects') });
  await app.listen({ host: '127.0.0.1', port: 3008 });
  stopWorker = startEvaluationWorker(app.db, new MockEvaluationProvider());
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 950 }, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'matraca_session', value: token, url: base, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const objective = 'Apresentar uma proposta com clareza.';
  await page.goto(`${base}/app/recordings`);
  await page.getByLabel('Objetivo', { exact: true }).fill(objective);
  await page.getByLabel('Selecionar gravação', { exact: true }).setInputFiles(audio);
  await page.getByRole('button', { name: 'Salvar gravação', exact: true }).click();
  await page.getByRole('button', { name: 'Solicitar avaliação' }).click();
  await expect(page.getByRole('heading', { name: 'Relatório simulado' })).toBeVisible();
  await expect(page.getByText('Sem nota neste formato')).toBeVisible();
  await expect(page.getByRole('button', { name: /Trecho ilustrativo/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /Trecho ilustrativo/ }).first().click();
  await expect.poll(() => page.locator('.evaluation-player audio').evaluate((node: HTMLAudioElement) => node.readyState)).toBeGreaterThan(0);
  assert.deepEqual(await getWallet(db, { orgId, userId }), { balance: 4, reserved: 0, available: 4 });
  await mkdir(resolve('.data'), { recursive: true });
  await page.screenshot({ path: resolve('.data/phase08-report-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve('.data/phase08-report-mobile.png'), fullPage: true });

  async function submit(scenario: string) {
    await page.goto(`${base}/app/recordings`);
    await page.getByRole('button', { name: new RegExp(objective.replace('.', '\\.')) }).click();
    await page.getByLabel('Cenário do simulador').selectOption(scenario);
    await page.getByRole('button', { name: 'Solicitar avaliação' }).click();
  }
  await submit('permanent');
  await expect(page.getByText('A avaliação simulada falhou. Os créditos reservados foram liberados.')).toBeVisible();
  assert.deepEqual(await getWallet(db, { orgId, userId }), { balance: 4, reserved: 0, available: 4 });
  await submit('delay');
  await page.getByRole('button', { name: 'Cancelar avaliação' }).click();
  await expect(page.getByText('A avaliação foi cancelada e a reserva foi liberada.')).toBeVisible();
  assert.deepEqual(await getWallet(db, { orgId, userId }), { balance: 4, reserved: 0, available: 4 });
  await submit('transient');
  await expect(page.getByRole('heading', { name: 'Relatório simulado' })).toBeVisible();
  assert.deepEqual(await getWallet(db, { orgId, userId }), { balance: 3, reserved: 0, available: 3 });
  await page.getByRole('link', { name: 'Minhas avaliações' }).click();
  await expect(page.locator('.evaluation-list li')).toHaveCount(4);
  assert.deepEqual(errors, []);
  process.stdout.write('F08 UI: upload real, relatório, áudio por faixa, evidência temporal, saldo, falha, cancelamento, retry e histórico passaram.\n');
} finally {
  await browser?.close();
  await stopWorker?.();
  await app?.close();
  await db.close();
  await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await control.close();
  await rm(temp, { recursive: true, force: true });
}
