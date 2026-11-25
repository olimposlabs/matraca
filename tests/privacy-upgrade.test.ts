import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { seedId } from '../scripts/seed-id.js';
import { createDatabase } from '../server/db.js';
import { testDatabaseUrl } from '../server/local-database-config.js';
import { applyPrivacy, privacyPlan } from '../server/privacy-retention.js';
import { LocalStorage } from '../server/storage.js';
import { getWallet, grantCredits, reserveCredits } from '../server/wallet.js';

it('adota a migração 019 sobre os pedidos antigos preservando mock, saldos e comprovantes', async () => {
  const schema = `privacy_upgrade_${randomUUID().replaceAll('-', '')}`;
  const base = testDatabaseUrl();
  const control = createDatabase(base);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(url.href);
  const directoryRoot = await mkdtemp(join(tmpdir(), 'matraca-privacy-upgrade-'));
  const storage = new LocalStorage(join(directoryRoot, 'objects'));
  const env: NodeJS.ProcessEnv = {
    ...process.env, APP_MODE: 'local', APP_PARTNER_DOMAIN_SUFFIX: 'matraca.localhost', EVALUATION_PROVIDER: 'mock',
    DATABASE_URL: url.href, MATRACA_MIGRATION_DATABASE_URL: url.href, STORAGE_ROOT: storage.root,
  };
  delete env.OPENAI_API_KEY;
  const runSeed = (script: string) => promisify(execFile)('npm', ['run', script], { env });
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    const directory = new URL('../server/migrations/', import.meta.url);
    const migration = '019_evaluation_privacy.sql';
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql') && name < migration).sort()) {
      await db.query(await readFile(new URL(file, directory), 'utf8'));
    }
    await runSeed('db:seed');
    const orgId = randomUUID();
    const userId = randomUUID();
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,'privacy-upgrade','Piloto sintético','matraca')", [orgId]);
    await db.query("INSERT INTO users(id,org_id,email,name,status) VALUES($1,$2,'aluno@example.test','Conta sintética','active')", [userId, orgId]);
    await grantCredits(db, { orgId, userId, amount: 3, eventKey: 'privacy-upgrade', reason: 'Ensaio sintético',
      source: 'manual', sourceRef: 'fixture', actorUserId: userId, liveEligible: true });
    const orders = [];
    for (const provider of ['openai', 'mock'] as const) {
      const id = randomUUID();
      const media = randomUUID();
      await db.query(`INSERT INTO recordings(id,org_id,student_id,object_key,filename,mime_type,byte_length,duration_us,has_audio,has_video,
        container,probe,objective,purpose,scenario,maximum_seconds,source)
        VALUES($1,$2,$3,$4,'voz.wav','audio/wav',100,30000000,true,false,'wav','{}','Prática sintética','free','one_on_one',300,'upload')`,
      [media, orgId, userId, `recordings/${media}`]);
      await reserveCredits(db, { orgId, userId, requestId: id, durationMicroseconds: 30_000_000, provider });
      await db.query(`INSERT INTO evaluation_requests(id,org_id,student_id,recording_id,client_key,scenario,context,credits,provider)
        VALUES($1,$2,$3,$4,$5,'success',$6,1,$7)`,
      [id, orgId, userId, media, randomUUID(), { learner: { profession: 'Perfil sintético' } }, provider]);
      await db.query('INSERT INTO evaluation_jobs(request_id) VALUES($1)', [id]);
      orders.push(id);
    }
    const [real, mock] = orders;
    await db.query(`INSERT INTO live_evaluation_admissions(request_id,org_id,student_id,minutes,remaining_calls)
      VALUES($1,$2,$3,1,5)`, [real, orgId, userId]);
    await db.query('INSERT INTO live_evaluation_dispatches(request_id,attempt,call_index) VALUES($1,1,0)', [real]);
    expect(await getWallet(db, { orgId, userId })).toMatchObject({ balance: 3, reserved: 2 });
    await db.query(await readFile(new URL(migration, directory), 'utf8'));
    const updated = (await db.query(`SELECT r.status,r.error_code,r.context->'learner' AS learner,j.state
      FROM evaluation_requests r JOIN evaluation_jobs j ON j.request_id=r.id WHERE r.id=$1`, [real])).rows[0];
    expect(updated).toEqual({ status: 'failed', error_code: 'authorization', learner: {}, state: 'done' });
    expect((await db.query('SELECT status FROM evaluation_requests WHERE id=$1', [mock])).rows[0].status).toBe('queued');
    expect((await db.query('SELECT remaining_calls FROM live_evaluation_admissions WHERE request_id=$1', [real])).rows[0].remaining_calls).toBe(0);
    expect((await db.query('SELECT request_id FROM live_evaluation_dispatches WHERE request_id=$1', [real])).rowCount).toBe(1);
    expect(await getWallet(db, { orgId, userId })).toMatchObject({ balance: 3, reserved: 1 });

    const erased = { orgId: seedId('parceiro'), studentId: seedId('parceiro:aluno2@parceiro.test') };
    const preview = await privacyPlan(db, storage, erased);
    await applyPrivacy(db, storage, erased, preview.fingerprint);
    await runSeed('db:seed');
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      expect((await runSeed('db:seed:examples')).stdout).toContain('Exemplos preservados');
    }
    const person = (await db.query(`SELECT status,name,profile,email FROM users
      WHERE org_id=$1 AND (id=$2 OR email='aluno2@parceiro.test')`, [erased.orgId, erased.studentId])).rows;
    expect(person).toEqual([{
      status: 'suspended', name: 'Conta removida', profile: {}, email: expect.stringMatching(/@local\.invalid$/u),
    }]);
    expect((await db.query("SELECT id FROM users WHERE org_id=$1 AND email='ana@exemplo.test' AND status='active'", [erased.orgId])).rowCount).toBe(1);
  } finally {
    await db.close();
    try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await control.close(); await rm(directoryRoot, { recursive: true, force: true }); }
  }
});
