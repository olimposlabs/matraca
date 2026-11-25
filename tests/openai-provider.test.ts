import { describe, expect, it, vi } from 'vitest';
import { OpenAIEvaluationProvider } from '../server/evaluation/openai.js';
import { evaluationConfiguration, loadOpenAIKey } from '../server/evaluation/openai-config.js';
import { MockEvaluationProvider, validateEvaluationReport, type EvaluationContext, type ProviderCall } from '../server/evaluation/provider.js';

const context: EvaluationContext = {
  requestId: 'private-request-id', recording: { id: 'private-recording-id', durationMicroseconds: 10_000_000, hasAudio: true, hasVideo: false },
  objective: 'Explicar uma proposta.', purpose: 'free', audienceScenario: 'executive', activity: null,
  rubricVersion: 'test-v1', learner: {}, recentResults: [],
  criteria: [
    { id: 'voice', title: 'Voz', modality: 'audio', weight: 2, descriptors: ['1', '2', '3', '4'] },
    { id: 'visual', title: 'Postura', modality: 'visual', weight: 1, descriptors: ['1', '2', '3', '4'] },
  ],
};
const options = { attempt: 1, signal: new AbortController().signal, scenario: 'success' as const };
const body = {
  summary: 'A proposta está clara.', strengths: ['Boa articulação.'], practicePlan: ['Pratique pausas.'],
  observations: [
    { criterionId: 'voice', level: 3, rationale: 'Articulação clara.', recommendation: 'Faça uma pausa antes da proposta.', evidence: [{ startUs: 0, endUs: 10_000_000, label: 'Trecho ouvido' }] },
    { criterionId: 'visual', level: null, rationale: 'Sem vídeo.', recommendation: 'Grave com câmera.', evidence: [] },
  ],
};
function setup(responseBody: unknown = body, failure?: Response, isActive?: () => Promise<boolean>) {
  const calls: ProviderCall[] = [];
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(failure ?? new Response(JSON.stringify({
    model: 'gpt-audio-1.5', choices: [{ finish_reason: 'stop', message: { content: 'Fala clara.' } }],
    usage: { prompt_tokens: 90, completion_tokens: 20, prompt_tokens_details: { audio_tokens: 70 } },
  }), { headers: { 'x-request-id': 'req-audio' } })).mockResolvedValueOnce(new Response(JSON.stringify({
    status: 'completed', model: 'gpt-4.1-mini', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(responseBody) }] }],
    usage: { input_tokens: 100, output_tokens: 80 },
  })));
  const provider = new OpenAIEvaluationProvider({
    apiKey: 'synthetic-test-key', audioModel: 'gpt-audio-1.5', reportModel: 'gpt-4.1-mini', fetch: transport, isActive,
    media: async () => ({ audio: [{ startUs: 0, endUs: 10_000_000, data: Buffer.from('synthetic-wav') }], frames: [] }),
    recordCall: async (_context, _attempt, call) => { calls.push(call); },
  });
  return { provider, transport, calls };
}

describe('OpenAI sem rede nos testes', () => {
  it('envia áudio nativo e valida o relatório; metadados e pontuação vêm do servidor', async () => {
    const { provider, transport, calls } = setup();
    const report = validateEvaluationReport(await provider.evaluate(context, options), context);
    expect(report).toMatchObject({ provider: 'openai', simulated: false, overallLevel: 3, usage: { estimatedProviderCostCents: null } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ audioInputTokens: 70, requestId: 'req-audio', httpStatus: 200 });
    const first = JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(first.store).toBe(false);
    expect(first.messages[1].content[1].type).toBe('input_audio');
    const final = JSON.parse(String(transport.mock.calls[1][1]?.body));
    expect(final).toMatchObject({ store: false, text: { format: { type: 'json_schema', strict: true } } });
    expect(JSON.stringify(final)).not.toContain(context.requestId);
    expect(JSON.stringify(final)).not.toContain(context.recording.id);
    expect(JSON.stringify(report)).not.toContain('synthetic-test-key');
    expect(transport.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('reduz o contexto a campos pedagógicos previstos no aviso', async () => {
    const { provider, transport } = setup();
    await provider.evaluate({
      ...context,
      learner: { profession: 'profissao-sintetica', goals: ['meta-sintetica'], experience: 'intermediate' },
      recentResults: [{ rubricVersion: 'rubrica-historica-sintetica', score: 3 }],
    }, options);
    const requests = transport.mock.calls.map(([, init]) => String(init?.body)).join('\n');
    expect(requests).toContain('intermediate');
    expect(requests).toContain('recentLevels');
    expect(requests).not.toMatch(/profissao-sintetica|meta-sintetica|rubrica-historica-sintetica/u);
  });

  it('recusa evidência inventada, nota visual sem vídeo e metadados fornecidos pelo modelo', async () => {
    for (const invalid of [
      { ...body, observations: [{ ...body.observations[0], evidence: [{ startUs: 1, endUs: 3, label: 'Inventada' }] }, body.observations[1]] },
      { ...body, observations: [body.observations[0], { ...body.observations[1], level: 4 }] },
      { ...body, provider: 'mock', simulated: true },
    ]) {
      await expect(setup(invalid).provider.evaluate(context, options)).rejects.toMatchObject({ code: 'invalid', retryable: false });
    }
  });

  it.each([
    [401, 'bad_key', 'credentials', false], [403, 'denied', 'credentials', false],
    [429, 'insufficient_quota', 'quota', false], [429, 'rate_limit', 'temporary', true],
    [500, 'server_error', 'temporary', true], [400, 'bad_request', 'permanent', false],
  ])('trata HTTP %s sem expor resposta nem simular sucesso', async (status, code, expected, retryable) => {
    const { provider, calls, transport } = setup(body, new Response(JSON.stringify({ error: { code, message: 'sensitive-error-body' } }), { status }));
    await expect(provider.evaluate(context, options)).rejects.toMatchObject({ code: expected, retryable, message: expected });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ httpStatus: status, inputTokens: null });
    expect(JSON.stringify(calls)).not.toContain('sensitive');
  });

  it('aborta sem nova chamada e registra falha de transporte sem presumir tokens zero', async () => {
    const { provider, transport, calls } = setup();
    transport.mockReset().mockRejectedValue(new Error('internal-sensitive-payload'));
    await expect(provider.evaluate(context, options)).rejects.toMatchObject({ code: 'temporary', retryable: true });
    expect(calls[0]).toMatchObject({ httpStatus: null, inputTokens: null });
    const aborted = AbortSignal.abort();
    await expect(provider.evaluate(context, { ...options, signal: aborted })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('mantém mock explícito e rejeita modo desconhecido', async () => {
    expect(evaluationConfiguration({}).kind).toBe('mock');
    expect(() => evaluationConfiguration({ EVALUATION_PROVIDER: 'typo' })).toThrow();
    expect(await loadOpenAIKey({ OPENAI_API_KEY: 'synthetic-key' })).toBe('synthetic-key');
    expect(validateEvaluationReport(await new MockEvaluationProvider().evaluate(context, options), context).simulated).toBe(true);
  });

  it('não inicia outra chamada após cancelamento ou perda da reserva de execução', async () => {
    const active = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const { provider, transport, calls } = setup(body, undefined, active);
    await expect(provider.evaluate(context, options)).rejects.toMatchObject({ code: 'permanent', retryable: false });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });
});
