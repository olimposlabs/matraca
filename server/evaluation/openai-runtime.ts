import type { Database } from '../db.js';
import type { LocalStorage } from '../storage.js';
import { privateEvaluationMedia } from './openai-media.js';
import { OpenAIEvaluationProvider } from './openai.js';

export async function isOpenAIAttemptActive(db: Database, requestId: string, attempt: number) {
  const result = await db.query(
    `SELECT 1 FROM evaluation_requests r JOIN evaluation_jobs j ON j.request_id=r.id
     WHERE r.id=$1 AND r.provider='openai' AND r.status='processing'
       AND j.state='leased' AND j.attempts=$2 AND j.lease_until>clock_timestamp()`,
    [requestId, attempt],
  );
  return result.rowCount === 1;
}

export function createOpenAIProvider(db: Database, storage: LocalStorage, config: { apiKey: string; audioModel: string; reportModel: string }) {
  return new OpenAIEvaluationProvider({
    ...config,
    media: privateEvaluationMedia(db, storage),
    isActive: (context, attempt) => isOpenAIAttemptActive(db, context.requestId, attempt),
    recordCall: async (context, attempt, call) => {
      await db.query('INSERT INTO evaluation_provider_calls(request_id,attempt,metadata) VALUES ($1,$2,$3)', [context.requestId, attempt, call]);
    },
  });
}
