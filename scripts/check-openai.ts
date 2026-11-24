// Explicit, paid smoke check with synthetic speech. Excluded from npm test/CI.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import type { LightMyRequestResponse } from 'fastify';
import { chromium, expect, type Browser } from '@playwright/test';
import { createApp } from '../server/app.js';
import { createDatabase } from '../server/db.js';
import { localDatabaseUrl } from '../server/config.js';
import { evaluationConfiguration, loadOpenAIKey } from '../server/evaluation/openai-config.js';
import { createOpenAIProvider } from '../server/evaluation/openai-runtime.js';
import type { EvaluationReport } from '../server/evaluation/provider.js';
import { runEvaluationJob } from '../server/evaluation/worker.js';
import { getWallet, grantCredits } from '../server/wallet.js';

if (!process.argv.includes('--live')) throw new Error('Este teste usa a API paga. Execute com --live para habilitar.');
if (process.platform !== 'darwin') throw new Error('Este teste sintético usa a voz local do macOS (say).');
const apiKey = await loadOpenAIKey();
const config = evaluationConfiguration();
const execute = promisify(execFile);
const schema = `openai_smoke_${randomUUID().replaceAll('-', '')}`;
const directory = await mkdtemp(join(tmpdir(), 'matraca-openai-smoke-'));
const control = createDatabase(process.env.DATABASE_URL ?? localDatabaseUrl);
const databaseUrl = new URL(process.env.DATABASE_URL ?? localDatabaseUrl);
databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
const db = createDatabase(databaseUrl.toString());
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let browser: Browser | undefined;
try {
  await control.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL('../server/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  const orgId = randomUUID(), userId = randomUUID(), token = randomBytes(32).toString('base64url');
  await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,'openai-smoke','Matraca · teste sintético','matraca')", [orgId]);
  await db.query("INSERT INTO domains(hostname,org_id) VALUES('127.0.0.1',$1)", [orgId]);
  await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,'sintetico@example.test','Pessoa sintética',ARRAY['student'],'active')", [userId, orgId]);
  await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,'127.0.0.1',$3,now()+interval '1 hour')", [orgId, userId, createHash('sha256').update(token).digest('hex')]);
  await grantCredits(db, { orgId, userId, amount: 6, source: 'manual', sourceRef: 'synthetic-smoke', eventKey: randomUUID(), reason: 'Validação sintética da OpenAI' });
  app = await createApp({ databaseUrl: databaseUrl.toString(), storageRoot: join(directory, 'objects'), evaluationProvider: 'openai' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const headers = { host: new URL(address).host, cookie: `matraca_session=${token}`, 'x-matraca-request': '1' };
  const provider = createOpenAIProvider(db, app.storage, {
    apiKey, audioModel: config.audioModel, reportModel: config.reportModel,
  });
  const aiff = join(directory, 'speech.aiff'), wav = join(directory, 'speech.wav'), video = join(directory, 'presentation.mp4');
  await execute('/usr/bin/say', ['-v', 'Luciana', '-r', '155', '-o', aiff,
    'Bom dia. Nossa proposta é reservar dez minutos por semana para praticar apresentações. Primeiro, cada pessoa explica uma ideia. Depois, o grupo oferece uma sugestão concreta. Assim, todos aprendem com a prática. Podemos começar na próxima segunda-feira?'], { timeout: 30_000 });
  await execute(ffmpeg.path, ['-nostdin', '-loglevel', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', wav], { timeout: 30_000 });
  await execute(ffmpeg.path, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=5', '-i', wav,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], { timeout: 30_000 });
  const results = [];
  let lastId = '';
  for (const [file, filename, mime] of [[wav, 'fala.wav', 'audio/wav'], [video, 'apresentacao.mp4', 'video/mp4']]) {
    const boundary = `smoke-${randomUUID()}`;
    const metadata = { purpose: 'free', source: 'upload', scenario: 'executive', objective: 'Apresentar uma proposta de prática semanal de oratória.' };
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      await readFile(file), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload: LightMyRequestResponse = await app.inject({ method: 'POST', url: '/api/recordings', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(upload.statusCode, 201, upload.body);
    const recording = upload.json().recording;
    const clientKey = randomUUID();
    const post = () => app!.inject({ method: 'POST', url: '/api/evaluations', headers, payload: { recordingId: recording.id, clientKey, expectedProvider: 'openai' } });
    const queued = await post();
    assert.equal(queued.statusCode, 202, queued.body);
    lastId = queued.json().evaluation.id;
    assert.equal(await runEvaluationJob(db, provider, { requestId: lastId }), true);
    const detail: { status: string; errorCode: string | null; report: EvaluationReport; simulated: boolean } = (await app.inject({ method: 'GET', url: `/api/evaluations/${lastId}`, headers })).json().evaluation;
    await mkdir('.data', { recursive: true });
    await writeFile('.data/openai-smoke-last-result.json', JSON.stringify({ filename, detail }, null, 2));
    assert.equal(detail.status, 'completed', `OpenAI smoke failed: ${detail.errorCode}`);
    assert.equal(detail.report.provider, 'openai');
    assert.equal(detail.simulated, false);
    assert.equal(detail.report.observations.find(item => item.criterionId === 'presence')?.level, null);
    assert.equal((await post()).json().evaluation.id, lastId);
    results.push({ filename, durationMicroseconds: recording.durationMicroseconds, report: detail.report });
    process.stdout.write(`${filename}: relatório real concluído.\n`);
  }
  assert.deepEqual(await getWallet(db, { orgId, userId }), { balance: 4, reserved: 0, available: 4 });
  const calls = (await db.query('SELECT metadata FROM evaluation_provider_calls ORDER BY id')).rows;
  assert.equal(calls.length, 4);
  await mkdir('.data', { recursive: true });
  await writeFile('.data/openai-live-smoke.json', JSON.stringify({ checkedAt: new Date().toISOString(), results, calls, wallet: '4 available, 0 reserved' }, null, 2));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.context().addCookies([{ name: 'matraca_session', value: token, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${address}/app/evaluations/${lastId}`);
  await expect(page.getByRole('heading', { name: 'Relatório de oratória', exact: true })).toBeVisible();
  await expect(page.getByText('Avaliação com OpenAI', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: resolve('.data/openai-live-report.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve('.data/openai-live-report-mobile.png'), fullPage: true });
  process.stdout.write('OpenAI: upload, análise real de áudio/vídeo, relatório, replay, carteira e UI passaram.\n');
} finally {
  await browser?.close();
  await app?.close();
  await db.close();
  await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await control.close();
  await rm(directory, { recursive: true, force: true });
}
