import type { AuthIdentity } from './auth.js';
import type { Database } from './db.js';

export type SensitiveAction = 'recording_media' | 'evaluation_report' | 'evaluation_history';
export type SensitiveOutcome = 'allowed' | 'denied' | 'unavailable';
type SensitiveReason = 'scope_denied' | 'not_found' | 'retention' | 'report_unavailable';

// Both the audit event and its subject use the tenant captured by the server-side lookup.
export const subjectOfSensitiveEvent = `CASE a.action
  WHEN 'evaluation_history' THEN a.target_id
  WHEN 'recording_media' THEN (SELECT m.student_id FROM recordings m WHERE m.id=a.target_id AND m.org_id=a.org_id)
  WHEN 'evaluation_report' THEN (SELECT r.student_id FROM evaluation_requests r WHERE r.id=a.target_id AND r.org_id=a.org_id)
END`;

export async function recordSensitiveAccess(
  db: Database, actor: AuthIdentity, action: SensitiveAction, targetId: string | null, outcome: SensitiveOutcome,
  reason: SensitiveReason | null = null,
) {
  await db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,4))', [actor.org.id]);
    await client.query(`WITH event(org_id,actor_id,action,target_id,outcome,reason) AS (
      VALUES($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::text)
    )
    INSERT INTO sensitive_access_events(org_id,actor_id,action,target_id,outcome,reason,bucket)
    SELECT a.*,date_bin('10 minutes',clock_timestamp(),'2000-01-01T00:00:00Z') FROM event a
    JOIN orgs o ON o.id=a.org_id
    WHERE o.privacy_erasure_started_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM users u WHERE u.org_id=a.org_id AND u.privacy_erasure_started_at IS NOT NULL
        AND (u.id=a.actor_id OR u.id=(${subjectOfSensitiveEvent}))
    ) ON CONFLICT DO NOTHING`, [actor.org.id, actor.user.id, action, targetId, outcome, reason]);
  });
}
