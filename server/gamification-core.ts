import type { PoolClient } from 'pg';
import { z } from 'zod';

export const badgeRule = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  metric: z.enum(['xp', 'lesson', 'review', 'course']),
  threshold: z.number().int().min(1).max(10_000_000),
}).strict();

const points = z.number().int().min(0).max(100_000);
export const gamificationPolicySchema = z.object({
  points: z.object({ lesson: points, review: points, course: points }).strict(),
  badges: z.array(badgeRule).max(30).refine(items => new Set(items.map(item => item.id)).size === items.length),
}).strict();
type Policy = z.infer<typeof gamificationPolicySchema>;

export const defaultGamificationPolicy: Policy = {
  points: { lesson: 20, review: 100, course: 500 },
  badges: [
    { id: 'first-lesson', name: 'Primeira prática', metric: 'lesson', threshold: 1 },
    { id: 'first-review', name: 'Revisão em dia', metric: 'review', threshold: 1 },
    { id: 'first-course', name: 'Jornada concluída', metric: 'course', threshold: 1 },
    { id: 'xp-500', name: '500 pontos de prática', metric: 'xp', threshold: 500 },
  ],
};

export async function readGamificationPolicy(client: PoolClient, orgId: string) {
  const found = await client.query<{ policy: Policy; revision: number }>(
    'SELECT policy,revision FROM gamification_policies WHERE org_id=$1', [orgId],
  );
  return found.rows[0] ?? { policy: defaultGamificationPolicy, revision: 0 };
}

export async function learnerTotals(client: PoolClient, orgId: string, studentId: string) {
  const result = await client.query<{ xp: number; lesson: number; review: number; course: number }>(
    `SELECT COALESCE(sum(x.points),0)::double precision AS xp,
       count(*) FILTER (WHERE l.kind='lesson')::int AS lesson,
       count(*) FILTER (WHERE l.kind='review')::int AS review,
       count(*) FILTER (WHERE l.kind='course')::int AS course
     FROM learning_events l LEFT JOIN xp_events x ON x.learning_event_id=l.id
     WHERE l.org_id=$1 AND l.student_id=$2`, [orgId, studentId],
  );
  return result.rows[0];
}

export async function awardLearningEvent(client: PoolClient, event: { id: string; orgId: string; studentId: string; kind: 'lesson' | 'review' | 'course' }) {
  // Different enrollments may finish concurrently; serialize totals and badge thresholds per learner.
  // Keep a distinct lock namespace: study already holds the learner(8) and enrollment locks.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,11))', [event.studentId]);
  const { policy, revision } = await readGamificationPolicy(client, event.orgId);
  const awarded = policy.points[event.kind];
  const inserted = await client.query(
    `INSERT INTO xp_events(learning_event_id,org_id,student_id,points,policy_revision)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING learning_event_id`,
    [event.id, event.orgId, event.studentId, awarded, revision],
  );
  if (!inserted.rowCount) return;
  const totals = await learnerTotals(client, event.orgId, event.studentId);
  for (const badge of policy.badges) {
    if (totals[badge.metric] < badge.threshold) continue;
    await client.query(
      `INSERT INTO earned_badges(org_id,student_id,badge_id,learning_event_id,name,condition)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [event.orgId, event.studentId, badge.id, event.id, badge.name, { metric: badge.metric, threshold: badge.threshold }],
    );
  }
}

export const rankedLearners = `WITH totals AS (
  SELECT l.student_id,u.name,sum(x.points)::bigint AS points,max(l.occurred_at) AS reached_at
  FROM xp_events x JOIN learning_events l ON l.id=x.learning_event_id
  JOIN users u ON u.id=l.student_id AND u.org_id=l.org_id
  WHERE l.org_id=$1 AND l.occurred_at>=$2 AND l.occurred_at<$3 AND x.points>0
    AND ($4::uuid IS NULL OR $4::uuid=ANY(l.group_ids))
    AND u.status='active' AND u.archived_at IS NULL AND 'student'=ANY(u.roles)
  GROUP BY l.student_id,u.name
), ranked AS (
  SELECT row_number() OVER (ORDER BY points DESC,reached_at,student_id)::int AS position,
         student_id,name,points,reached_at FROM totals
)`;
