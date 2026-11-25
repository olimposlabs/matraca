import type { AuthIdentity } from './auth.js';
import type { Database } from './db.js';

export type SensitiveAction = 'recording_media' | 'evaluation_report' | 'evaluation_history';
export type SensitiveOutcome = 'allowed' | 'denied' | 'unavailable';
type SensitiveReason = 'scope_denied' | 'not_found' | 'retention' | 'report_unavailable';

export async function recordSensitiveAccess(
  db: Database, actor: AuthIdentity, action: SensitiveAction, targetId: string | null, outcome: SensitiveOutcome,
  reason: SensitiveReason | null = null,
) {
  await db.query(`INSERT INTO sensitive_access_events(org_id,actor_id,action,target_id,outcome,reason,bucket)
    VALUES($1,$2,$3,$4,$5,$6,date_bin('10 minutes',clock_timestamp(),'2000-01-01T00:00:00Z'))
    ON CONFLICT DO NOTHING`, [actor.org.id, actor.user.id, action, targetId, outcome, reason]);
}
