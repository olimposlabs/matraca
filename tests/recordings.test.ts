import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { emptyCourse, type CourseDocument } from '../server/course-model.js';
import { createDatabase } from '../server/db.js';

interface Actor { orgId: string; userId: string; host: string; cookie: string }
interface UploadMetadata { purpose: 'free' | 'diagnostic' | 'course'; source: 'upload' | 'capture'; objective?: string; scenario?: string; enrollmentId?: string; unitId?: string }
const free: UploadMetadata = { purpose: 'free', source: 'upload', objective: 'Apresentar uma ideia com clareza.', scenario: 'executive' };
const run = promisify(execFile);
const headers = (actor: Actor) => ({ host: actor.host, cookie: actor.cookie, origin: `http://${actor.host}`, 'x-matraca-request': '1' });

describe('gravações privadas e upload real', () => {
  const schema = `recordings_test_${randomUUID().replaceAll('-', '')}`;
  let app: FastifyInstance, db: ReturnType<typeof createDatabase>, control: ReturnType<typeof createDatabase>;
  let root: string, databaseUrl: string, address: string | undefined;
  let video: Buffer, audio: Buffer, capture: Buffer, longAudio: Buffer, fiveMinutes: Buffer, tooLong: Buffer;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL ?? localDatabaseUrl;
    control = createDatabase(base);
    await control.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base); url.searchParams.set('options', `-c search_path=${schema}`); databaseUrl = url.toString();
    db = createDatabase(databaseUrl);
    const migrations = new URL('../server/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(name, migrations), 'utf8'));
    root = await mkdtemp(join(tmpdir(), 'matraca-recordings-'));
    app = await createApp({ databaseUrl, storageRoot: join(root, 'objects') });
    const generate = async (name: string, args: string[]) => {
      const path = join(root, name);
      await run(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args, path]);
      return readFile(path);
    };
    video = await generate('video.mp4', ['-f', 'lavfi', '-i', 'color=size=32x32:rate=10:duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
    audio = await generate('audio.wav', ['-f', 'lavfi', '-i', 'anullsrc=sample_rate=1000:channel_layout=mono', '-t', '1.25', '-c:a', 'pcm_s16le']);
    longAudio = await generate('long.wav', ['-f', 'lavfi', '-i', 'anullsrc=sample_rate=1000:channel_layout=mono', '-t', '30.001', '-c:a', 'pcm_s16le']);
    fiveMinutes = await generate('five.mp4', ['-f', 'lavfi', '-i', 'color=size=32x32:rate=2:duration=300', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
    tooLong = await generate('long.mp4', ['-f', 'lavfi', '-i', 'color=size=32x32:rate=2:duration=300.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
    capture = await readFile(new URL('./fixtures/media/media-recorder.webm', import.meta.url));
  }, 20_000);
  afterAll(async () => {
    await app?.close(); await db?.close();
    if (control) { try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); } }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function actor(role = 'student', orgId: string = randomUUID(), kind = 'partner'): Promise<Actor> {
    const host = `recording-${orgId}.localhost`;
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,$2,'Organização sintética',$3) ON CONFLICT DO NOTHING", [orgId, `recording-${orgId}`, kind]);
    await db.query('INSERT INTO domains(hostname,org_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [host, orgId]);
    const userId = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO users(id,org_id,email,name,roles,status) VALUES($1,$2,$3,'Pessoa sintética',$4,'active')", [userId, orgId, `${userId}@example.test`, [role]]);
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [orgId, userId, host, createHash('sha256').update(token).digest('hex')]);
    return { orgId, userId, host, cookie: `matraca_session=${token}` };
  }
  const get = (who: Actor, path: string, extra = {}) => app.inject({ method: 'GET', url: path, headers: { ...headers(who), ...extra } });
  const json = (who: Actor, path: string, payload: object) => app.inject({ method: 'POST', url: path, headers: headers(who), payload });
  function multipart(metadata: object, file: Buffer, options: { filename?: string; mime?: string; reverse?: boolean; extra?: string } = {}) {
    const boundary = `recording-${randomUUID()}`;
    const field = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`);
    const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename ?? 'presentation.mp4'}"\r\nContent-Type: ${options.mime ?? 'video/mp4'}\r\n\r\n`);
    const filePart = Buffer.concat([fileHeader, file, Buffer.from('\r\n')]);
    const extra = options.extra ? Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\n${options.extra}\r\n`) : Buffer.alloc(0);
    return { boundary, prefix: Buffer.concat([field, fileHeader]), ending: Buffer.from(`\r\n--${boundary}--\r\n`),
      payload: Buffer.concat([...(options.reverse ? [filePart, field] : [field, filePart]), extra, Buffer.from(`--${boundary}--\r\n`)]) };
  }
  const upload = (who: Actor, metadata: object = free, file = video, options: Parameters<typeof multipart>[2] = {}) => {
    const body = multipart(metadata, file, options);
    return app.inject({ method: 'POST', url: '/api/recordings', headers: { ...headers(who), 'content-type': `multipart/form-data; boundary=${body.boundary}` }, payload: body.payload });
  };
  async function files(who: Actor) {
    return readdir(join(root, 'objects', 'recordings', who.orgId, who.userId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
  }
  async function noArtifacts(who: Actor) {
    expect((await db.query('SELECT id FROM recordings WHERE org_id=$1 AND student_id=$2', [who.orgId, who.userId])).rowCount).toBe(0);
    expect(await files(who)).toEqual([]);
  }
  async function waitFor(check: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Condição observável não ocorreu no prazo do teste.');
  }
  async function httpUpload(who: Actor, metadata: object = free) {
    address ??= await app.listen({ host: '127.0.0.1', port: 0 });
    const body = multipart(metadata, Buffer.alloc(0));
    const request = httpRequest(new URL('/api/recordings', address), { method: 'POST', headers: { ...headers(who), 'content-type': `multipart/form-data; boundary=${body.boundary}` } });
    const response = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      request.on('error', reject);
      request.on('response', incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
        incoming.on('error', reject);
        incoming.on('end', () => resolve({ statusCode: incoming.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
      });
    });
    void response.catch(() => {});
    request.setTimeout(15_000, () => request.destroy(new Error('Upload de teste excedeu o prazo.')));
    request.write(body.prefix);
    return { request, response, ending: body.ending };
  }
  async function course(who: Actor, maximumSeconds = 30, acceptedMedia: ('audio' | 'video')[] = ['audio', 'video']) {
    const document: CourseDocument = { ...emptyCourse('Curso sintético'), modules: [{ id: 'module', title: 'Módulo', introductionMarkdown: 'Introdução', units: [{
      id: 'practice', title: 'Prática', chapter: 'Fundamentos', kind: 'lesson', mode: 'content', bodyMarkdown: 'Texto autoral.', instructionMarkdown: 'Descreva seu objetivo em uma frase.',
      checklist: ['Defini o objetivo.'], references: [], assetIds: [], prerequisites: [], studyCreditGrant: 1, requiresEvaluation: true,
      activity: { maximumSeconds, acceptedMedia, scenario: 'audience', criteria: [{ id: 'clarity', title: 'Clareza', enabled: true, weight: 1, modality: 'both', descriptors: ['Inicial', 'Parcial', 'Consistente', 'Flexível'] }] },
    }] }] };
    const courseId = randomUUID(), versionId = randomUUID(), enrollmentId = randomUUID();
    await db.query("INSERT INTO courses(id,org_id,title,status,draft) VALUES($1,$2,'Curso sintético','published',$3)", [courseId, who.orgId, document]);
    await db.query('INSERT INTO course_versions(id,org_id,course_id,version,document) VALUES($1,$2,$3,1,$4)', [versionId, who.orgId, courseId, document]);
    await db.query("INSERT INTO course_enrollments(id,org_id,course_id,version_id,student_id,source,source_ref) VALUES($1,$2,$3,$4,$5,'assignment','fixture')", [enrollmentId, who.orgId, courseId, versionId, who.userId]);
    return { courseId, versionId, enrollmentId, metadata: { purpose: 'course', source: 'upload', enrollmentId, unitId: 'practice' } satisfies UploadMetadata };
  }
  async function schoolFixture() {
    const admin = await actor('org_admin'), student = await actor('student', admin.orgId), manager = await actor('school', admin.orgId), teacher = await actor('teacher', admin.orgId);
    const schoolId = randomUUID(), classId = randomUUID();
    await db.query("INSERT INTO schools(id,org_id,name) VALUES($1,$2,'Escola')", [schoolId, admin.orgId]);
    await db.query("INSERT INTO classes(id,org_id,school_id,name) VALUES($1,$2,$3,'Turma')", [classId, admin.orgId, schoolId]);
    await db.query('INSERT INTO student_schools(org_id,school_id,student_id) VALUES($1,$2,$3)', [admin.orgId, schoolId, student.userId]);
    await db.query('INSERT INTO enrollments(org_id,school_id,class_id,student_id) VALUES($1,$2,$3,$4)', [admin.orgId, schoolId, classId, student.userId]);
    for (const [member, role] of [[manager, 'school'], [teacher, 'teacher']] as const) await db.query('INSERT INTO school_staff(org_id,school_id,user_id,role) VALUES($1,$2,$3,$4)', [admin.orgId, schoolId, member.userId, role]);
    await db.query("INSERT INTO teacher_profiles(org_id,user_id,approval_status) VALUES($1,$2,'approved')", [admin.orgId, teacher.userId]);
    await db.query('INSERT INTO teacher_class_assignments(org_id,school_id,class_id,teacher_id) VALUES($1,$2,$3,$4)', [admin.orgId, schoolId, classId, teacher.userId]);
    return { admin, student, manager, teacher, schoolId, classId };
  }

  it('persiste MP4 real com duração do servidor, objeto privado, auditoria e nenhum consumo', async () => {
    const student = await actor();
    const response = await upload(student, free, video, { filename: 'presentation.txt', mime: 'text/plain' });
    expect(response.statusCode).toBe(201);
    const recording = response.json().recording;
    expect(recording).toMatchObject({ studentId: student.userId, durationMicroseconds: 1_200_000, hasVideo: true, hasAudio: false,
      byteLength: video.length, mimeType: expect.stringMatching(/^video\/mp4(?:;|$)/), estimatedCredits: 1, purpose: 'free', scenario: 'executive', maximumSeconds: 300 });
    expect(recording).not.toHaveProperty('object_key'); expect(recording).not.toHaveProperty('probe');
    const row = (await db.query('SELECT object_key FROM recordings WHERE id=$1', [recording.id])).rows[0];
    expect(await readFile(app.storage.path(row.object_key))).toEqual(video);
    expect((await stat(app.storage.path(row.object_key))).mode & 0o777).toBe(0o600);
    expect((await db.query("SELECT id FROM audit_events WHERE org_id=$1 AND event_type='recording_uploaded'", [student.orgId])).rowCount).toBe(1);
    expect((await db.query('SELECT id FROM credit_reservations WHERE org_id=$1', [student.orgId])).rowCount).toBe(0);
    expect((await db.query('SELECT user_id FROM wallets WHERE org_id=$1', [student.orgId])).rowCount).toBe(0);
  });

  it('aceita captura Chromium MediaRecorder e áudio puro com metadados reais', async () => {
    const student = await actor();
    const captured = await upload(student, { ...free, source: 'capture' }, capture, { filename: 'capture.webm', mime: 'video/webm' });
    expect(captured.statusCode).toBe(201);
    expect(captured.json().recording).toMatchObject({ source: 'capture', mimeType: expect.stringMatching(/^video\/webm(?:;|$)/), hasVideo: true });
    expect(captured.json().recording.durationMicroseconds).toBeGreaterThan(1_000_000);
    expect(captured.json().recording.durationMicroseconds).toBeLessThan(1_300_000);
    const wave = await upload(student, free, audio, { filename: 'audio.wav', mime: 'audio/wav' });
    expect(wave.statusCode).toBe(201);
    expect(wave.json().recording).toMatchObject({ durationMicroseconds: 1_250_000, hasAudio: true, hasVideo: false });
  });

  it('informa limites para livre e diagnóstico, sem depender de saldo ou curso', async () => {
    const student = await actor();
    expect((await get(student, '/api/recordings/options?purpose=free')).json().constraints).toEqual({ maximumBytes: 209_715_200, maximumSeconds: 300, acceptedMedia: ['audio', 'video'] });
    expect((await get(student, '/api/recordings/options?purpose=diagnostic')).json().constraints.maximumSeconds).toBe(30);
    const diagnostic = await upload(student, { purpose: 'diagnostic', source: 'capture' }, video);
    expect(diagnostic.statusCode).toBe(201);
    expect(diagnostic.json().recording.objective.length).toBeGreaterThan(0);
    expect((await upload(student, { purpose: 'free', source: 'upload' })).statusCode).toBe(400);
  });

  it('permite cinco minutos exatos e rejeita a fração seguinte sem deixar arquivo', async () => {
    const valid = await actor(), invalid = await actor();
    const response = await upload(valid, free, fiveMinutes);
    expect(response.statusCode).toBe(201);
    expect(response.json().recording).toMatchObject({ durationMicroseconds: 300_000_000, estimatedCredits: 5 });
    expect((await upload(invalid, free, tooLong)).statusCode).toBe(422);
    await noArtifacts(invalid);
  });

  it('diagnóstico rejeita primeiro milissegundo acima de trinta segundos', async () => {
    const student = await actor();
    expect((await upload(student, { purpose: 'diagnostic', source: 'upload' }, longAudio)).statusCode).toBe(422);
    await noArtifacts(student);
  });

  it.each(['truncated', 'unsupported', 'empty'] as const)('limpa objeto e registro ao rejeitar mídia %s', async kind => {
    const student = await actor();
    const file = kind === 'truncated' ? video.subarray(0, Math.floor(video.length * 0.7)) : kind === 'empty' ? Buffer.alloc(0) : Buffer.from('This is not a recording.');
    expect((await upload(student, free, file)).statusCode).toBe(kind === 'unsupported' ? 415 : 400);
    await noArtifacts(student);
  });

  it('rejeita campos de autoridade, metadata fora de ordem e partes extras', async () => {
    const student = await actor();
    for (const metadata of [{ ...free, orgId: randomUUID() }, { ...free, studentId: randomUUID() }, { ...free, durationMicroseconds: 1 }, { ...free, maximumSeconds: 999 }]) {
      expect((await upload(student, metadata)).statusCode).toBe(400);
    }
    expect((await upload(student, free, video, { reverse: true })).statusCode).toBe(400);
    expect((await upload(student, free, video, { extra: 'unexpected' })).statusCode).toBeGreaterThanOrEqual(400);
    await noArtifacts(student);
  });

  it('usa matrícula, versão, objetivo e cenário do curso atribuído', async () => {
    const student = await actor(), context = await course(student);
    const options = await get(student, `/api/recordings/options?purpose=course&enrollmentId=${context.enrollmentId}&unitId=practice`);
    expect(options.statusCode).toBe(200);
    expect(options.json()).toMatchObject({ constraints: { maximumSeconds: 30 }, scenario: 'audience', unit: { id: 'practice' } });
    const response = await upload(student, { ...context.metadata, scenario: 'executive' });
    expect(response.statusCode).toBe(201);
    expect(response.json().recording).toMatchObject({ enrollmentId: context.enrollmentId, versionId: context.versionId, unitId: 'practice', maximumSeconds: 30,
      scenario: 'audience', objective: 'Descreva seu objetivo em uma frase.' });
    const other = await actor('student', student.orgId);
    expect((await upload(other, context.metadata)).statusCode).toBe(404);
    expect((await upload(student, { ...context.metadata, unitId: 'missing' })).statusCode).toBe(404);
  });

  it('curso rejeita modalidade não publicada e duração acima do limite', async () => {
    const student = await actor(), context = await course(student, 30, ['audio']);
    expect((await upload(student, context.metadata, video)).statusCode).toBe(415);
    expect((await upload(student, context.metadata, longAudio)).statusCode).toBe(422);
    await noArtifacts(student);
    expect((await upload(student, context.metadata, audio)).statusCode).toBe(201);
  });

  it('flags de curso e diagnóstico bloqueiam essas jornadas, preservando upload livre', async () => {
    const student = await actor(), context = await course(student);
    await db.query('UPDATE orgs SET settings=$2 WHERE id=$1', [student.orgId, { coursesEnabled: false, diagnosticEnabled: false }]);
    expect((await get(student, '/api/recordings/options?purpose=diagnostic')).statusCode).toBe(403);
    expect((await upload(student, { purpose: 'diagnostic', source: 'upload' })).statusCode).toBe(403);
    expect((await upload(student, context.metadata)).statusCode).toBe(403);
    expect((await upload(student, free)).statusCode).toBe(201);
  });

  it('matrícula cancelada revoga novo upload; conclusão conserva o curso atribuído', async () => {
    const student = await actor(), context = await course(student);
    await db.query("UPDATE course_enrollments SET status='cancelled' WHERE id=$1", [context.enrollmentId]);
    expect((await upload(student, context.metadata)).statusCode).toBe(404);
    await db.query("UPDATE course_enrollments SET status='completed',completed_at=now() WHERE id=$1", [context.enrollmentId]);
    expect((await upload(student, context.metadata)).statusCode).toBe(201);
  });

  it('lista com paginação e filtro apenas os registros do aluno autorizado', async () => {
    const student = await actor(), other = await actor('student', student.orgId);
    await upload(student); await upload(student, { purpose: 'diagnostic', source: 'upload' }); await upload(other);
    const list = await get(student, '/api/recordings?page=1&pageSize=1');
    expect(list.json()).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(list.json().items).toHaveLength(1);
    expect((await get(student, '/api/recordings?purpose=diagnostic')).json().total).toBe(1);
    expect((await get(student, `/api/recordings?studentId=${other.userId}`)).statusCode).toBe(403);
  });

  it('protege metadados, mídia e ranges do mesmo escopo autenticado', async () => {
    const student = await actor(), other = await actor('student', student.orgId), foreign = await actor();
    const id = (await upload(student)).json().recording.id;
    const range = await get(student, `/api/recordings/${id}/media`, { range: 'bytes=0-15' });
    expect(range.statusCode).toBe(206); expect(range.rawPayload).toEqual(video.subarray(0, 16));
    expect(range.headers['content-range']).toBe(`bytes 0-15/${video.length}`);
    expect(range.headers['x-content-type-options']).toBe('nosniff');
    expect((await get(student, `/api/recordings/${id}/media`, { range: 'bytes=-8' })).rawPayload).toEqual(video.subarray(-8));
    expect((await get(student, `/api/recordings/${id}/media`, { range: 'bytes=9999999-' })).statusCode).toBe(416);
    expect((await get(student, `/api/recordings/${id}/media`, { range: 'bytes=0-1,4-5' })).statusCode).toBe(416);
    for (const path of [`/api/recordings/${id}`, `/api/recordings/${id}/media`]) {
      expect((await get(other, path)).statusCode).toBe(403);
      expect((await get(foreign, path)).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: path, headers: { host: student.host } })).statusCode).toBe(401);
    }
  });

  it('professor precisa de aprovação e turma; gestor perde a mídia após transferência', async () => {
    const fixture = await schoolFixture(), unassigned = await actor('teacher', fixture.admin.orgId);
    const id = (await upload(fixture.student)).json().recording.id;
    for (const who of [fixture.teacher, fixture.manager, fixture.admin]) expect((await get(who, `/api/recordings/${id}/media`)).statusCode).toBe(200);
    expect((await get(unassigned, `/api/recordings/${id}/media`)).statusCode).toBe(403);
    await db.query("UPDATE teacher_profiles SET approval_status='suspended' WHERE user_id=$1", [fixture.teacher.userId]);
    expect((await get(fixture.teacher, `/api/recordings/${id}/media`)).statusCode).toBe(403);
    await db.query("UPDATE teacher_profiles SET approval_status='approved' WHERE user_id=$1", [fixture.teacher.userId]);
    const targetSchool = randomUUID();
    await db.query("INSERT INTO schools(id,org_id,name) VALUES($1,$2,'Destino')", [targetSchool, fixture.admin.orgId]);
    expect((await json(fixture.admin, `/api/education/students/${fixture.student.userId}/transfer`, { schoolId: targetSchool })).statusCode).toBe(200);
    for (const who of [fixture.teacher, fixture.manager]) {
      expect((await get(who, `/api/recordings/${id}`)).statusCode).toBe(403);
      expect((await get(who, `/api/recordings/${id}/media`)).statusCode).toBe(403);
      expect((await get(who, `/api/recordings?studentId=${fixture.student.userId}`)).statusCode).toBe(403);
    }
    expect((await get(fixture.student, `/api/recordings/${id}/media`)).statusCode).toBe(200);
  });

  it('professor e operador não enviam gravação em nome do aluno', async () => {
    const teacher = await actor('teacher'), operator = await actor('operator', randomUUID(), 'backoffice');
    for (const who of [teacher, operator]) expect((await upload(who)).statusCode).toBe(403);
  });

  it('banco rejeita vínculo da gravação com matrícula ou versão de outro aluno', async () => {
    const first = await actor(), second = await actor('student', first.orgId), one = await course(first), two = await course(second);
    const id = (await upload(first, one.metadata)).json().recording.id;
    await expect(db.query('UPDATE recordings SET enrollment_id=$2,version_id=$3 WHERE id=$1', [id, two.enrollmentId, two.versionId])).rejects.toMatchObject({ code: '23503' });
    expect((await get(first, `/api/recordings/${id}`)).json().recording.enrollmentId).toBe(one.enrollmentId);
  });

  it('reinício da aplicação preserva metadados e arquivo reproduzível', async () => {
    const student = await actor(), id = (await upload(student)).json().recording.id;
    await app.close(); app = await createApp({ databaseUrl, storageRoot: join(root, 'objects') });
    expect((await get(student, `/api/recordings/${id}`)).json().recording.durationMicroseconds).toBe(1_200_000);
    expect((await get(student, `/api/recordings/${id}/media`)).rawPayload).toEqual(video);
  });

  it('finalização enfileirada revalida a política de cursos depois do lock', async () => {
    const student = await actor(), context = await course(student), blocker = await db.pool.connect();
    let pending: ReturnType<typeof upload> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [student.orgId]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = upload(student, context.metadata);
      await waitFor(async () => (await control.query<{ queued: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM pg_locks held JOIN pg_locks waiting ON held.locktype=waiting.locktype
          AND held.database IS NOT DISTINCT FROM waiting.database AND held.classid=waiting.classid
          AND held.objid=waiting.objid AND held.objsubid=waiting.objsubid
        WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted AND NOT waiting.granted
      ) AS queued`, [pid])).rows[0].queued);
      expect((await files(student)).some(name => !name.endsWith('.tmp'))).toBe(true);
      await blocker.query('UPDATE orgs SET settings=$2 WHERE id=$1', [student.orgId, { coursesEnabled: false }]);
      await blocker.query('COMMIT');
      expect((await pending).statusCode).toBe(403);
      await noArtifacts(student);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release(); await pending;
    }
  });

  it.each(['logout', 'suspend', 'role', 'diagnostic', 'enrollment'] as const)('revalida %s após receber arquivo e limpa objeto em caso de revogação', async cause => {
    const student = await actor();
    const context = cause === 'enrollment' ? await course(student) : undefined;
    const metadata = context?.metadata ?? (cause === 'diagnostic' ? { purpose: 'diagnostic', source: 'upload' } : free);
    const pending = await httpUpload(student, metadata);
    try {
      const half = Math.floor(video.length / 2);
      pending.request.write(video.subarray(0, half));
      await waitFor(async () => (await files(student)).some(name => name.endsWith('.tmp')));
      if (cause === 'logout') expect((await json(student, '/api/auth/logout', {})).statusCode).toBe(204);
      else if (cause === 'suspend') await db.query("UPDATE users SET status='suspended' WHERE id=$1", [student.userId]);
      else if (cause === 'role') await db.query("UPDATE users SET roles=ARRAY['teacher'] WHERE id=$1", [student.userId]);
      else if (cause === 'diagnostic') await db.query('UPDATE orgs SET settings=$2 WHERE id=$1', [student.orgId, { diagnosticEnabled: false }]);
      else await db.query("UPDATE course_enrollments SET status='cancelled' WHERE id=$1", [context!.enrollmentId]);
      pending.request.end(Buffer.concat([video.subarray(half), pending.ending]));
      const response = await pending.response;
      expect(response.statusCode).toBe(cause === 'logout' || cause === 'suspend' ? 401 : cause === 'enrollment' ? 404 : 403);
      await noArtifacts(student);
    } finally { pending.request.destroy(); }
  });

  it('interrupção real do cliente remove o arquivo temporário e não cria registro', async () => {
    const student = await actor(), pending = await httpUpload(student);
    pending.request.write(video.subarray(0, Math.floor(video.length / 2)));
    await waitFor(async () => (await files(student)).some(name => name.endsWith('.tmp')));
    pending.request.destroy();
    await pending.response.catch(() => {});
    await waitFor(async () => (await files(student)).length === 0);
    await noArtifacts(student);
  });

  it('limite real de 200 MiB rejeita o primeiro byte excedente e limpa o arquivo', async () => {
    const student = await actor(), pending = await httpUpload(student);
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      for (let index = 0; index < 200; index++) {
        if (!pending.request.write(chunk)) await once(pending.request, 'drain');
      }
      pending.request.end(Buffer.concat([Buffer.from([0]), pending.ending]));
      expect((await pending.response).statusCode).toBe(413);
      await noArtifacts(student);
    } finally { pending.request.destroy(); }
  }, 20_000);
});
