import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { MockEvaluationProvider, type EvaluationProvider } from '../server/evaluation/provider.js';
import { runEvaluationJob } from '../server/evaluation/worker.js';
import { getWallet, grantCredits } from '../server/wallet.js';

interface Student {
  orgId: string;
  userId: string;
  host: string;
  cookie: string;
}

describe('fila, relatórios e reserva atômica', () => {
  const schema = `evaluation_test_${randomUUID().replaceAll('-', '')}`;
  const base = process.env.DATABASE_URL ?? localDatabaseUrl;
  const control = createDatabase(base);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(url.toString());
  const provider = new MockEvaluationProvider();
  let storageRoot: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    await control.query(`CREATE SCHEMA ${schema}`);
    const migrations = new URL('../server/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await db.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    storageRoot = await mkdtemp(join(tmpdir(), 'matraca-evaluation-'));
    app = await createApp({ databaseUrl: url.toString(), storageRoot });
  });

  afterAll(async () => {
    await app?.close();
    await db.close();
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.close();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  async function student(credits = 2, settings = {}, orgId: string = randomUUID()): Promise<Student> {
    const slug = `eval-${orgId}`;
    const host = `${slug}.localhost`;
    const userId = randomUUID();
    await db.query(
      "INSERT INTO orgs(id,slug,name,kind,settings) VALUES ($1,$2,'Org sintética','partner',$3) ON CONFLICT DO NOTHING",
      [orgId, slug, settings],
    );
    await db.query('INSERT INTO domains(hostname,org_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [host, orgId]);
    await db.query(
      "INSERT INTO users(id,org_id,email,name,roles,status,profile) VALUES ($1,$2,$3,'Aluno sintético',ARRAY['student'],'active',$4)",
      [userId, orgId, `${userId}@example.test`, { profession: 'Docente', goals: ['Explicar ideias com clareza'] }],
    );
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    await db.query(
      "INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES ($1,$2,$3,$4,now()+interval '1 hour')",
      [orgId, userId, host, hash],
    );
    if (credits) await grantCredits(db, { orgId, userId, amount: credits, source: 'manual', sourceRef: 'test', eventKey: randomUUID(), reason: 'Teste sintético' });
    return { orgId, userId, host, cookie: `matraca_session=${token}` };
  }

  async function recording(actor: Student, duration = 30_000_000, purpose = 'free') {
    const id = randomUUID();
    await db.query(
      `INSERT INTO recordings(id,org_id,student_id,object_key,filename,mime_type,byte_length,duration_us,has_audio,has_video,
       container,probe,objective,purpose,scenario,maximum_seconds,source)
       VALUES ($1,$2,$3,$4,'voz.wav','audio/wav',100,$5,true,false,'wav','{}','Explicar a ideia',$6,'one_on_one',300,'upload')`,
      [id, actor.orgId, actor.userId, `recordings/${id}`, duration, purpose],
    );
    return id;
  }

  function call(actor: Student, method: 'GET' | 'POST', url: string, body?: object) {
    return app.inject({
      method, url,
      headers: { host: actor.host, cookie: actor.cookie, 'x-matraca-request': '1' },
      ...(body ? { payload: body } : {}),
    });
  }

  async function submit(actor: Student, recordingId: string, scenario = 'success', clientKey = randomUUID()) {
    const response = await call(actor, 'POST', '/api/evaluations', { recordingId, clientKey, scenario });
    expect(response.statusCode, response.body).toBe(202);
    return response.json().evaluation as { id: string; credits: number; status: string };
  }

  async function read(actor: Student, id: string) {
    const response = await call(actor, 'GET', `/api/evaluations/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().evaluation;
  }

  it('reserva antes do processamento e conclui uma vez mesmo com workers e replays concorrentes', async () => {
    const actor = await student(2);
    const media = await recording(actor, 61_000_000);
    const key = randomUUID();
    const [first, second] = await Promise.all([submit(actor, media, 'success', key), submit(actor, media, 'success', key)]);
    expect(first).toEqual(second);
    expect(first.credits).toBe(2);
    expect(await getWallet(db, actor)).toMatchObject({ balance: 2, reserved: 2, available: 0 });
    expect((await call(actor, 'POST', '/api/evaluations', { recordingId: media, clientKey: randomUUID() })).statusCode).toBe(409);
    expect((await Promise.all([runEvaluationJob(db, provider), runEvaluationJob(db, provider)])).sort()).toEqual([false, true]);
    expect(await getWallet(db, actor)).toMatchObject({ balance: 0, reserved: 0 });
    const result = await read(actor, first.id);
    expect(result).toMatchObject({ status: 'completed', simulated: true, attempts: 1 });
    expect(result.report.observations.find((item: { criterionId: string }) => item.criterionId === 'presence').level).toBeNull();
    expect((await submit(actor, media, 'success', key)).status).toBe('completed');
    expect((await db.query('SELECT event_type FROM evaluation_outbox WHERE request_id=$1 ORDER BY id', [first.id])).rows)
      .toEqual([{ event_type: 'queued' }, { event_type: 'completed' }]);
  });

  it('insuficiência e tentativa cruzada não criam tarefa nem reserva', async () => {
    const owner = await student(0);
    const foreign = await student(1);
    const other = await student(1, {}, owner.orgId);
    const media = await recording(owner);
    const body = { recordingId: media, clientKey: randomUUID() };
    expect((await call(owner, 'POST', '/api/evaluations', body)).statusCode).toBe(402);
    expect((await call(foreign, 'POST', '/api/evaluations', body)).statusCode).toBe(404);
    expect((await call(other, 'POST', '/api/evaluations', body)).statusCode).toBe(404);
    expect((await db.query('SELECT id FROM evaluation_requests WHERE recording_id=$1', [media])).rowCount).toBe(0);
  });

  it('avaliação livre continua quando cursos e diagnóstico estão desativados', async () => {
    const actor = await student(2, { coursesEnabled: false, diagnosticEnabled: false });
    const diagnostic = await recording(actor, 10_000_000, 'diagnostic');
    expect((await call(actor, 'POST', '/api/evaluations', { recordingId: diagnostic, clientKey: randomUUID() })).statusCode).toBe(403);
    const free = await submit(actor, await recording(actor));
    await runEvaluationJob(db, provider);
    expect(await read(actor, free.id)).toMatchObject({ status: 'completed', purpose: 'free' });
    const outsider = await student(1, {}, actor.orgId);
    expect((await call(outsider, 'GET', `/api/evaluations/${free.id}`)).statusCode).toBe(403);
    expect((await call(outsider, 'GET', `/api/evaluations?studentId=${actor.userId}`)).statusCode).toBe(403);
    expect((await call(outsider, 'POST', `/api/evaluations/${free.id}/cancel`)).statusCode).toBe(404);
  });

  it('retenta falha transitória na mesma reserva', async () => {
    const actor = await student(2);
    const order = await submit(actor, await recording(actor), 'transient');
    await runEvaluationJob(db, provider);
    expect(await read(actor, order.id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await getWallet(db, actor)).toMatchObject({ balance: 2, reserved: 1 });
    await db.query("UPDATE evaluation_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE request_id=$1", [order.id]);
    await runEvaluationJob(db, provider);
    expect(await read(actor, order.id)).toMatchObject({ status: 'completed', attempts: 2 });
    expect(await getWallet(db, actor)).toMatchObject({ balance: 1, reserved: 0 });
  });

  it.each(['permanent', 'invalid'] as const)('libera a reserva na falha %s', async scenario => {
    const actor = await student(1);
    const order = await submit(actor, await recording(actor), scenario);
    await runEvaluationJob(db, provider);
    expect(await read(actor, order.id)).toMatchObject({ status: 'failed', errorCode: scenario, report: null });
    expect(await getWallet(db, actor)).toMatchObject({ balance: 1, reserved: 0 });
  });

  it('limita a três tentativas quando o provedor excede o prazo', async () => {
    const actor = await student(1);
    const order = await submit(actor, await recording(actor), 'timeout');
    for (let i = 0; i < 3; i++) {
      await runEvaluationJob(db, provider, 5);
      await db.query("UPDATE evaluation_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE request_id=$1", [order.id]);
    }
    expect(await read(actor, order.id)).toMatchObject({ status: 'failed', attempts: 3, errorCode: 'timeout', report: null });
    expect(await getWallet(db, actor)).toMatchObject({ balance: 1, reserved: 0 });
    expect(await runEvaluationJob(db, provider)).toBe(false);
  });

  it('cancela durante o processamento e descarta o retorno posterior', async () => {
    const actor = await student(1);
    const order = await submit(actor, await recording(actor));
    let notifyStarted!: () => void;
    let resumeProvider!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const resume = new Promise<void>(resolve => { resumeProvider = resolve; });
    const delayed: EvaluationProvider = {
      async evaluate(context, options) {
        notifyStarted();
        await resume;
        return provider.evaluate(context, options);
      },
    };
    const processing = runEvaluationJob(db, delayed);
    await Promise.race([started, processing]);
    expect(await read(actor, order.id)).toMatchObject({ status: 'processing' });
    const cancelled = await call(actor, 'POST', `/api/evaluations/${order.id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    resumeProvider();
    await processing;
    expect(await read(actor, order.id)).toMatchObject({ status: 'cancelled', report: null });
    expect(await getWallet(db, actor)).toMatchObject({ balance: 1, reserved: 0 });
  });

  it('reverte o débito se a gravação do resultado falhar e recupera lease vencido', async () => {
    const actor = await student(1);
    const order = await submit(actor, await recording(actor));
    await db.query(`CREATE FUNCTION reject_test_report() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated persistence failure'; END $$;
      CREATE TRIGGER reject_test_report BEFORE INSERT ON evaluation_results FOR EACH ROW EXECUTE FUNCTION reject_test_report()`);
    try {
      await expect(runEvaluationJob(db, provider)).rejects.toThrow('simulated persistence failure');
    } finally {
      await db.query('DROP TRIGGER reject_test_report ON evaluation_results');
    }
    expect(await getWallet(db, actor)).toMatchObject({ balance: 1, reserved: 1 });
    expect(await read(actor, order.id)).toMatchObject({ status: 'processing', report: null });
    await db.query("UPDATE evaluation_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE request_id=$1", [order.id]);
    await runEvaluationJob(db, provider);
    expect(await read(actor, order.id)).toMatchObject({ status: 'completed', attempts: 2 });
    expect(await getWallet(db, actor)).toMatchObject({ balance: 0, reserved: 0 });
  });
});
