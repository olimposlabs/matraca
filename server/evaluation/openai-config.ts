import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const liveEvaluationMaximumSeconds = 300;
export const openaiKeychainService = 'Matraca IA DEV - OpenAI';

export function evaluationConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const kind = env.EVALUATION_PROVIDER ?? 'mock';
  if (kind !== 'mock' && kind !== 'openai') throw new Error('EVALUATION_PROVIDER deve ser mock ou openai.');
  return {
    kind,
    audioModel: env.OPENAI_AUDIO_MODEL ?? 'gpt-audio-1.5',
    reportModel: env.OPENAI_REPORT_MODEL ?? 'gpt-4.1-mini',
  } as const;
}

/** Load into the server process only. Never log the command result or its error object. */
export async function loadOpenAIKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.OPENAI_API_KEY?.trim()) return env.OPENAI_API_KEY.trim();
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execute('/usr/bin/security', [
        'find-generic-password', '-w', '-a', 'OPENAI_API_KEY', '-s',
        env.OPENAI_KEYCHAIN_SERVICE ?? openaiKeychainService,
      ], { timeout: 15_000, maxBuffer: 16_384 });
      if (stdout.trim()) return stdout.trim();
    } catch { /* Child-process exceptions can contain captured secrets. Discard them. */ }
  }
  throw new Error('Chave OpenAI indisponível. Configure OPENAI_API_KEY no servidor ou desbloqueie o item Matraca IA DEV - OpenAI no Chaves do macOS.');
}
