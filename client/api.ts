export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type ApiOptions = Omit<RequestInit, 'body' | 'credentials' | 'mode'> & {
  body?: unknown;
};

const responseMessages: Record<number, string> = {
  400: 'Confira os dados informados e tente novamente.',
  401: 'Entre novamente para continuar.',
  402: 'O saldo disponível é insuficiente para esta operação.',
  403: 'Sua conta não tem permissão para realizar esta ação nesta organização.',
  404: 'Não foi possível encontrar este recurso nesta organização.',
  409: 'Não foi possível concluir esta ação. Atualize a página e tente novamente.',
  422: 'Confira os dados informados e tente novamente.',
  429: 'Foram feitas muitas tentativas. Aguarde um pouco antes de tentar novamente.',
};

/** Same-origin JSON requests. Session cookies remain inaccessible to the client. */
export async function apiJson<T>(path: string, options: ApiOptions = {}): Promise<T> {
  if (!path.startsWith('/api/')) throw new ApiError(0, 'O endereço desta solicitação é inválido.');

  const controller = new AbortController();
  const externalSignal = options.signal;
  const cancel = () => controller.abort();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15000);

  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener('abort', cancel, { once: true });

  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  headers.set('x-matraca-request', '1');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  try {
    const response = await fetch(path, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = responseMessages[response.status] ?? 'O serviço não está disponível agora. Tente novamente em instantes.';
      if ([400, 402, 409, 422].includes(response.status)) {
        const problem = await response.json().catch(() => null) as { error?: unknown } | null;
        if (typeof problem?.error === 'string' && problem.error.length <= 300) message = problem.error;
      }
      throw new ApiError(response.status, message);
    }
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(response.status, 'Não foi possível interpretar a resposta do serviço. Tente novamente.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (externalSignal?.aborted) throw error;
    throw new ApiError(0, timedOut
      ? 'O serviço demorou para responder. Tente novamente.'
      : 'Não foi possível conectar ao Matraca. Verifique sua conexão e tente novamente.');
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', cancel);
  }
}
