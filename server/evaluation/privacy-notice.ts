export const evaluationNoticeVersion = '2026-11-25-v1';
export const evaluationNotice = 'Autorizo o envio de áudio, quadros do vídeo, objetivo, rubrica, enunciado e níveis recentes de avaliação à OpenAI para gerar feedback.';

export function declaredExperience(value: unknown): { experience?: string } {
  return typeof value === 'string' && ['beginner', 'intermediate', 'advanced'].includes(value) ? { experience: value } : {};
}
