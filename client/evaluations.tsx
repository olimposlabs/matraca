import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ClipboardList, Clock3, Play, Printer } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import type { EvaluationCriterion, EvaluationReport, EvaluationScenario } from '../server/evaluation/provider';
import { apiJson } from './api';
import { AuthenticatedArea, useAuth } from './auth';
import './evaluations.css';

type EvaluationStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
interface EvaluationSummary {
  id: string;
  recordingId: string;
  status: EvaluationStatus;
  credits: number;
  purpose: 'free' | 'diagnostic' | 'course';
  objective: string;
  durationMicroseconds: number;
  createdAt: string;
  attempts: number;
  hasAudio: boolean;
  hasVideo: boolean;
  errorMessage: string | null;
  overallLevel: number | null;
}
interface EvaluationDetail extends EvaluationSummary {
  criteria: EvaluationCriterion[];
  activity: { title: string; instructionMarkdown: string } | null;
  audienceScenario: 'one_on_one' | 'executive' | 'audience' | null;
  report: EvaluationReport | null;
}
interface EvaluationList {
  items: EvaluationSummary[];
  total: number;
  page: number;
  pageSize: number;
}

const statusLabels: Record<EvaluationStatus, string> = {
  queued: 'Na fila', processing: 'Em processamento', completed: 'Concluída', failed: 'Falhou', cancelled: 'Cancelada',
};
const audienceLabels = { one_on_one: 'Conversa individual', executive: 'Reunião executiva', audience: 'Grande plateia' };
const scenarios: [EvaluationScenario, string][] = [
  ['success', 'Resposta normal'], ['delay', 'Resposta demorada'], ['transient', 'Falha recuperável'],
  ['permanent', 'Falha definitiva'], ['timeout', 'Tempo excedido'], ['invalid', 'Resposta inválida'],
];

function isActive(status: EvaluationStatus) {
  return status === 'queued' || status === 'processing';
}

function clock(microseconds: number) {
  const seconds = Math.floor(microseconds / 1_000_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function dateLabel(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(date));
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Não foi possível concluir. Tente novamente.';
}

export function EvaluationAction({ recording }: { recording: { id: string; estimatedCredits: number } }) {
  const navigate = useNavigate();
  const { user, org } = useAuth();
  const [scenario, setScenario] = useState<EvaluationScenario | 'configured'>('configured');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const sessionKeys = useRef(new Map<string, string>());
  const singular = recording.estimatedCredits === 1;
  const customLabel = singular ? org?.branding.creditSingular : org?.branding.creditPlural;
  const label = typeof customLabel === 'string' ? customLabel : singular ? 'crédito' : 'créditos';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const key = `matraca-evaluation:${org?.id}:${user?.id}:${recording.id}:${scenario}`;
    let clientKey = sessionKeys.current.get(key) ?? crypto.randomUUID();
    try {
      clientKey = sessionStorage.getItem(key) ?? clientKey;
      sessionStorage.setItem(key, clientKey);
    } catch { /* The in-memory key still protects repeat clicks in this tab. */ }
    sessionKeys.current.set(key, clientKey);
    try {
      const { evaluation } = await apiJson<{ evaluation: { id: string } }>('/api/evaluations', {
        method: 'POST', body: { recordingId: recording.id, clientKey, ...(scenario === 'configured' ? {} : { scenario }) },
      });
      sessionKeys.current.delete(key);
      try { sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
      navigate(`/app/evaluations/${evaluation.id}`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <form className="evaluation-action" onSubmit={submit}>
    <div>
      <h3>Avaliação simulada</h3>
      <p>Esta solicitação reserva {recording.estimatedCredits} {label}. O saldo é debitado quando o relatório fica pronto.</p>
    </div>
    <label>Cenário do simulador
      <select value={scenario} onChange={event => setScenario(event.target.value as EvaluationScenario | 'configured')} disabled={busy}>
        <option value="configured">Padrão da organização</option>
        {scenarios.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </select>
    </label>
    {error && <p className="evaluation-error" role="alert">{error}</p>}
    <button type="submit" className="button button-primary" disabled={busy}>
      {busy ? 'Enviando…' : 'Solicitar avaliação'} <ArrowRight size={16} aria-hidden="true" />
    </button>
  </form>;
}

export function EvaluationsPage() {
  const { evaluationId } = useParams();
  return <AuthenticatedArea area="learner">
    {evaluationId ? <EvaluationDetailPage key={evaluationId} id={evaluationId} /> : <EvaluationHistory />}
  </AuthenticatedArea>;
}

function EvaluationHistory() {
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ data: EvaluationList | null; error: string }>({ data: null, error: '' });

  useEffect(() => {
    const controller = new AbortController();
    apiJson<EvaluationList>(`/api/evaluations?page=${page}&pageSize=12`, { signal: controller.signal })
      .then(data => setState({ data, error: '' }))
      .catch(error => {
        if (!controller.signal.aborted) setState({ data: null, error: errorText(error) });
      });
    return () => controller.abort();
  }, [page, reload]);

  const changePage = (next: number) => {
    setState({ data: null, error: '' });
    setPage(next);
  };

  return <section className="container evaluation-page">
    <header className="evaluation-heading">
      <div><h1>Minhas avaliações</h1><p>Acompanhe o andamento e consulte seus relatórios simulados.</p></div>
      <Link className="button button-primary" to="/app/recordings">Gravar ou enviar <ArrowRight size={16} aria-hidden="true" /></Link>
    </header>
    {state.error && <div role="alert" className="evaluation-panel"><p>{state.error}</p><button className="button button-secondary" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></div>}
    {!state.data && !state.error && <p role="status">Carregando avaliações…</p>}
    {state.data && state.data.items.length === 0 && <div className="evaluation-panel">Suas avaliações vão aparecer aqui. Envie uma gravação para começar.</div>}
    {state.data && state.data.items.length > 0 && <>
      <ul className="evaluation-list">
        {state.data.items.map(item => <li key={item.id}>
          <Link to={`/app/evaluations/${item.id}`}>
            <span className="evaluation-list-icon"><ClipboardList size={21} aria-hidden="true" /></span>
            <span className="evaluation-list-title"><strong>{item.objective}</strong><small>{dateLabel(item.createdAt)} · {clock(item.durationMicroseconds)}</small></span>
            <span className={`evaluation-status evaluation-status-${item.status}`}>{statusLabels[item.status]}</span>
            <ArrowRight size={17} aria-hidden="true" />
          </Link>
        </li>)}
      </ul>
      {state.data.total > state.data.pageSize && <nav className="evaluation-pagination" aria-label="Páginas de avaliações">
        <button className="button button-secondary" disabled={page === 1} onClick={() => changePage(page - 1)}>Anterior</button>
        <span>Página {page}</span>
        <button className="button button-secondary" disabled={page * state.data.pageSize >= state.data.total} onClick={() => changePage(page + 1)}>Próxima</button>
      </nav>}
    </>}
  </section>;
}

function EvaluationDetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<EvaluationDetail | null>(null);
  const [error, setError] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let next: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const { evaluation } = await apiJson<{ evaluation: EvaluationDetail }>(`/api/evaluations/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDetail(evaluation);
        setError('');
        if (isActive(evaluation.status)) next = setTimeout(refresh, 900);
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorText(cause));
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(next); };
  }, [id, reload]);

  async function cancel() {
    if (cancelBusy) return;
    setCancelBusy(true);
    setCancelError('');
    try {
      await apiJson(`/api/evaluations/${id}/cancel`, { method: 'POST' });
    } catch (cause) {
      setCancelError(errorText(cause));
    } finally {
      setCancelBusy(false);
      setReload(value => value + 1);
    }
  }

  function seek(startUs: number) {
    const player = video.current ?? audio.current;
    if (!player) return;
    player.currentTime = startUs / 1_000_000;
    void player.play().catch(() => {});
  }

  return <section className="container evaluation-page">
    <Link className="evaluation-back" to="/app/evaluations"><ArrowLeft size={16} aria-hidden="true" /> Minhas avaliações</Link>
    {error && <div role="alert" className="evaluation-panel"><p>{error}</p><button className="button button-secondary" onClick={() => setReload(value => value + 1)}>Atualizar</button></div>}
    {!detail && !error && <p role="status">Carregando avaliação…</p>}
    {detail && <>
      <header className="evaluation-heading">
        <div>
          <h1>{detail.objective}</h1>
          <p>Simulação local · {clock(detail.durationMicroseconds)} · {dateLabel(detail.createdAt)}</p>
          {detail.activity && <p>Atividade do curso: {detail.activity.title}</p>}
          {detail.audienceScenario && <p>Cenário: {audienceLabels[detail.audienceScenario]}</p>}
        </div>
        <span className={`evaluation-status evaluation-status-${detail.status}`} role="status">{statusLabels[detail.status]}</span>
      </header>
      {isActive(detail.status) && <div className="evaluation-panel evaluation-progress">
        <Clock3 size={22} aria-hidden="true" />
        <div><h2>{detail.status === 'queued' ? 'Aguardando processamento' : 'Gerando relatório simulado'}</h2>
          <p>{detail.credits} {detail.credits === 1 ? 'crédito reservado' : 'créditos reservados'}.{detail.attempts > 0 ? ` Tentativa ${detail.attempts} de 3.` : ''}</p>
          {cancelError && <p role="alert" className="evaluation-error">{cancelError}</p>}
        </div>
        <button className="button button-secondary" onClick={() => void cancel()} disabled={cancelBusy}>{cancelBusy ? 'Cancelando…' : 'Cancelar avaliação'}</button>
      </div>}
      {detail.status === 'failed' && <div role="alert" className="evaluation-panel"><p>{detail.errorMessage}</p><Link to="/app/recordings">Voltar às gravações</Link></div>}
      {detail.status === 'cancelled' && <div role="status" className="evaluation-panel"><p>A avaliação foi cancelada e a reserva foi liberada.</p><Link to="/app/recordings">Voltar às gravações</Link></div>}
      {detail.report && <>
        <div className="evaluation-panel evaluation-player">
          {detail.hasVideo
            ? <video ref={video} src={`/api/recordings/${detail.recordingId}/media`} controls playsInline preload="metadata" aria-label="Gravação avaliada" />
            : <audio ref={audio} src={`/api/recordings/${detail.recordingId}/media`} controls preload="metadata" aria-label="Gravação avaliada" />}
        </div>
        <EvaluationReportContent detail={detail} onSeek={seek} />
      </>}
    </>}
  </section>;
}

function EvaluationReportContent({ detail, onSeek }: { detail: EvaluationDetail; onSeek: (startUs: number) => void }) {
  const report = detail.report;
  if (!report) return null;
  return <div className="evaluation-report">
    <div className="evaluation-panel evaluation-summary">
      <div>
        <h2>Relatório simulado</h2>
        <p>{report.summary}</p>
        <p>{detail.activity ? `Rubrica da atividade · versão ${report.rubricVersion.match(/:v(\d+)$/)?.[1] ?? 'registrada'}` : 'Rubrica Matraca · versão 1'}</p>
        {report.overallLevel !== null && <p><strong>Nível simulado {report.overallLevel.toLocaleString('pt-BR')}</strong> de 4</p>}
      </div>
      <button className="button button-secondary evaluation-print" onClick={() => window.print()}><Printer size={16} aria-hidden="true" /> Imprimir</button>
    </div>
    <section>
      <h2>Critérios avaliados</h2>
      <ul className="evaluation-criteria">
        {report.observations.map(observation => {
          const criterion = detail.criteria.find(item => item.id === observation.criterionId);
          return <li className="evaluation-panel" key={observation.criterionId}>
            <div className="evaluation-criterion-title">
              <h3>{criterion?.title ?? observation.criterionId}</h3>
              <span>{observation.level === null ? 'Sem nota neste formato' : `Nível ${observation.level} de 4 · peso ${criterion?.weight ?? 0}`}</span>
            </div>
            <p>{observation.rationale}</p>
            <p><strong>Próxima prática</strong> {observation.recommendation}</p>
            {observation.evidence.map((segment, index) => <button className="button button-secondary evaluation-evidence" key={index} onClick={() => onSeek(segment.startUs)}>
              <Play size={14} aria-hidden="true" /> {clock(segment.startUs)}–{clock(segment.endUs)} <span>{segment.label}</span>
            </button>)}
          </li>;
        })}
      </ul>
    </section>
    {report.strengths.length > 0 && <section className="evaluation-panel">
      <h2>Destaques simulados</h2><ul>{report.strengths.map(item => <li key={item}>{item}</li>)}</ul>
    </section>}
    <section className="evaluation-panel">
      <h2>Plano de prática</h2><ol>{report.practicePlan.map(item => <li key={item}>{item}</li>)}</ol>
    </section>
  </div>;
}
