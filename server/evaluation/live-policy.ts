import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { EducationQuery } from '../permissions.js';
import type { Database } from '../db.js';
import { JourneyError, requireStudyForEvaluation } from '../journey-progress.js';
import { EvaluationProviderError, maxEvaluationAttempts } from './provider.js';

const limit = z.number().int().min(0).max(100_000);
export const liveLimitsSchema = z.object({ requests: limit, minutes: limit, calls: limit }).strict();
export type LiveLimits = z.infer<typeof liveLimitsSchema>;
export const noLiveLimits: LiveLimits = { requests: 0, minutes: 0, calls: 0 };
export const liveLimitsEnabled = (limits: LiveLimits) => limits.requests > 0 && limits.minutes > 0 && limits.calls > 0;

export class LivePolicyError extends Error {
  constructor(readonly statusCode: 403 | 429, message: string) { super(message); }
}

export async function readLivePolicy(db: EducationQuery, orgId: string) {
  const row = (await db.query<{ enabled: boolean; organization: unknown; student: unknown; revision: number }>(
    `SELECT enabled,organization_limits AS organization,student_limits AS student,revision
     FROM live_evaluation_policies WHERE org_id=$1`, [orgId],
  )).rows[0];
  if (!row) return { enabled: false, organization: noLiveLimits, student: noLiveLimits, revision: 0 };
  return { ...row, organization: liveLimitsSchema.parse(row.organization), student: liveLimitsSchema.parse(row.student) };
}

export async function liveEnabledForStudent(db: EducationQuery, orgId: string, studentId: string, instance: LiveLimits) {
  if (!liveLimitsEnabled(instance)) return false;
  const policy = await readLivePolicy(db, orgId);
  if (!policy.enabled || !liveLimitsEnabled(policy.organization) || !liveLimitsEnabled(policy.student)) return false;
  return !!(await db.query('SELECT 1 FROM live_evaluation_members WHERE org_id=$1 AND student_id=$2', [orgId, studentId])).rowCount;
}

/** All enqueues and dispatch receipts sharing this database serialize accounting. */
export async function lockLiveBudget(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('matraca:live-budget',15))");
}

type Scope = { orgId: string | null; studentId: string | null; limits: LiveLimits };
function scopes(orgId: string, studentId: string, instance: LiveLimits, policy: Awaited<ReturnType<typeof readLivePolicy>>): Scope[] {
  return [
    { orgId: null, studentId: null, limits: instance },
    { orgId, studentId: null, limits: policy.organization },
    { orgId, studentId, limits: policy.student },
  ];
}

async function usage(client: PoolClient, scope: Scope, admission: boolean) {
  return (await client.query<LiveLimits>(
    `WITH recent AS (
       SELECT count(*)::integer AS requests,COALESCE(sum(a.minutes),0)::integer AS minutes
       FROM live_evaluation_admissions a
       WHERE a.created_at>statement_timestamp()-interval '24 hours'
         AND ($1::uuid IS NULL OR a.org_id=$1) AND ($2::uuid IS NULL OR a.student_id=$2)
     ), dispatched AS (
       SELECT count(*)::integer AS calls FROM live_evaluation_dispatches d
       JOIN live_evaluation_admissions a ON a.request_id=d.request_id
       WHERE d.created_at>statement_timestamp()-interval '24 hours'
         AND ($1::uuid IS NULL OR a.org_id=$1) AND ($2::uuid IS NULL OR a.student_id=$2)
     ), pending AS (
       SELECT COALESCE(sum(a.remaining_calls),0)::integer AS calls FROM live_evaluation_admissions a
       JOIN evaluation_requests r ON r.id=a.request_id
       WHERE $3::boolean AND r.status IN ('queued','processing')
         AND ($1::uuid IS NULL OR a.org_id=$1) AND ($2::uuid IS NULL OR a.student_id=$2)
     )
     SELECT recent.*,dispatched.calls+pending.calls AS calls FROM recent,dispatched,pending`,
    [scope.orgId, scope.studentId, admission],
  )).rows[0];
}

/** The request and the learner's reservation already exist in this transaction. */
export async function admitLiveEvaluation(client: PoolClient, input: {
  requestId: string; orgId: string; studentId: string; minutes: number; hasAudio: boolean; instance: LiveLimits;
}) {
  const { requestId, orgId, studentId, minutes, instance } = input;
  // Share locks order this request against changes to the policy and the allowlist.
  const allowed = await client.query(
    `SELECT 1 FROM live_evaluation_policies p JOIN live_evaluation_members a ON a.org_id=p.org_id
     WHERE p.org_id=$1 AND a.student_id=$2 AND p.enabled FOR SHARE OF p,a`, [orgId, studentId],
  );
  if (!allowed.rowCount || !liveLimitsEnabled(instance)) throw new LivePolicyError(403, 'Esta conta ainda não tem acesso à avaliação real.');
  const policy = await readLivePolicy(client, orgId);
  const calls = ((input.hasAudio ? minutes : 0) + 1) * maxEvaluationAttempts;
  await lockLiveBudget(client);
  for (const scope of scopes(orgId, studentId, instance, policy)) {
    const current = await usage(client, scope, true);
    if (current.requests + 1 > scope.limits.requests || current.minutes + minutes > scope.limits.minutes
      || current.calls + calls > scope.limits.calls) {
      throw new LivePolicyError(429, 'A capacidade de avaliação real foi atingida. Tente novamente mais tarde.');
    }
  }
  await client.query(
    'INSERT INTO live_evaluation_admissions(request_id,org_id,student_id,minutes,remaining_calls) VALUES($1,$2,$3,$4,$5)',
    [requestId, orgId, studentId, minutes, calls],
  );
}

export async function authorizedLiveAttempt(
  client: EducationQuery, requestId: string, attempt: number, leaseToken: string, lock = false,
) {
  const actor = (await client.query<{
    org_id: string; student_id: string; purpose: string; enrollment_id: string | null; unit_id: string | null; strict: boolean;
  }>(
    `SELECT r.org_id,r.student_id,m.purpose,m.enrollment_id,m.unit_id,
       (o.settings->>'strictJourney'='true') IS TRUE AS strict FROM evaluation_requests r
     JOIN evaluation_jobs j ON j.request_id=r.id
     JOIN live_evaluation_admissions b ON b.request_id=r.id
     JOIN credit_reservations w ON w.request_id=r.id::text AND w.org_id=r.org_id AND w.user_id=r.student_id
     JOIN orgs o ON o.id=r.org_id
     JOIN users u ON u.id=r.student_id AND u.org_id=r.org_id
     JOIN live_evaluation_policies p ON p.org_id=r.org_id
     JOIN live_evaluation_members a ON a.org_id=r.org_id AND a.student_id=r.student_id
     JOIN recordings m ON m.id=r.recording_id AND m.org_id=r.org_id AND m.student_id=r.student_id
     WHERE r.id=$1 AND r.provider='openai' AND r.status='processing' AND j.state='leased'
       AND j.attempts=$2 AND j.lease_token=$3 AND j.lease_until>clock_timestamp()
       AND w.provider='openai' AND w.status='reserved'
       AND p.enabled AND o.status='active' AND u.status='active' AND u.archived_at IS NULL
       AND 'student'=ANY(u.roles) AND NOT('operator'=ANY(u.roles))
       AND (m.purpose<>'diagnostic' OR o.settings->>'diagnosticEnabled' IS DISTINCT FROM 'false')
       AND (m.purpose<>'course' OR (
         o.settings->>'coursesEnabled' IS DISTINCT FROM 'false' AND EXISTS(
           SELECT 1 FROM course_enrollments e
           WHERE e.id=m.enrollment_id AND e.version_id=m.version_id AND e.org_id=r.org_id
             AND e.student_id=r.student_id AND e.status IN ('active','completed')
         )
       )) ${lock ? 'FOR SHARE OF u,o,p,a' : ''}`,
    [requestId, attempt, leaseToken],
  )).rows[0];
  if (actor?.purpose === 'course') {
    if (!actor.enrollment_id || !actor.unit_id) return undefined;
    try {
      await requireStudyForEvaluation(client, {
        orgId: actor.org_id, studentId: actor.student_id, enrollmentId: actor.enrollment_id,
      }, actor.unit_id, actor.strict);
    } catch (error) {
      if (error instanceof JourneyError) return undefined;
      throw error;
    }
  }
  return actor;
}

export async function authorizeLiveDispatch(db: Database, input: {
  requestId: string; attempt: number; leaseToken: string; callIndex: number; instance: LiveLimits;
}) {
  return db.transaction(async client => {
    if (!liveLimitsEnabled(input.instance)) throw new EvaluationProviderError('authorization', false);
    // Order with cancellation and lease replacement. The receipt is the dispatch boundary.
    await client.query('SELECT request_id FROM evaluation_jobs WHERE request_id=$1 FOR UPDATE', [input.requestId]);
    const actor = await authorizedLiveAttempt(client, input.requestId, input.attempt, input.leaseToken, true);
    if (!actor) throw new EvaluationProviderError('authorization', false);
    const policy = await readLivePolicy(client, actor.org_id);
    await lockLiveBudget(client);
    for (const scope of scopes(actor.org_id, actor.student_id, input.instance, policy)) {
      if ((await usage(client, scope, false)).calls >= scope.limits.calls) throw new EvaluationProviderError('budget', false);
    }
    const receipt = await client.query(
      `INSERT INTO live_evaluation_dispatches(request_id,attempt,call_index) VALUES($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING request_id`, [input.requestId, input.attempt, input.callIndex],
    );
    if (!receipt.rowCount) throw new EvaluationProviderError('budget', false);
    const debited = await client.query(
      `UPDATE live_evaluation_admissions SET remaining_calls=remaining_calls-1
       WHERE request_id=$1 AND remaining_calls>0 RETURNING request_id`, [input.requestId],
    );
    if (!debited.rowCount) throw new EvaluationProviderError('budget', false);
  });
}
