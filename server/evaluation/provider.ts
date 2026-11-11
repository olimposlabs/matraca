import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export const evaluationScenarios = ['success', 'delay', 'transient', 'permanent', 'timeout', 'invalid'] as const;
export type EvaluationScenario = typeof evaluationScenarios[number];

export interface EvaluationCriterion {
  id: string;
  title: string;
  weight: number;
  modality: 'audio' | 'visual' | 'both';
  descriptors: readonly [string, string, string, string];
}

export interface EvaluationContext {
  requestId: string;
  recording: {
    id: string;
    durationMicroseconds: number;
    hasAudio: boolean;
    hasVideo: boolean;
  };
  objective: string;
  purpose: 'free' | 'diagnostic' | 'course';
  audienceScenario: 'one_on_one' | 'executive' | 'audience';
  activity: { title: string; instructionMarkdown: string } | null;
  rubricVersion: string;
  criteria: EvaluationCriterion[];
  learner: { profession?: string; experience?: string; goals?: string[] };
  recentResults: { rubricVersion: string; score: number | null }[];
}

export interface EvaluationProvider {
  evaluate(context: EvaluationContext, options: {
    attempt: number;
    signal: AbortSignal;
    scenario: EvaluationScenario;
  }): Promise<unknown>;
}

const shortText = z.string().trim().min(1).max(1000);
const observation = z.object({
  criterionId: z.string().min(1).max(100),
  level: z.number().int().min(1).max(4).nullable(),
  rationale: shortText,
  evidence: z.array(z.object({
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().positive(),
    label: shortText,
  }).strict()).max(8),
  recommendation: shortText,
}).strict();

const reportSchema = z.object({
  provider: z.literal('mock'),
  simulated: z.literal(true),
  summary: shortText,
  strengths: z.array(shortText).max(12),
  practicePlan: z.array(shortText).min(1).max(12),
  observations: z.array(observation).min(1).max(40),
  usage: z.object({ mediaMicroseconds: z.number().int().positive(), estimatedProviderCostCents: z.literal(0) }).strict(),
}).strict();

export type EvaluationReport = z.infer<typeof reportSchema> & {
  overallLevel: number | null;
  rubricVersion: string;
};

export class EvaluationProviderError extends Error {
  constructor(
    readonly code: 'temporary' | 'permanent' | 'timeout' | 'invalid',
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

function observable(criterion: EvaluationCriterion, recording: EvaluationContext['recording']): boolean {
  if (criterion.modality === 'visual') return recording.hasVideo;
  if (criterion.modality === 'audio') return recording.hasAudio;
  return recording.hasAudio || recording.hasVideo;
}

export function validateEvaluationReport(input: unknown, context: EvaluationContext): EvaluationReport {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success || parsed.data.usage.mediaMicroseconds !== context.recording.durationMicroseconds) {
    throw new EvaluationProviderError('invalid', false);
  }
  const criteria = new Map(context.criteria.map(item => [item.id, item]));
  const seen = new Set<string>();
  let weightedLevels = 0;
  let totalWeight = 0;
  for (const item of parsed.data.observations) {
    const criterion = criteria.get(item.criterionId);
    if (!criterion || seen.has(item.criterionId)) throw new EvaluationProviderError('invalid', false);
    seen.add(item.criterionId);
    const canObserve = observable(criterion, context.recording);
    if (!canObserve && (item.level !== null || item.evidence.length > 0)) {
      throw new EvaluationProviderError('invalid', false);
    }
    if (item.level === null && item.evidence.length > 0) throw new EvaluationProviderError('invalid', false);
    for (const segment of item.evidence) {
      if (segment.endUs <= segment.startUs || segment.endUs > context.recording.durationMicroseconds) {
        throw new EvaluationProviderError('invalid', false);
      }
    }
    if (item.level !== null) {
      totalWeight += criterion.weight;
      weightedLevels += item.level * criterion.weight;
    }
  }
  if (seen.size !== criteria.size) throw new EvaluationProviderError('invalid', false);
  return {
    ...parsed.data,
    rubricVersion: context.rubricVersion,
    overallLevel: totalWeight === 0 ? null : Math.round(weightedLevels / totalWeight * 100) / 100,
  };
}

export class MockEvaluationProvider implements EvaluationProvider {
  async evaluate(context: EvaluationContext, options: {
    attempt: number;
    signal: AbortSignal;
    scenario: EvaluationScenario;
  }): Promise<unknown> {
    options.signal.throwIfAborted();
    if (options.scenario === 'delay') await delay(2400, undefined, { signal: options.signal });
    if (options.scenario === 'timeout') await delay(60_000, undefined, { signal: options.signal });
    if (options.scenario === 'transient' && options.attempt === 1) throw new EvaluationProviderError('temporary', true);
    if (options.scenario === 'permanent') throw new EvaluationProviderError('permanent', false);
    if (options.scenario === 'invalid') return { provider: 'mock', simulated: true, observations: [] };

    const observations = context.criteria.map(criterion => {
      if (!observable(criterion, context.recording)) {
        return {
          criterionId: criterion.id,
          level: null,
          rationale: 'O formato da gravação não permite observar este critério.',
          evidence: [],
          recommendation: criterion.modality === 'visual' ? 'Use vídeo para praticar este critério.' : 'Inclua áudio para praticar este critério.',
        };
      }
      const digest = createHash('sha256').update(JSON.stringify([
        context.recording.id, context.objective, context.rubricVersion, criterion.id,
      ])).digest();
      const level = digest[0] % 4 + 1;
      const duration = context.recording.durationMicroseconds;
      const startUs = Math.floor((duration - 1) * (digest[1] % 60) / 100);
      const endUs = Math.min(duration, startUs + Math.max(1, Math.floor(duration / 5)));
      return {
        criterionId: criterion.id,
        level,
        rationale: `Exemplo simulado de nível ${level}: ${criterion.descriptors[level - 1]}`.slice(0, 1000),
        evidence: [{ startUs, endUs, label: 'Trecho ilustrativo gerado pelo simulador' }],
        recommendation: `Escolha um ajuste em ${criterion.title.toLowerCase()} e repita o exercício.`,
      };
    });
    return {
      provider: 'mock',
      simulated: true,
      summary: 'Relatório simulado. As notas e os trechos ilustram o formato da devolutiva.',
      strengths: observations.filter(item => (item.level ?? 0) >= 3)
        .slice(0, 4).map(item => `Exemplo de destaque em ${context.criteria.find(criterion => criterion.id === item.criterionId)?.title}.`),
      practicePlan: [
        'Reveja um trecho e escolha um comportamento observável para ajustar.',
        'Grave uma nova tentativa com o mesmo objetivo e compare os trechos.',
      ],
      observations,
      usage: { mediaMicroseconds: context.recording.durationMicroseconds, estimatedProviderCostCents: 0 },
    };
  }
}
