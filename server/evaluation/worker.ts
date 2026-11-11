import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from '../db.js';
import { applyCourseEvaluation } from '../journey-progress.js';
import { consumeReservationInTransaction, releaseReservationInTransaction } from '../wallet.js';
import { EvaluationProviderError, validateEvaluationReport, type EvaluationContext, type EvaluationProvider, type EvaluationReport, type EvaluationScenario } from './provider.js';

const maxAttempts = 3;
const leaseSeconds = 30;
const defaultTimeoutMs = 8000;

interface Job {
  request_id: string;
  org_id: string;
  student_id: string;
  context: EvaluationContext;
  scenario: EvaluationScenario;
  attempts: number;
  leaseToken: string;
  exhausted: boolean;
}

async function claim(db: Database, requestId?: string): Promise<Job | null> {
  return db.transaction(async client => {
    const candidate = await client.query<Omit<Job, 'leaseToken' | 'exhausted'>>(
      `SELECT j.request_id,j.attempts,r.org_id,r.student_id,r.context,r.scenario
       FROM evaluation_jobs j JOIN evaluation_requests r ON r.id=j.request_id
       WHERE ($1::uuid IS NULL OR j.request_id=$1)
         AND ((j.state='queued' AND j.available_at<=clock_timestamp())
           OR (j.state='leased' AND j.lease_until<=clock_timestamp()))
       ORDER BY j.available_at,j.request_id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
      [requestId ?? null],
    );
    const row = candidate.rows[0];
    if (!row) return null;
    const leaseToken = randomUUID();
    const exhausted = row.attempts >= maxAttempts;
    const attempts = exhausted ? maxAttempts : row.attempts + 1;
    await client.query(
      `UPDATE evaluation_jobs SET state='leased',attempts=$2,lease_token=$3,
       lease_until=clock_timestamp()+$4*interval '1 second' WHERE request_id=$1`,
      [row.request_id, attempts, leaseToken, leaseSeconds],
    );
    await client.query("UPDATE evaluation_requests SET status='processing',updated_at=clock_timestamp() WHERE id=$1", [row.request_id]);
    return { ...row, attempts, leaseToken, exhausted };
  });
}

async function finishJob(client: PoolClient, requestId: string, status: 'completed' | 'failed' | 'cancelled', code: string | null = null) {
  await client.query(
    `UPDATE evaluation_requests SET status=$2,error_code=$3,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
    [requestId, status, code],
  );
  await client.query("UPDATE evaluation_jobs SET state='done',lease_token=NULL,lease_until=NULL WHERE request_id=$1", [requestId]);
  await client.query('INSERT INTO evaluation_outbox(request_id,event_type) VALUES ($1,$2) ON CONFLICT DO NOTHING', [requestId, status]);
}

export async function cancelEvaluationInTransaction(client: PoolClient, target: { orgId: string; studentId: string; requestId: string }) {
  const found = await client.query<{ status: string }>(
    `SELECT r.status FROM evaluation_requests r JOIN evaluation_jobs j ON j.request_id=r.id
     WHERE r.id=$1 AND r.org_id=$2 AND r.student_id=$3 FOR UPDATE OF j`,
    [target.requestId, target.orgId, target.studentId],
  );
  const row = found.rows[0];
  if (!row) return null;
  // Read after the job lock. A worker may have settled the request while this caller waited.
  const current = await client.query<{ status: string }>('SELECT status FROM evaluation_requests WHERE id=$1', [target.requestId]);
  const status = current.rows[0].status;
  if (status !== 'queued' && status !== 'processing') return status;
  await releaseReservationInTransaction(client, { ...target, userId: target.studentId, reason: 'Avaliação cancelada pelo aluno' });
  await finishJob(client, target.requestId, 'cancelled');
  return 'cancelled';
}

async function settle(db: Database, job: Job, result: EvaluationReport | EvaluationProviderError) {
  await db.transaction(async client => {
    const lease = await client.query(
      "SELECT request_id FROM evaluation_jobs WHERE request_id=$1 AND state='leased' AND lease_token=$2 FOR UPDATE",
      [job.request_id, job.leaseToken],
    );
    if (!lease.rowCount) return;
    const target = { orgId: job.org_id, userId: job.student_id, requestId: job.request_id };
    if (result instanceof EvaluationProviderError) {
      if (result.retryable && job.attempts < maxAttempts) {
        await client.query(
          `UPDATE evaluation_jobs SET state='queued',available_at=clock_timestamp()+$2*interval '1 second',
           lease_token=NULL,lease_until=NULL WHERE request_id=$1`, [job.request_id, 2 ** (job.attempts - 1)],
        );
        await client.query("UPDATE evaluation_requests SET status='queued',updated_at=clock_timestamp() WHERE id=$1", [job.request_id]);
        return;
      }
      await releaseReservationInTransaction(client, { ...target, reason: 'A avaliação não foi concluída' });
      await finishJob(client, job.request_id, 'failed', result.code);
      return;
    }
    await applyCourseEvaluation(client, {
      orgId: job.org_id, studentId: job.student_id,
      recordingId: job.context.recording.id, evaluationId: job.request_id,
    });
    const reservation = await consumeReservationInTransaction(client, target);
    await client.query(
      `INSERT INTO evaluation_results(request_id,org_id,student_id,report,consumption_entry_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [job.request_id, job.org_id, job.student_id, result, reservation.consumption_entry_id],
    );
    await finishJob(client, job.request_id, 'completed');
  });
}

async function evaluate(job: Job, provider: EvaluationProvider, timeoutMs: number): Promise<EvaluationReport | EvaluationProviderError> {
  if (job.exhausted) return new EvaluationProviderError('timeout', false);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const failure = new EvaluationProviderError('timeout', true);
        reject(failure);
        controller.abort(failure);
      }, timeoutMs);
    });
    const raw = await Promise.race([
      provider.evaluate(job.context, { attempt: job.attempts, signal: controller.signal, scenario: job.scenario }),
      timedOut,
    ]);
    return validateEvaluationReport(raw, job.context);
  } catch (error) {
    return error instanceof EvaluationProviderError ? error : new EvaluationProviderError('temporary', true);
  } finally {
    clearTimeout(timer);
  }
}

export async function runEvaluationJob(
  db: Database,
  provider: EvaluationProvider,
  { timeoutMs = defaultTimeoutMs, requestId }: { timeoutMs?: number; requestId?: string } = {},
): Promise<boolean> {
  const job = await claim(db, requestId);
  if (!job) return false;
  const result = await evaluate(job, provider, timeoutMs);
  await settle(db, job, result);
  return true;
}

export function startEvaluationWorker(db: Database, provider: EvaluationProvider) {
  let stopped = false;
  let current: Promise<unknown> | undefined;
  let next: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (stopped) return;
    current = runEvaluationJob(db, provider)
      .catch(() => {
        process.stderr.write('Falha no ciclo da fila de avaliações. A tarefa será recuperada pelo prazo da reserva de execução.\n');
        return false;
      })
      .then(processed => {
        if (!stopped) next = setTimeout(tick, processed ? 20 : 500);
      });
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(next);
    await current;
  };
}
