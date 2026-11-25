import type { Database } from '../db.js';
import type { LocalStorage } from '../storage.js';
import { privateEvaluationMedia } from './openai-media.js';
import { OpenAIEvaluationProvider } from './openai.js';
import { authorizeLiveDispatch, liveLimitsEnabled, type LiveLimits } from './live-policy.js';
import { EvaluationProviderError } from './provider.js';

export async function isOpenAIAttemptActive(db: Database, requestId: string, attempt: number) {
  const result = await db.query(
    `SELECT 1 FROM evaluation_requests r JOIN evaluation_jobs j ON j.request_id=r.id
     WHERE r.id=$1 AND r.provider='openai' AND r.status='processing'
       AND j.state='leased' AND j.attempts=$2 AND j.lease_until>clock_timestamp()`,
    [requestId, attempt],
  );
  return result.rowCount === 1;
}

export function createOpenAIProvider(db: Database, storage: LocalStorage, config: { apiKey: string; audioModel: string; reportModel: string; instance: LiveLimits }) {
  return new OpenAIEvaluationProvider({
    ...config,
    media: async (context, signal) => {
      if (!liveLimitsEnabled(config.instance)) throw new EvaluationProviderError('authorization', false);
      return privateEvaluationMedia(db, storage)(context, signal);
    },
    authorize: (context, attempt, leaseToken, callIndex) => {
      if (!leaseToken) throw new EvaluationProviderError('authorization', false);
      return authorizeLiveDispatch(db, { requestId: context.requestId, attempt, leaseToken, callIndex, instance: config.instance });
    },
    recordCall: async (context, attempt, call) => {
      await db.query('INSERT INTO evaluation_provider_calls(request_id,attempt,metadata) VALUES ($1,$2,$3)', [context.requestId, attempt, call]);
    },
  });
}
