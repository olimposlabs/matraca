import { z } from 'zod';
import type { EducationQuery } from './permissions.js';
import { evaluationScenarios } from './evaluation/provider.js';

export const hardRecordingBytes = 200 * 1024 * 1024;

export const operationPolicySchema = z.object({
  maxRecordingBytes: z.number().int().min(1024).max(hardRecordingBytes),
  maxConcurrentEvaluations: z.number().int().min(1).max(12),
  maxEvaluationsPerHour: z.number().int().min(1).max(240),
  maxManualGrant: z.number().int().min(1).max(1_000_000),
  simulatedCentsPerMinute: z.number().int().min(0).max(1_000_000),
  evaluationScenario: z.enum(evaluationScenarios),
  paymentScenario: z.enum(['approved', 'pending', 'declined', 'cancelled']),
  mailMode: z.enum(['normal', 'suppressed', 'failure']),
  clockOverride: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export type OperationPolicy = z.infer<typeof operationPolicySchema>;

export const defaultOperationPolicy: OperationPolicy = {
  maxRecordingBytes: hardRecordingBytes,
  maxConcurrentEvaluations: 3,
  maxEvaluationsPerHour: 30,
  maxManualGrant: 1_000_000,
  simulatedCentsPerMinute: 0,
  evaluationScenario: 'success',
  paymentScenario: 'approved',
  mailMode: 'normal',
  clockOverride: null,
};

export async function readOperationPolicy(client: EducationQuery, orgId: string) {
  const result = await client.query<{ config: OperationPolicy; revision: number }>(
    'SELECT config,revision FROM operation_policies WHERE org_id=$1', [orgId],
  );
  return result.rows[0] ?? { config: defaultOperationPolicy, revision: 0 };
}

export function financialClock(policy: OperationPolicy): Date {
  return policy.clockOverride ? new Date(policy.clockOverride) : new Date();
}
