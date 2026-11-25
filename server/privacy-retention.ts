import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { mailboxRoot } from './auth.js';
import type { Database } from './db.js';
import { cancelEvaluationInTransaction } from './evaluation/worker.js';
import { subjectOfSensitiveEvent } from './sensitive-access.js';
import type { LocalStorage } from './storage.js';

export type PrivacyScope = { orgId?: string; studentId?: string };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const day = 24 * 60 * 60 * 1000;
const scopeSql = '(($1::uuid IS NULL OR org_id=$1) AND ($2::uuid IS NULL OR student_id=$2))';
const userScopeSql = 'org_id=$1 AND ($2::uuid IS NULL OR id=$2)';
const activeRequest = "status IN ('queued','processing')";
const reportAge = "($1::uuid IS NOT NULL OR created_at<=now()-interval '365 days')";
const filters = (scope: PrivacyScope) => [scope.orgId ?? null, scope.studentId ?? null];

async function scanMailbox(storage: LocalStorage, scope: PrivacyScope, targetEmail: string | undefined, now: number) {
  const root = mailboxRoot(storage.root);
  const directories = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const selected: string[] = [];
  for (const dir of directories) {
    if (!dir.isDirectory() || !uuid.test(dir.name) || (scope.orgId && dir.name !== scope.orgId)) continue;
    const folder = join(root, dir.name);
    for (const file of await readdir(folder, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json') || !uuid.test(file.name.slice(0, -5))) continue;
      const path = join(folder, file.name);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ELOOP') return null;
        throw error;
      });
      if (!handle) continue;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 64 * 1024) continue;
        const raw = await handle.readFile('utf8');
        let metadata: { expiresAt?: string; to?: string; orgId?: string; userId?: string } | null;
        try { metadata = JSON.parse(raw); } catch { continue; }
        if (metadata?.orgId !== dir.name) continue;
        const expired = typeof metadata.expiresAt === 'string' && Date.parse(metadata.expiresAt) <= now - day;
        const recipient = metadata.userId ? metadata.userId === scope.studentId : metadata.to === targetEmail;
        if (scope.studentId ? recipient : scope.orgId || expired) selected.push(path);
      } finally { await handle.close(); }
    }
  }
  return selected.sort();
}

type Target = { id: string; email: string };
async function targets(client: PoolClient, scope: PrivacyScope) {
  if (!scope.orgId) return [];
  const org = await client.query("SELECT id FROM orgs WHERE id=$1 AND kind<>'backoffice'", [scope.orgId]);
  if (!org.rowCount) throw new Error('Organização disponível para limpeza não encontrada.');
  const users = (await client.query<Target>(`SELECT id,email FROM users WHERE ${userScopeSql}
    AND ($2::uuid IS NULL OR 'student'=ANY(roles)) ORDER BY id`, filters(scope))).rows;
  if (scope.studentId && !users.length) throw new Error('Aluno não encontrado nesta organização.');
  return users;
}

function validateScope(scope: PrivacyScope) {
  if ((scope.orgId && !uuid.test(scope.orgId)) || (scope.studentId && (!scope.orgId || !uuid.test(scope.studentId)))) {
    throw new Error('Informe os identificadores da organização e, se aplicável, do aluno.');
  }
}

async function snapshot(client: PoolClient, storage: LocalStorage, scope: PrivacyScope) {
  const users = await targets(client, scope);
  const namespace = (await client.query<{ database: string; schema: string; time: Date }>(
    'SELECT current_database() AS database,current_schema() AS schema,now() AS time',
  )).rows[0];
  const files = await scanMailbox(storage, scope, scope.studentId ? users[0].email : undefined, Number(namespace.time));
  const parameters = filters(scope);
  const ids = async (statement: string, values: unknown[] = parameters) =>
    (await client.query<{ id: string }>(statement, values)).rows.map(row => row.id);
  const media = await ids(`SELECT id FROM recordings WHERE media_removed_at IS NULL AND ${scopeSql}
    AND ($1::uuid IS NOT NULL OR created_at<=now()-interval '30 days')
    AND ($1::uuid IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM evaluation_requests WHERE recording_id=recordings.id AND ${activeRequest}
    )) ORDER BY id`);
  const reports = await ids(`SELECT request_id AS id FROM evaluation_results
    WHERE report_removed_at IS NULL AND ${scopeSql} AND ${reportAge} ORDER BY request_id`);
  const pending = scope.orgId ? (await client.query<{ id: string; org_id: string; student_id: string }>(
    `SELECT id,org_id,student_id FROM evaluation_requests WHERE ${scopeSql} AND ${activeRequest} ORDER BY id`, parameters,
  )).rows : [];
  const contexts = await ids(`SELECT id FROM evaluation_requests
    WHERE ${scopeSql} AND (${reportAge} OR id=ANY($3::uuid[])) AND context<>'{}'
      AND ($1::uuid IS NOT NULL OR NOT (${activeRequest}))
      AND NOT EXISTS (SELECT 1 FROM evaluation_results f WHERE f.request_id=evaluation_requests.id
        AND f.report_removed_at IS NULL AND NOT (f.request_id=ANY($3::uuid[])))
    ORDER BY id`, [...parameters, reports]);
  const metadata = await ids(`SELECT id FROM recordings WHERE ${scopeSql} AND ${reportAge}
    AND (media_removed_at IS NOT NULL OR id=ANY($3::uuid[]))
    AND (filename<>'midia-removida' OR objective<>'Conteúdo removido' OR probe<>'{}') ORDER BY id`, [...parameters, media]);
  const tokens = await ids(`SELECT id FROM auth_tokens WHERE ($1::uuid IS NOT NULL OR expires_at<=now()-interval '24 hours')
    AND ($1::uuid IS NULL OR org_id=$1) AND ($2::uuid IS NULL OR user_id=$2) ORDER BY id`);
  const sessions = scope.orgId
    ? await ids('SELECT id FROM sessions WHERE org_id=$1 AND ($2::uuid IS NULL OR user_id=$2) ORDER BY id') : [];
  const access = await ids(`SELECT id::text AS id FROM sensitive_access_events a
    WHERE ($1::uuid IS NOT NULL OR occurred_at<=now()-interval '90 days') AND ($1::uuid IS NULL OR a.org_id=$1)
      AND ($2::uuid IS NULL OR a.actor_id=$2 OR (${subjectOfSensitiveEvent})=$2)
    ORDER BY id`);
  const mentoring = await ids(`SELECT id FROM mentoring_sessions WHERE ${scopeSql} AND ${reportAge}
    AND (guidance<>'Conteúdo removido' OR difficulties<>'[]' OR actions<>'[]') ORDER BY id`);
  const reviews = await ids(`SELECT id FROM human_reviews WHERE ${scopeSql} AND ${reportAge}
    AND (summary<>'Conteúdo removido' OR observations<>'[]') ORDER BY id`);
  const plans = await ids(`SELECT id FROM individual_plan_items WHERE ${scopeSql} AND ${reportAge}
    AND (title<>'Conteúdo removido' OR description<>'') ORDER BY id`);
  const history = await ids(`SELECT item_id::text||':'||revision AS id FROM individual_plan_history
    WHERE ${scopeSql} AND ${reportAge}
      AND (response<>'' OR snapshot->>'title' IS DISTINCT FROM 'Conteúdo removido' OR snapshot->>'description' IS DISTINCT FROM '')
    ORDER BY id`);
  const selection = { media, reports, files, pending, contexts, metadata, tokens, sessions, access, mentoring, reviews, plans, history };
  const fingerprint = createHash('sha256').update(JSON.stringify([
    namespace.database, namespace.schema, storage.root, scope.orgId, scope.studentId, users, selection,
  ])).digest('hex');
  return {
    ...selection, userIds: users.map(user => user.id),
    preview: {
      fingerprint, accounts: users.length, recordings: media.length, reports: reports.length, mailboxFiles: files.length,
      pendingRequests: pending.length, contexts: contexts.length, recordingMetadata: metadata.length,
      authTokens: tokens.length, sessions: sessions.length, accessEvents: access.length,
      mentoringSessions: mentoring.length, humanReviews: reviews.length, planItems: plans.length, planHistory: history.length,
    },
  };
}

export async function privacyPlan(db: Database, storage: LocalStorage, scope: PrivacyScope) {
  validateScope(scope);
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return (await snapshot(client, storage, scope)).preview;
  });
}

type PrivacyManifest = Awaited<ReturnType<typeof snapshot>>;
async function redactMentoring(client: PoolClient, manifest: PrivacyManifest) {
  await client.query("SELECT set_config('matraca.privacy_maintenance','on',true)");
  await client.query(`UPDATE mentoring_sessions SET guidance='Conteúdo removido', difficulties='[]', actions='[]'
    WHERE id=ANY($1::uuid[])`, [manifest.mentoring]);
  await client.query(`UPDATE human_reviews SET summary='Conteúdo removido', observations='[]'
    WHERE id=ANY($1::uuid[])`, [manifest.reviews]);
  await client.query(`UPDATE individual_plan_items SET title='Conteúdo removido',description=''
    WHERE id=ANY($1::uuid[])`, [manifest.plans]);
  await client.query(`UPDATE individual_plan_history SET response='',snapshot=snapshot||'{"title":"Conteúdo removido","description":""}'::jsonb
    WHERE (item_id::text||':'||revision)=ANY($1::text[])`, [manifest.history]);
}

async function freezeScope(client: PoolClient, scope: PrivacyScope, userIds: string[]) {
  if (!scope.studentId) await client.query(`UPDATE orgs SET status='suspended',
    privacy_erasure_started_at=COALESCE(privacy_erasure_started_at,now()) WHERE id=$1`, [scope.orgId]);
  await client.query(`UPDATE users SET status='suspended',archived_at=COALESCE(archived_at,now()),
    privacy_erasure_started_at=COALESCE(privacy_erasure_started_at,now()) WHERE id=ANY($1::uuid[])`, [userIds]);
}

async function retireMedia(db: Database, media: string[], storage: LocalStorage) {
  let removed = 0;
  for (let offset = 0; offset < media.length; offset += 100) {
    const entries = await db.transaction(async client => {
      const batch = await client.query<{ id: string }>(`SELECT id FROM recordings WHERE id=ANY($1::uuid[])
        AND media_removed_at IS NULL ORDER BY id FOR UPDATE`, [media.slice(offset, offset + 100)]);
      // Recheck after the lock. A submission may have finished reserving this media meanwhile.
      return (await client.query<{ id: string; object_key: string }>(`UPDATE recordings m
        SET media_retired_at=COALESCE(media_retired_at,now()) WHERE id=ANY($1::uuid[])
        AND NOT EXISTS(SELECT 1 FROM evaluation_requests WHERE recording_id=m.id AND ${activeRequest})
        RETURNING id,object_key`, [batch.rows.map(row => row.id)])).rows;
    });
    for (const { id, object_key } of entries) {
      await storage.removeUploadObject(object_key);
      await db.query('UPDATE recordings SET media_removed_at=now() WHERE id=$1 AND media_removed_at IS NULL', [id]);
      removed++;
    }
  }
  return removed;
}

async function applyManifest(db: Database, storage: LocalStorage, scope: PrivacyScope, confirmed: string) {
  const manifest = await db.transaction(async client => {
    if (scope.orgId) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [scope.orgId]);
      if (!scope.studentId) await client.query('SELECT id FROM orgs WHERE id=$1 FOR UPDATE', [scope.orgId]);
      await client.query(`SELECT id FROM users WHERE ${userScopeSql} ORDER BY id FOR UPDATE`, filters(scope));
    }
    const plan = await snapshot(client, storage, scope);
    if (plan.preview.fingerprint !== confirmed) throw new Error('A seleção mudou. Emita uma nova simulação antes de aplicar.');
    if (scope.orgId) await freezeScope(client, scope, plan.userIds);
    return plan;
  });
  for (const item of manifest.pending) await db.transaction(client => cancelEvaluationInTransaction(client,
    { requestId: item.id, orgId: item.org_id, studentId: item.student_id }, 'Retenção da gravação'));
  const recordingsRemoved = await retireMedia(db, manifest.media, storage);
  for (const path of manifest.files) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  await db.transaction(async client => {
    await client.query(`UPDATE evaluation_results SET report='{}',report_removed_at=now()
      WHERE request_id=ANY($1::uuid[]) AND report_removed_at IS NULL`, [manifest.reports]);
    await client.query(`UPDATE evaluation_requests SET context='{}'
      WHERE id=ANY($1::uuid[]) AND NOT (${activeRequest})
        AND NOT EXISTS(SELECT 1 FROM evaluation_results f
          WHERE f.request_id=evaluation_requests.id AND f.report_removed_at IS NULL)`, [manifest.contexts]);
    await client.query('DELETE FROM auth_tokens WHERE id=ANY($1::uuid[])', [manifest.tokens]);
    await client.query('DELETE FROM sensitive_access_events WHERE id=ANY($1::bigint[])', [manifest.access]);
    await redactMentoring(client, manifest);
    await client.query(`UPDATE recordings SET filename='midia-removida',objective='Conteúdo removido',probe='{}'
      WHERE id=ANY($1::uuid[]) AND media_removed_at IS NOT NULL`, [manifest.metadata]);
    if (scope.orgId) {
      await client.query('DELETE FROM sessions WHERE id=ANY($1::uuid[])', [manifest.sessions]);
      await client.query(`UPDATE users SET email='erased-'||gen_random_uuid()||'@local.invalid',name='Conta removida',
        profile='{}',privacy_erased_at=now() WHERE id=ANY($1::uuid[]) AND privacy_erased_at IS NULL`, [manifest.userIds]);
    }
  });
  return { recordingsRemoved };
}

export async function applyPrivacy(db: Database, storage: LocalStorage, scope: PrivacyScope, confirmed: string) {
  validateScope(scope);
  if (!/^[a-f0-9]{64}$/u.test(confirmed)) throw new Error('Informe o hash exibido pela simulação.');
  const guard = await db.pool.connect();
  try {
    const administrator = await guard.query<{ owner: boolean }>(`SELECT current_user=pg_get_userbyid(relowner) AS owner
      FROM pg_class WHERE oid=to_regclass('mentoring_sessions')`);
    if (!administrator.rows[0]?.owner) throw new Error('A retenção exige o papel de migração deste ambiente.');
    const locked = await guard.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock(
      hashtextextended(current_schema()||':privacy-retention',27)) AS acquired`);
    if (!locked.rows[0].acquired) throw new Error('Já existe uma execução de retenção neste ambiente.');
    return await applyManifest(db, storage, scope, confirmed);
  } finally { guard.release(true); }
}
