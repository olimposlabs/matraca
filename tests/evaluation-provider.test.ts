import { describe, expect, it } from 'vitest';
import { EvaluationProviderError, MockEvaluationProvider, validateEvaluationReport, type EvaluationContext } from '../server/evaluation/provider.js';

const context: EvaluationContext = {
  requestId: 'synthetic-request',
  recording: { id: 'synthetic-recording', durationMicroseconds: 30_000_000, hasAudio: true, hasVideo: false },
  objective: 'Explicar a mensagem principal.',
  purpose: 'free',
  rubricVersion: 'demo-v1',
  criteria: [
    { id: 'clarity', title: 'Clareza', modality: 'audio', weight: 2, descriptors: ['Inicial', 'Emergente', 'Consistente', 'Avançado'] },
    { id: 'posture', title: 'Postura', modality: 'visual', weight: 1, descriptors: ['Inicial', 'Emergente', 'Consistente', 'Avançado'] },
  ],
  learner: {},
  recentResults: [],
};
const provider = new MockEvaluationProvider();
const signal = new AbortController().signal;

describe('contrato de avaliação simulada', () => {
  it('produz relatório determinístico e não dá nota visual em áudio', async () => {
    const result = await provider.evaluate(context, { signal, attempt: 1, scenario: 'success' });
    expect(await provider.evaluate(context, { signal, attempt: 2, scenario: 'success' })).toEqual(result);
    const report = validateEvaluationReport(result, context);
    expect(report.simulated).toBe(true);
    expect(report.observations[1]).toMatchObject({ criterionId: 'posture', level: null, evidence: [] });
    expect(report.overallLevel).toBe(report.observations[0].level);
  });

  it('rejeita critérios duplicados, evidências fora da gravação e duração incorreta', async () => {
    const payload = await provider.evaluate(context, { signal, attempt: 1, scenario: 'success' }) as Omit<ReturnType<typeof validateEvaluationReport>, 'overallLevel' | 'rubricVersion'>;
    const outside = structuredClone(payload);
    outside.observations[0].evidence[0].endUs = context.recording.durationMicroseconds + 1;
    const invalid = [
      { ...payload, observations: [payload.observations[0], payload.observations[0]] },
      outside,
      { ...payload, usage: { ...payload.usage, mediaMicroseconds: 1 } },
      { ...payload, observations: [payload.observations[0], { ...payload.observations[1], level: 4 }] },
    ];
    for (const result of invalid) expect(() => validateEvaluationReport(result, context)).toThrow(EvaluationProviderError);
  });

  it('distingue falha transitória, definitiva, timeout e payload inválido', async () => {
    await expect(provider.evaluate(context, { signal, attempt: 1, scenario: 'transient' })).rejects.toMatchObject({ retryable: true });
    await expect(provider.evaluate(context, { signal, attempt: 2, scenario: 'transient' })).resolves.toBeDefined();
    await expect(provider.evaluate(context, { signal, attempt: 1, scenario: 'permanent' })).rejects.toMatchObject({ retryable: false });
    await expect(provider.evaluate(context, { signal: AbortSignal.timeout(5), attempt: 1, scenario: 'timeout' })).rejects.toThrow();
    const invalid = await provider.evaluate(context, { signal, attempt: 1, scenario: 'invalid' });
    expect(() => validateEvaluationReport(invalid, context)).toThrow(EvaluationProviderError);
  });
});
