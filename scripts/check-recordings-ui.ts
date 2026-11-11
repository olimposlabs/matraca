import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, type Browser } from '@playwright/test';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { DEFAULT_BRANDING } from '../server/organizations.js';
import type { RecordingView } from '../client/recordings.js';

// Run after npm run build. All DB rows and objects live in an isolated fixture.
const schema = `recordings_ui_${randomUUID().replaceAll('-', '')}`;
const directory = await mkdtemp(join(tmpdir(), 'matraca-recordings-ui-'));
const base = 'http://127.0.0.1:3007';
const control = createDatabase(process.env.DATABASE_URL ?? localDatabaseUrl);
const url = new URL(process.env.DATABASE_URL ?? localDatabaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = createDatabase(url.toString());
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let browser: Browser | undefined;
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../server/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(name, migrations), 'utf8'));
  const orgId = randomUUID(), userId = randomUUID(), token = randomBytes(32).toString('base64url');
  await db.query("INSERT INTO orgs(id,slug,name,kind,branding) VALUES($1,$2,'Estúdio de demonstração','matraca',$3)", [orgId, `ui-${orgId}`, { ...DEFAULT_BRANDING, displayName: 'Matraca', _revision: 0 }]);
  await db.query("INSERT INTO domains(hostname,org_id) VALUES('127.0.0.1',$1)", [orgId]);
  await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,'aluno@example.test','Pessoa de teste',ARRAY['student'],'active')", [userId, orgId]);
  await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,'127.0.0.1',$3,now()+interval '1 hour')", [orgId, userId, createHash('sha256').update(token).digest('hex')]);
  const audio = join(directory, 'pratica.wav');
  await promisify(execFile)(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=2', '-c:a', 'pcm_s16le', audio]);
  app = await createApp({ databaseUrl: url.toString(), storageRoot: join(directory, 'objects') });
  await app.listen({ host: '127.0.0.1', port: 3007 });
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 950 }, reducedMotion: 'reduce' });
  await context.grantPermissions(['camera', 'microphone'], { origin: base });
  await context.addCookies([{ name: 'matraca_session', value: token, url: base, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/app/recordings`);
  await expect(page.getByRole('heading', { name: 'Qual é a sua intenção?' })).toBeVisible();
  await page.getByLabel('Objetivo', { exact: true }).fill('Apresentar uma proposta com clareza.');
  await page.getByRole('radio', { name: /Reunião executiva/ }).check();
  await page.getByLabel('Selecionar gravação', { exact: true }).setInputFiles(audio);
  await expect(page.getByLabel('Prévia do áudio', { exact: true })).toBeVisible();
  const uploaded = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/recordings'));
  await page.getByRole('button', { name: 'Salvar gravação', exact: true }).click();
  const response = await uploaded;
  assert.equal(response.status(), 201);
  const saved = (await response.json()).recording as RecordingView;
  assert.equal(saved.scenario, 'executive'); assert.equal(saved.hasAudio, true); assert.equal(saved.hasVideo, false);
  await expect(page.locator('.studio-saved audio')).toBeVisible();
  await expect.poll(() => page.locator('.studio-saved audio').evaluate((node: HTMLAudioElement) => node.readyState)).toBeGreaterThan(0);
  const range = await context.request.get(`${base}/api/recordings/${saved.id}/media`, { headers: { range: 'bytes=0-15' } });
  assert.equal(range.status(), 206); assert.equal((await range.body()).length, 16);
  await mkdir(resolve('.data'), { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve('.data/phase07-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Ativar câmera e microfone', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Começar gravação', exact: true })).toBeVisible();
  await expect.poll(() => page.getByLabel('Prévia ao vivo da câmera', { exact: true }).evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Começar gravação', exact: true }).click();
  await expect(page.locator('.studio-timer')).toContainText('00:01');
  await page.getByRole('button', { name: 'Encerrar gravação', exact: true }).click();
  await expect(page.getByLabel('Prévia da gravação', { exact: true })).toBeVisible();
  const captured = page.waitForResponse(result => result.request().method() === 'POST' && result.url().endsWith('/api/recordings'));
  await page.getByRole('button', { name: 'Salvar gravação', exact: true }).click();
  const captureResponse = await captured; assert.equal(captureResponse.status(), 201);
  const capture = (await captureResponse.json()).recording as RecordingView;
  assert.equal(capture.source, 'capture'); assert.equal(capture.hasAudio, true); assert.equal(capture.hasVideo, true); assert.ok(capture.durationMicroseconds > 500_000);
  await expect(page.locator('.studio-saved video')).toBeVisible();

  await page.getByLabel('Selecionar gravação', { exact: true }).setInputFiles(audio);
  // Hold transport before transmission to exercise the browser's cancel action.
  // recordings.test.ts separately interrupts a real multipart stream mid-upload.
  let releaseUpload!: () => void;
  let observedUpload!: () => void;
  let finishedUpload!: () => void;
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  const uploadObserved = new Promise<void>(resolve => { observedUpload = resolve; });
  const uploadFinished = new Promise<void>(resolve => { finishedUpload = resolve; });
  await page.route('**/api/recordings', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    observedUpload(); await uploadGate; await route.abort('aborted').catch(() => {}); finishedUpload();
  });
  try {
    await page.getByRole('button', { name: 'Salvar gravação', exact: true }).click();
    await uploadObserved;
    await page.getByRole('button', { name: 'Cancelar envio', exact: true }).click();
    await expect(page.getByText('Envio cancelado. Sua prévia continua neste dispositivo.', { exact: true })).toBeVisible();
  } finally { releaseUpload(); await uploadFinished; await page.unroute('**/api/recordings'); }
  await page.getByRole('button', { name: 'Descartar e regravar', exact: true }).click();
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM recordings WHERE org_id=$1', [orgId])).rows[0].count, 2);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve('.data/phase07-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.reload();
  await expect(page.locator('.studio-recording-card')).toHaveCount(2);
  await page.getByLabel('Objetivo', { exact: true }).fill('Praticar a clareza da voz.');
  await page.getByRole('button', { name: 'Áudio', exact: true }).click();
  await page.getByRole('button', { name: 'Ativar microfone', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Começar gravação', exact: true })).toBeVisible();
  const microphone = page.getByRole('combobox', { name: 'Microfone', exact: true });
  const alternate = await microphone.locator('option').last().getAttribute('value');
  if (alternate) { await microphone.selectOption(alternate); await expect(page.getByRole('button', { name: 'Começar gravação', exact: true })).toBeVisible(); }
  await page.getByRole('button', { name: 'Começar gravação', exact: true }).click();
  await expect(page.locator('.studio-timer')).toContainText('00:01');
  await page.getByRole('button', { name: 'Encerrar gravação', exact: true }).click();
  await expect(page.getByLabel('Prévia do áudio', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Descartar e regravar', exact: true }).click();
  await page.reload();
  if (alternate) await expect(page.getByRole('combobox', { name: 'Microfone', exact: true })).toHaveValue(alternate);

  const denied = await browser.newContext();
  await denied.grantPermissions([], { origin: base });
  await denied.addCookies([{ name: 'matraca_session', value: token, url: base, httpOnly: true, sameSite: 'Lax' }]);
  const deniedPage = await denied.newPage();
  await deniedPage.goto(`${base}/app/recordings`);
  await deniedPage.getByRole('button', { name: 'Ativar câmera e microfone', exact: true }).click();
  await expect(deniedPage.getByRole('alert')).toContainText('O acesso foi recusado');
  await denied.close();
  const missing = await browser.newContext();
  await missing.addCookies([{ name: 'matraca_session', value: token, url: base, httpOnly: true, sameSite: 'Lax' }]);
  await missing.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Synthetic missing device', 'NotFoundError'); }; });
  const missingPage = await missing.newPage(); await missingPage.goto(`${base}/app/recordings`);
  await missingPage.getByRole('button', { name: 'Ativar câmera e microfone', exact: true }).click();
  await expect(missingPage.getByRole('alert')).toContainText('Não encontramos o dispositivo');
  await expect(missingPage.getByRole('button', { name: 'Selecionar arquivo', exact: true })).toBeEnabled();
  await missing.close();
  assert.deepEqual(errors, []);
  process.stdout.write('F07 UI: áudio, cenário, reprodução/range, MediaRecorder real de áudio/vídeo, dispositivos, descarte, cancelamento, recarga, permissão negada, ausência de dispositivo simulada e layout móvel passaram.\n');
} finally {
  await browser?.close(); await app?.close(); await db.close();
  try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
  await rm(directory, { recursive: true, force: true });
}
