import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, BookOpen, Check, CircleCheck, LockKeyhole, RefreshCw, Save, Video } from 'lucide-react';
import type { CourseUnit } from '../server/course-model';
import { ApiError, apiJson } from './api';
import { useAuth } from './auth';
import './journey.css';

export type UnitProgress = { id: string; title: string; kind: string; checked: number[]; studiedAt: string | null; completedAt: string | null; evaluationId: string | null; locked: boolean; blockedBy: string[] };
export type CourseProgress = { enrollmentId: string; versionId: string; status: string; sequential: boolean; completedUnits: number; totalUnits: number; units: UnitProgress[] };
const message = (error: unknown) => error instanceof ApiError ? error.message : 'Não foi possível salvar o estudo. Tente novamente.';

export function useCourseProgress(enrollmentId: string | undefined) {
  const [progress, setProgress] = useState<CourseProgress | null>(null); const [error, setError] = useState<string | null>(null); const [attempt, setAttempt] = useState(0);
  useEffect(() => { setProgress(null); if (!enrollmentId) return; const controller = new AbortController(); setError(null); void apiJson<{ progress: CourseProgress }>(`/api/journey/courses/${enrollmentId}`, { signal: controller.signal }).then(result => setProgress(result.progress)).catch(loadError => { if (!controller.signal.aborted) setError(message(loadError)); }); return () => controller.abort(); }, [enrollmentId, attempt]);
  return { progress, setProgress, error, reload: () => setAttempt(value => value + 1) };
}
export function CourseProgressSummary({ progress }: { progress: CourseProgress }) {
  const percentage = progress.totalUnits > 0 ? Math.round(progress.completedUnits / progress.totalUnits * 100) : 0;
  return <div className="course-progress-summary"><span className="feature-icon icon-green">{progress.status === 'completed' ? <CircleCheck size={24} /> : <BookOpen size={24} />}</span><div><strong>{progress.status === 'completed' ? 'Você concluiu este curso.' : 'Uma prática de cada vez.'}</strong><span>{progress.completedUnits} de {progress.totalUnits} unidades concluídas · {progress.sequential ? 'Jornada sequencial' : 'Jornada adaptativa'}</span><div className="journey-progress-bar" role="progressbar" aria-label="Progresso do curso" aria-valuenow={percentage} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percentage}%` }} /></div></div><strong>{percentage}%</strong></div>;
}
export function CourseStudyPanel({ unit, progress, updated, selectUnit, creditMode }: { unit: CourseUnit; progress: CourseProgress; creditMode: 'progress' | 'acquisition'; updated: (progress: CourseProgress) => void; selectUnit: (id: string) => void }) {
  const { org } = useAuth();
  const current = progress.units.find(item => item.id === unit.id);
  const [checked, setChecked] = useState<number[]>(current?.checked ?? []); const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setChecked(current?.checked ?? []); }, [current?.checked]);
  const studied = Boolean(current?.studiedAt); const completed = Boolean(current?.completedAt); const locked = Boolean(current?.locked);
  const allChecked = unit.checklist.every((_, index) => checked.includes(index));
  const dirty = JSON.stringify([...checked].sort((a, b) => a - b)) !== JSON.stringify(current?.checked ?? []);
  const mediaQuery = new URLSearchParams({ purpose: 'course', enrollmentId: progress.enrollmentId, unitId: unit.id });
  const creditName = unit.studyCreditGrant === 1 ? typeof org?.branding.creditSingular === 'string' ? org.branding.creditSingular : 'crédito' : typeof org?.branding.creditPlural === 'string' ? org.branding.creditPlural : 'créditos';
  async function save(completeStudy: boolean) {
    if (pending || locked || studied) return; setPending(true); setError(null); setNotice(null);
    try { const result = await apiJson<{ progress: CourseProgress }>(`/api/journey/courses/${progress.enrollmentId}/study`, { method: 'PUT', body: { unitId: unit.id, checked, completeStudy } }); updated(result.progress); setNotice(completeStudy ? unit.requiresEvaluation ? 'Estudo registrado. Sua próxima etapa é a prática com avaliação.' : 'Unidade concluída. Seu progresso foi atualizado.' : 'Checklist salvo. Você pode retomar deste ponto.'); }
    catch (saveError) { setError(message(saveError)); } finally { setPending(false); }
  }
  if (!current) return <p className="form-error" role="alert">Não foi possível localizar esta unidade no seu progresso.</p>;
  if (locked) return <section className="course-study-locked"><LockKeyhole size={23} /><h3>Conclua as etapas anteriores para avançar.</h3><p>Esta unidade depende das etapas abaixo. Você pode consultar o conteúdo enquanto prepara a próxima prática.</p>{current.blockedBy.slice(0, 3).map(id => <button key={id} type="button" className="button button-secondary" onClick={() => selectUnit(id)}>{progress.units.find(item => item.id === id)?.title ?? 'Unidade anterior'}<ArrowRight size={14} /></button>)}{current.blockedBy.length > 3 && <small>Há mais {current.blockedBy.length - 3} etapas anteriores na sequência do curso.</small>}</section>;
  return <section className="course-study-panel"><div className="course-study-title"><span className="feature-icon icon-green">{completed ? <CircleCheck size={23} /> : studied ? <Check size={23} /> : <BookOpen size={23} />}</span><div><span className="eyebrow">{completed ? 'ETAPA CONCLUÍDA' : studied ? 'ESTUDO CONCLUÍDO' : 'DO CONTEÚDO PARA A PRÁTICA'}</span><h3>{completed ? 'Mais um passo na sua jornada.' : studied ? 'Agora é hora de experimentar.' : 'Confira o que você aprendeu.'}</h3></div></div>{unit.checklist.length > 0 && <div className="course-study-checklist">{unit.checklist.map((item, index) => <label key={index}><input type="checkbox" checked={checked.includes(index)} disabled={pending || studied} onChange={event => { setChecked(event.target.checked ? [...checked, index] : checked.filter(value => value !== index)); setNotice(null); }} /><span>{item}</span></label>)}</div>}{unit.checklist.length === 0 && !studied && <p>Depois de estudar o conteúdo e conferir a orientação da prática, marque esta etapa como estudada.</p>}
    {!studied && <><p className="course-study-credit-note">{creditMode === 'acquisition' ? 'Os créditos deste programa são liberados na aquisição. Este estudo registra seu progresso sem uma nova concessão.' : unit.studyCreditGrant > 0 ? `Concluir o estudo libera ${unit.studyCreditGrant} ${creditName} para a prática. Repetir este marco não repete a concessão.` : 'Esta unidade não prevê crédito adicional por estudo.'}</p><div className="course-study-actions"><button type="button" className="button button-primary" disabled={pending || !allChecked} onClick={() => void save(true)}>{pending ? 'Salvando…' : unit.requiresEvaluation ? 'Concluir estudo e preparar a prática' : 'Concluir esta unidade'}<Check size={16} /></button>{dirty && <button type="button" className="button button-secondary" disabled={pending} onClick={() => void save(false)}><Save size={15} />Salvar checklist</button>}</div>{!allChecked && <small>Confira todos os itens do checklist para concluir o estudo.</small>}</>}
    {studied && !completed && <><p>O estudo já foi registrado. Envie sua apresentação e solicite a avaliação para concluir esta unidade.</p><Link className="button button-primary" to={`/app/recordings?${mediaQuery}`}><Video size={17} />Gravar ou enviar minha prática<ArrowRight size={16} /></Link></>}
    {completed && <div className="course-study-completed"><CircleCheck size={18} /><span>Conclusão registrada em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date(current.completedAt!))}.</span>{current.evaluationId && <Link to={`/app/evaluations/${current.evaluationId}`}>Revisitar avaliação<ArrowRight size={14} /></Link>}<Link to={`/app/recordings?${mediaQuery}`}>Praticar novamente<Video size={14} /></Link><small>Uma nova avaliação usa seu saldo e mantém a conclusão já registrada.</small></div>}
    {notice && <div className="organization-inline-success" role="status"><CircleCheck size={16} />{notice}</div>}{error && <p className="form-error" role="alert">{error} Você pode tentar salvar novamente sem duplicar a recompensa.</p>}
  </section>;
}
export function StudyLoading({ error, reload }: { error: string | null; reload: () => void }) { return <div className="course-study-loading" role="status"><RefreshCw size={19} className={error ? '' : 'spinning'} /><span>{error ?? 'Consultando seu progresso para esta prática…'}</span>{error && <button type="button" className="button button-secondary" onClick={reload}>Tentar novamente</button>}</div>; }
