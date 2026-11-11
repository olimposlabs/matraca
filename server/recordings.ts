import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireIdentity, type AuthIdentity, type IdentityRole } from './auth.js';
import { localHostname } from './config.js';
import type { CourseDocument, CourseUnit } from './course-model.js';
import { streamPrivateFile } from './http-media.js';
import { probeMedia, MediaProbeError, type MediaProbeResult } from './media/probe.js';
import { assertStudentScope, type EducationQuery } from './permissions.js';
import { creditsForDuration } from './wallet.js';

const maximumBytes = 200 * 1024 * 1024;
const purpose = z.enum(['free', 'diagnostic', 'course']);
const scenario = z.enum(['one_on_one', 'executive', 'audience']);
const unitId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const contextFields = { purpose, enrollmentId: z.uuid().optional(), unitId: unitId.optional() };
const contextQuery = z.object(contextFields).strict();
const metadataSchema = z.object({
  ...contextFields,
  objective: z.string().trim().min(1).max(2000).optional(),
  scenario: scenario.optional(),
  source: z.enum(['upload', 'capture']),
}).strict();
const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  studentId: z.uuid().optional(), purpose: purpose.optional(),
}).strict();
type UploadMetadata = z.infer<typeof metadataSchema>;
interface CaptureContext {
  constraints: { maximumBytes: number; maximumSeconds: number; acceptedMedia: ('audio' | 'video')[] };
  scenario: z.infer<typeof scenario>;
  unit: { id: string; title: string } | null;
  enrollmentId: string | null;
  versionId: string | null;
  defaultObjective: string;
}
export interface StoredRecording {
  id: string; org_id: string; student_id: string; object_key: string; filename: string;
  mime_type: string; byte_length: string; duration_us: string; has_audio: boolean; has_video: boolean;
  container: 'mp4' | 'webm' | 'wav' | 'mp3'; probe: MediaProbeResult;
  objective: string; purpose: 'free' | 'diagnostic' | 'course'; enrollment_id: string | null;
  version_id: string | null; unit_id: string | null; scenario: z.infer<typeof scenario>;
  maximum_seconds: number; source: 'upload' | 'capture'; created_at: Date;
}
export class RecordingError extends Error {
  constructor(public readonly statusCode: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422, message: string) {
    super(message); this.name = 'RecordingError';
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RecordingError(400, 'Confira o objetivo, a atividade e os campos da gravação.');
  return result.data;
}
function recordingId(request: FastifyRequest): string {
  return parse(z.object({ id: z.uuid() }).strict(), request.params).id;
}
export function publicRecording(row: StoredRecording) {
  return {
    id: row.id, studentId: row.student_id, filename: row.filename, mimeType: row.mime_type,
    byteLength: Number(row.byte_length), durationMicroseconds: Number(row.duration_us),
    hasAudio: row.has_audio, hasVideo: row.has_video, objective: row.objective, purpose: row.purpose,
    enrollmentId: row.enrollment_id, versionId: row.version_id, unitId: row.unit_id,
    scenario: row.scenario, maximumSeconds: row.maximum_seconds, source: row.source, createdAt: row.created_at,
    estimatedCredits: creditsForDuration(Number(row.duration_us)),
  };
}

/** Internal lookup: callers must authorize the student's current scope separately. */
export async function loadRecording(client: EducationQuery, orgId: string, id: string): Promise<StoredRecording> {
  const row = (await client.query<StoredRecording>('SELECT * FROM recordings WHERE org_id=$1 AND id=$2', [orgId, id])).rows[0];
  if (!row) throw new RecordingError(404, 'Gravação não encontrada.');
  return row;
}
/** Same scope as reports and mentoring; transfer immediately revokes the former school/teacher. */
export async function requireRecordingScope(request: FastifyRequest, id: string) {
  const actor = await requireIdentity(request, ['student', 'teacher', 'school', 'org_admin']);
  const recording = await loadRecording(request.server.db, actor.org.id, id);
  await assertStudentScope(request.server.db, actor, recording.student_id);
  return { actor, recording };
}

async function captureContext(client: EducationQuery, actor: AuthIdentity, input: z.infer<typeof contextQuery>): Promise<CaptureContext> {
  const org = (await client.query<{ settings: Record<string, unknown> }>('SELECT settings FROM orgs WHERE id=$1', [actor.org.id])).rows[0];
  if (input.purpose === 'diagnostic' && org?.settings.diagnosticEnabled === false) {
    throw new RecordingError(403, 'O diagnóstico está desativado nesta organização.');
  }
  if (input.purpose !== 'course') {
    if (input.enrollmentId || input.unitId) throw new RecordingError(400, 'Uma gravação livre ou diagnóstica não recebe atividade de curso.');
    return {
      constraints: { maximumBytes, maximumSeconds: input.purpose === 'diagnostic' ? 30 : 300, acceptedMedia: ['audio', 'video'] },
      scenario: 'one_on_one', unit: null, enrollmentId: null, versionId: null,
      defaultObjective: input.purpose === 'diagnostic' ? 'Avaliar minha comunicação inicial.' : '',
    };
  }
  if (!input.enrollmentId || !input.unitId) throw new RecordingError(400, 'Selecione a matrícula e a unidade do curso.');
  if (org?.settings.coursesEnabled === false) throw new RecordingError(403, 'As atividades de curso estão desativadas nesta organização.');
  const enrolled = (await client.query<{ id: string; version_id: string; document: CourseDocument }>(
    `SELECT e.id,e.version_id,v.document FROM course_enrollments e
     JOIN course_versions v ON v.id=e.version_id AND v.org_id=e.org_id
     WHERE e.org_id=$1 AND e.student_id=$2 AND e.id=$3 AND e.status IN ('active','completed')`,
    [actor.org.id, actor.user.id, input.enrollmentId],
  )).rows[0];
  if (!enrolled) throw new RecordingError(404, 'Matrícula disponível não encontrada.');
  const unit: CourseUnit | undefined = enrolled.document.modules.flatMap(module => module.units).find(unit => unit.id === input.unitId);
  if (!unit) throw new RecordingError(404, 'Unidade não encontrada na sua versão do curso.');
  return {
    constraints: { maximumBytes, maximumSeconds: unit.activity.maximumSeconds, acceptedMedia: unit.activity.acceptedMedia },
    scenario: unit.activity.scenario, unit: { id: unit.id, title: unit.title },
    enrollmentId: enrolled.id, versionId: enrolled.version_id, defaultObjective: unit.instructionMarkdown.slice(0, 2000),
  };
}

async function revalidateUploader(client: PoolClient, request: FastifyRequest, actor: AuthIdentity): Promise<AuthIdentity> {
  const row = (await client.query<{ roles: IdentityRole[] }>(
    `SELECT u.roles FROM sessions s JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id
     JOIN orgs o ON o.id=s.org_id JOIN domains d ON d.hostname=s.hostname AND d.org_id=s.org_id
     WHERE s.token_hash=$1 AND s.hostname=$2 AND s.org_id=$3 AND s.user_id=$4
       AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
       AND u.status='active' AND u.archived_at IS NULL AND o.status='active' FOR SHARE OF u,o`,
    [createHash('sha256').update(request.cookies.matraca_session ?? '').digest('hex'), localHostname(request.headers.host), actor.org.id, actor.user.id],
  )).rows[0];
  if (!row) throw new RecordingError(401, 'A sessão foi encerrada durante o envio.');
  if (!row.roles.includes('student') || row.roles.includes('operator')) throw new RecordingError(403, 'Somente o aluno pode enviar sua gravação.');
  return { ...actor, user: { ...actor.user, roles: row.roles } };
}
function validateProbe(media: MediaProbeResult, context: CaptureContext): void {
  if (media.durationMicroseconds > context.constraints.maximumSeconds * 1_000_000) {
    throw new RecordingError(422, `A gravação ultrapassa o limite de ${context.constraints.maximumSeconds} segundos desta atividade.`);
  }
  const modality = media.hasVideo ? 'video' : 'audio';
  if (!context.constraints.acceptedMedia.includes(modality)) throw new RecordingError(415, 'Esta atividade não aceita o tipo de mídia enviado.');
}
function cleanFilename(value: string): string {
  return [...value].map(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || '/\\'.includes(character) ? '_' : character).slice(0, 180).join('') || 'gravacao';
}

export async function registerRecordings(app: FastifyInstance): Promise<void> {
  app.get('/api/recordings/options', async request => {
    const actor = await requireIdentity(request, ['student']);
    const context = await captureContext(app.db, actor, parse(contextQuery, request.query));
    return { constraints: context.constraints, scenario: context.scenario, unit: context.unit };
  });

  app.post('/api/recordings', async (request, reply) => {
    const actor = await requireIdentity(request, ['student']);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const responseClosed = () => { if (!reply.raw.writableEnded) abort(); };
    request.raw.once('aborted', abort); reply.raw.once('close', responseClosed);
    const id = randomUUID(), key = `recordings/${actor.org.id}/${actor.user.id}/${id}`;
    let metadata: UploadMetadata | undefined, initial: CaptureContext | undefined;
    let filename = '', uploaded = false, persisted = false;
    try {
      for await (const part of request.parts({ limits: { fileSize: maximumBytes, fieldSize: 16_384, files: 1, fields: 1, parts: 2 } })) {
        if (part.type === 'field') {
          if (part.fieldname !== 'metadata' || metadata || uploaded || part.valueTruncated || typeof part.value !== 'string') {
            throw new RecordingError(400, 'Envie os dados da gravação antes do arquivo.');
          }
          let value: unknown;
          try { value = JSON.parse(part.value); } catch { throw new RecordingError(400, 'Dados da gravação inválidos.'); }
          metadata = parse(metadataSchema, value);
          initial = await captureContext(app.db, actor, metadata);
          if (metadata.purpose === 'free' && !metadata.objective) throw new RecordingError(400, 'Descreva o objetivo da sua gravação livre.');
          continue;
        }
        if (part.fieldname !== 'file' || !metadata || !initial || uploaded) throw new RecordingError(400, 'Envie metadata e depois um único arquivo file.');
        filename = cleanFilename(part.filename);
        const information = await app.storage.put(key, part.file);
        uploaded = true;
        if (part.file.truncated || information.size > maximumBytes) throw new RecordingError(413, 'O arquivo deve ter até 200 MB.');
        if (!information.size) throw new RecordingError(400, 'O arquivo está vazio.');
      }
      if (!uploaded || !metadata || !initial) throw new RecordingError(400, 'Selecione uma gravação para enviar.');
      const media = await probeMedia(app.storage.path(key), {
        maxBytes: maximumBytes, maxDurationSeconds: initial.constraints.maximumSeconds,
        maxPackets: 1_000_000, signal: controller.signal,
      });
      validateProbe(media, initial);
      const input = metadata;
      const recording = await app.db.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [actor.org.id]);
        const currentActor = await revalidateUploader(client, request, actor);
        const context = await captureContext(client, currentActor, input);
        validateProbe(media, context);
        if (controller.signal.aborted) throw new RecordingError(400, 'O envio foi interrompido.');
        const result = await client.query<StoredRecording>(
          `INSERT INTO recordings(id,org_id,student_id,object_key,filename,mime_type,byte_length,duration_us,
           has_audio,has_video,container,probe,objective,purpose,enrollment_id,version_id,unit_id,scenario,maximum_seconds,source)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
          [id, actor.org.id, actor.user.id, key, filename, media.mimeType, media.byteLength, media.durationMicroseconds,
            media.hasAudio, media.hasVideo, media.container, media, input.objective ?? context.defaultObjective, input.purpose,
            context.enrollmentId, context.versionId, context.unit?.id ?? null, input.purpose === 'course' ? context.scenario : input.scenario ?? context.scenario,
            context.constraints.maximumSeconds, input.source],
        );
        await client.query('INSERT INTO audit_events(org_id,actor_user_id,event_type,metadata) VALUES($1,$2,$3,$4)',
          [actor.org.id, actor.user.id, 'recording_uploaded', { recordingId: id, purpose: input.purpose }]);
        return result.rows[0];
      });
      persisted = true;
      return reply.code(201).send({ recording: publicRecording(recording) });
    } catch (error) {
      if (uploaded && !persisted) await app.storage.remove(key).catch(() => {});
      if (error instanceof MediaProbeError) {
        if (error.code === 'UNSUPPORTED_MEDIA') throw new RecordingError(415, 'Envie uma gravação MP4, WebM, WAV ou MP3 válida.');
        if (error.code === 'LIMIT_EXCEEDED') throw new RecordingError(422, 'A gravação ultrapassa os limites de duração ou complexidade da atividade.');
        throw new RecordingError(400, error.code === 'ABORTED' ? 'O envio foi interrompido ou excedeu o tempo de validação.' : 'A gravação está incompleta ou não pode ser lida.');
      }
      throw error;
    } finally {
      request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', responseClosed);
    }
  });

  app.get('/api/recordings', async request => {
    const actor = await requireIdentity(request, ['student', 'teacher', 'school', 'org_admin']);
    const query = parse(listQuery, request.query);
    if (!query.studentId && !actor.user.roles.includes('student')) throw new RecordingError(400, 'Selecione o aluno para consultar suas gravações.');
    const studentId = query.studentId ?? actor.user.id;
    await assertStudentScope(app.db, actor, studentId);
    const values: unknown[] = [actor.org.id, studentId, query.purpose ?? null];
    const where = 'org_id=$1 AND student_id=$2 AND ($3::text IS NULL OR purpose=$3)';
    const total = (await app.db.query<{ total: number }>(`SELECT count(*)::integer AS total FROM recordings WHERE ${where}`, values)).rows[0].total;
    const items = await app.db.query<StoredRecording>(`SELECT * FROM recordings WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`,
      [...values, query.pageSize, (query.page - 1) * query.pageSize]);
    return { items: items.rows.map(publicRecording), total, page: query.page, pageSize: query.pageSize };
  });
  app.get('/api/recordings/:id', async request => {
    const { recording } = await requireRecordingScope(request, recordingId(request));
    return { recording: publicRecording(recording) };
  });
  app.get('/api/recordings/:id/media', async (request, reply) => {
    const { recording } = await requireRecordingScope(request, recordingId(request));
    return streamPrivateFile(request, reply, app.storage, {
      key: recording.object_key, size: Number(recording.byte_length), mimeType: recording.mime_type, filename: recording.filename,
    });
  });
}
