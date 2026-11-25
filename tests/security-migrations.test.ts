import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createDatabase } from '../server/db.js';
import { testDatabaseUrl } from '../server/local-database-config.js';
import { seedId } from '../scripts/seed-id.js';

it('migra pedidos reais antigos sem debitar saldo ou interromper a simulação', async () => {
  const base = testDatabaseUrl();
  const schema = `upgrade_test_${randomUUID().replaceAll('-', '')}`;
  const control = createDatabase(base);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(url.href);
  const directory = new URL('../server/migrations/', import.meta.url);
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    const migrations = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    for (const name of migrations.filter(name => name < '015')) {
      await db.query(await readFile(new URL(name, directory), 'utf8'));
    }
    const org = (await db.query("INSERT INTO orgs(slug,name,kind) VALUES('upgrade','Organização de teste','partner') RETURNING id")).rows[0].id;
    const user = (await db.query("INSERT INTO users(org_id,email,name,roles,status) VALUES($1,'student@example.test','Aluno de teste',ARRAY['student'],'active') RETURNING id", [org])).rows[0].id;
    await db.query('INSERT INTO wallets(org_id,user_id,balance,reserved) VALUES($1,$2,4,2)', [org, user]);
    const grant = (await db.query(`INSERT INTO wallet_entries(org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,reason)
      VALUES($1,$2,4,'grant','manual','legacy','legacy','synthetic','Concessão antiga') RETURNING id`, [org, user])).rows[0].id;
    await db.query('INSERT INTO credit_lots(entry_id,org_id,user_id,quantity,remaining) VALUES($1,$2,$3,4,4)', [grant, org, user]);
    for (const provider of ['mock', 'openai']) {
      const request = randomUUID();
      const recording = (await db.query(`INSERT INTO recordings (org_id,student_id,object_key,filename,mime_type,byte_length,duration_us,
        has_audio,has_video,container,probe,objective,purpose,scenario,maximum_seconds,source)
        VALUES($1,$2,$3,'voz.wav','audio/wav',100,1000000,true,false,'wav','{}','Praticar','free','one_on_one',300,'upload') RETURNING id`, [org, user, `recordings/${request}`])).rows[0].id;
      await db.query('INSERT INTO credit_reservations(org_id,user_id,request_id,duration_us,amount) VALUES($1,$2,$3,1000000,1)', [org, user, request]);
      await db.query(`INSERT INTO evaluation_requests(id,org_id,student_id,recording_id,client_key,scenario,context,credits,provider)
        VALUES($1,$2,$3,$4,$5,'success','{}',1,$6)`, [request, org, user, recording, randomUUID(), provider]);
      await db.query('INSERT INTO evaluation_jobs(request_id) VALUES($1)', [request]);
    }
    const phase = migrations.find(name => name.startsWith('015_'))!;
    await db.query(await readFile(new URL(phase, directory), 'utf8'));
    const result = await db.query(`SELECT r.provider,r.status,j.state,w.status AS reservation,w.provider AS reservation_provider
      FROM evaluation_requests r JOIN evaluation_jobs j ON j.request_id=r.id
      JOIN credit_reservations w ON w.request_id=r.id::text ORDER BY r.provider`);
    expect(result.rows).toEqual([
      { provider: 'mock', status: 'queued', state: 'queued', reservation: 'reserved', reservation_provider: 'mock' },
      { provider: 'openai', status: 'failed', state: 'done', reservation: 'released', reservation_provider: 'openai' },
    ]);
    expect((await db.query('SELECT balance,reserved FROM wallets')).rows[0]).toEqual({ balance: 4, reserved: 1 });
    expect((await db.query('SELECT live_eligible FROM credit_lots')).rows[0].live_eligible).toBe(false);
  } finally {
    await db.close();
    try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
  }
});

it('preserva os cursos anteriores e compartilha só a primeira versão autoral do seed', async () => {
  const base = testDatabaseUrl();
  const schema = `course_upgrade_test_${randomUUID().replaceAll('-', '')}`;
  const control = createDatabase(base);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(url.href);
  const directory = new URL('../server/migrations/', import.meta.url);
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    const migrations = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    for (const name of migrations.filter(name => name < '016')) {
      await db.query(await readFile(new URL(name, directory), 'utf8'));
    }
    const rootOrg = seedId('matraca'), rootCourse = seedId('course:matraca:base');
    const otherCourse = randomUUID(), partnerOrg = randomUUID(), partnerCourse = randomUUID();
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,'matraca','Matraca','matraca'),($2,'partner','Parceiro','partner')",
      [rootOrg, partnerOrg]);
    await db.query(`INSERT INTO courses(id,org_id,title,status,draft,source_course_id) VALUES
      ($1,$2,'Base','published','{}',NULL),($3,$2,'Outro','published','{}',NULL),($4,$5,'Cópia','draft','{}',$1)`,
      [rootCourse, rootOrg, otherCourse, partnerCourse, partnerOrg]);
    const versions = await db.query<{ id: string }>(`INSERT INTO course_versions(org_id,course_id,version,document) VALUES
      ($1,$2,1,'{}'),($1,$2,2,'{}'),($1,$3,1,'{}') RETURNING id`, [rootOrg, rootCourse, otherCourse]);
    const phase = migrations.find(name => name.startsWith('016_'))!;
    await db.query(await readFile(new URL(phase, directory), 'utf8'));
    expect((await db.query('SELECT course_id,version_id FROM course_base_shares')).rows)
      .toEqual([{ course_id: rootCourse, version_id: versions.rows[0].id }]);
    expect((await db.query('SELECT source_course_id FROM courses WHERE id=$1', [partnerCourse])).rows[0])
      .toEqual({ source_course_id: rootCourse });
  } finally {
    await db.close();
    try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
  }
});

it('a migração encerra credenciais legadas e preserva a conta', async () => {
  const base = testDatabaseUrl();
  const schema = `identity_upgrade_test_${randomUUID().replaceAll('-', '')}`;
  const control = createDatabase(base);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(url.href);
  const directory = new URL('../server/migrations/', import.meta.url);
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    const entries = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    for (const entry of entries.filter(name => name < '018')) {
      await db.query(await readFile(new URL(entry, directory), 'utf8'));
    }
    const org = randomUUID(), user = randomUUID();
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,'identity-upgrade','Matraca teste','matraca')", [org]);
    await db.query("INSERT INTO domains(hostname,org_id) VALUES('identity-upgrade.localhost',$1)", [org]);
    await db.query("INSERT INTO users (id,org_id,email,name,roles,status) VALUES($1,$2,'tester@example.test','Pessoa teste',ARRAY['student'],'active')",
      [user, org]);
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,'identity-upgrade.localhost',$3,clock_timestamp()+interval '1 hour')",
      [org, user, '0'.repeat(64)]);
    await db.query("INSERT INTO auth_tokens(org_id,user_id,hostname,token_hash,purpose,expires_at) VALUES($1,$2,'identity-upgrade.localhost',$3,'login',clock_timestamp()+interval '10 minutes')",
      [org, user, '1'.repeat(64)]);
    await db.query(await readFile(new URL(entries.find(name => name.startsWith('018_'))!, directory), 'utf8'));
    expect((await db.query('SELECT id,status FROM users WHERE id=$1', [user])).rows).toEqual([{ id: user, status: 'active' }]);
    expect((await db.query('SELECT 1 FROM sessions WHERE revoked_at IS NULL')).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM auth_tokens WHERE used_at IS NULL')).rowCount).toBe(0);
  } finally {
    await db.close();
    try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); }
  }
});
