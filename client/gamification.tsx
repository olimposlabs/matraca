import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { Award, Check, ChevronLeft, ChevronRight, Clock3, Gift, LockKeyhole, Medal, Plus, RefreshCw, Settings2, Sparkles, Trophy, Trash2, X } from 'lucide-react';
import { ApiError, apiJson } from './api';
import { AuthenticatedArea, useAuth } from './auth';
import './gamification.css';

type Metric = 'xp' | 'lesson' | 'review' | 'course';
type Group = { id: string; name: string; typeName?: string };
type BadgeRule = { id: string; name: string; metric: Metric; threshold: number };
type Policy = { points: { lesson: number; review: number; course: number }; badges: BadgeRule[] };
type PolicyView = { revision: number; policy: Policy; groups: Group[] };
type Summary = { totals: Record<Metric, number>; badges: { id: string; name: string; condition: { metric: Metric; threshold: number }; earnedAt: string }[]; leaderboardEnabled: boolean; groups: Group[]; year: number };
type Rank = { position: number; studentId: string; name: string; points: number; reachedAt: string; credits?: number | null };
type Ranking = { items: Rank[]; total: number; page: number; pageSize: number };
type Leaderboard = Ranking & { own: Rank | null; year: number; groupId: string | null };
type Prize = { position: number; credits: number };
type Campaign = { id: string; title: string; groupId: string | null; startsAt: string; endsAt: string; closedAt: string | null; prizes: Prize[]; canClose: boolean };
type CampaignDetail = { campaign: Campaign; ranking: Ranking };
type CampaignList = { items: Campaign[]; total: number; page: number; pageSize: number };
type ManagedOrg = { id: string; name: string; kind: string; status?: string; branding: Record<string, unknown> };
const number = new Intl.NumberFormat('pt-BR');
const metricNames: Record<Metric, string> = { xp: 'pontos de prática', lesson: 'aulas concluídas', review: 'revisões concluídas', course: 'cursos concluídos' };
const metricSingular: Record<Metric, string> = { xp: 'ponto de prática', lesson: 'aula concluída', review: 'revisão concluída', course: 'curso concluído' };
const eventNames = { lesson: 'Aula concluída', review: 'Revisão concluída', course: 'Curso concluído' };
const dateTime = (value: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
const messageOf = (error: unknown) => error instanceof ApiError ? error.message : 'Não foi possível concluir esta ação. Tente novamente.';
const creditLabel = (org: ManagedOrg, amount: number) => {
  const label = org.branding[amount === 1 ? 'creditSingular' : 'creditPlural'];
  return typeof label === 'string' ? label : amount === 1 ? 'crédito' : 'créditos';
};

function useResource<T>(path: string, revision = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(null);
    void apiJson<T>(path, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(problem => { if (!controller.signal.aborted) setError(messageOf(problem)); });
    return () => controller.abort();
  }, [path, revision, attempt]);
  return { data, error, retry: () => setAttempt(value => value + 1) };
}

function LoadState({ error, retry }: { error: string | null; retry: () => void }) {
  return <div className="game-empty" role="status"><RefreshCw size={26} className={error ? '' : 'spinning'} aria-hidden="true" /><p>{error ?? 'Buscando suas conquistas…'}</p>{error && <button type="button" className="button button-secondary" onClick={retry}>Tentar novamente</button>}</div>;
}

function Pagination({ page, total, pageSize, change }: { page: number; total: number; pageSize: number; change: (page: number) => void }) {
  return <div className="game-pagination"><span>{number.format(total)} {total === 1 ? 'registro' : 'registros'} · página {page}</span><div><button type="button" className="button button-secondary" disabled={page <= 1} onClick={() => change(page - 1)}><ChevronLeft size={16} aria-hidden="true" />Anterior</button><button type="button" className="button button-secondary" disabled={page * pageSize >= total} onClick={() => change(page + 1)}>Próxima<ChevronRight size={16} aria-hidden="true" /></button></div></div>;
}

function Dialog({ title, close, pending, children }: { title: string; close: () => void; pending: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="game-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!pending) close(); }}><div className="game-dialog-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Fechar janela" disabled={pending} onClick={close}><X size={21} /></button></div>{children}</dialog>;
}

export function GamificationPage({ mode = 'student' }: { mode?: 'student' | 'manage' | 'backoffice' }) {
  return <AuthenticatedArea area={mode === 'student' ? 'learner' : mode === 'backoffice' ? 'backoffice' : 'admin'}>{mode === 'student' ? <StudentAchievements /> : <GamificationManagement central={mode === 'backoffice'} />}</AuthenticatedArea>;
}

function StudentAchievements() {
  const { org } = useAuth();
  const resource = useResource<Summary>('/api/gamification');
  return <section className="game-page container"><div className="member-breadcrumb"><Link to="/app">Meu espaço</Link><ChevronRight size={14} aria-hidden="true" /><span>Conquistas</span></div><div className="game-heading"><div><span className="eyebrow">{org?.name}</span><h1>Cada prática deixa uma marca.</h1><p>Veja seu progresso, celebre suas conquistas e acompanhe sua comunidade.</p></div><span className="game-heading-icon"><Trophy size={35} strokeWidth={1.4} aria-hidden="true" /></span></div>{resource.data ? <><div className="game-totals"><article className="game-total-main"><Sparkles size={23} aria-hidden="true" /><span>Pontos de prática acumulados</span><strong>{number.format(resource.data.totals.xp)}<small>XP</small></strong><p>Seu progresso desde a primeira atividade.</p></article>{(['lesson', 'review', 'course'] as const).map(metric => <article key={metric}><span>{metricNames[metric]}</span><strong>{number.format(resource.data!.totals[metric])}</strong></article>)}</div><section className="game-section" aria-labelledby="my-badges"><div className="game-section-heading"><div><span className="eyebrow">PASSO A PASSO</span><h2 id="my-badges">Suas medalhas</h2></div><span className="game-count">{resource.data.badges.length} conquistadas</span></div>{resource.data.badges.length ? <div className="game-badges">{resource.data.badges.map(badge => <article className="game-badge" key={badge.id}><span className="game-medal"><Award size={28} strokeWidth={1.5} aria-hidden="true" /></span><div><h3>{badge.name}</h3><p>{number.format(badge.condition.threshold)} {badge.condition.threshold === 1 ? metricSingular[badge.condition.metric] : metricNames[badge.condition.metric]}</p><time dateTime={badge.earnedAt}>Conquistada em {dateTime(badge.earnedAt)}</time></div></article>)}</div> : <div className="game-empty"><Medal size={32} aria-hidden="true" /><h3>Sua primeira medalha está por vir.</h3><p>Conclua as atividades da sua trilha para construir esse mural.</p><Link className="button button-secondary" to="/app">Voltar à minha jornada</Link></div>}</section>{resource.data.leaderboardEnabled ? <StudentLeaderboard groups={resource.data.groups} initialYear={resource.data.year} /> : <section className="game-section"><div className="game-empty"><LockKeyhole size={26} aria-hidden="true" /><h2>O ranking está desativado.</h2><p>Suas conquistas pessoais continuam disponíveis nesta organização.</p></div></section>}</> : <LoadState error={resource.error} retry={resource.retry} />}</section>;
}

function StudentLeaderboard({ groups, initialYear }: { groups: Group[]; initialYear: number }) {
  const { user } = useAuth();
  const [year, setYear] = useState(initialYear); const [groupId, setGroupId] = useState(''); const [page, setPage] = useState(1);
  const query = new URLSearchParams({ year: String(year), page: String(page), pageSize: '15' });
  if (groupId) query.set('groupId', groupId);
  const resource = useResource<Leaderboard>(`/api/gamification/leaderboard?${query}`);
  return <section className="game-section" aria-labelledby="ranking-title"><div className="game-section-heading"><div><span className="eyebrow">EVOLUINDO EM COMUNIDADE</span><h2 id="ranking-title">Ranking anual</h2></div><Trophy size={24} aria-hidden="true" /></div><div className="game-filters"><label>Ano<select aria-label="Ano" value={year} onChange={event => { setYear(Number(event.target.value)); setPage(1); }}>{Array.from({ length: initialYear - 2019 }, (_, index) => initialYear - index).map(value => <option key={value}>{value}</option>)}</select></label><label>Comunidade<select aria-label="Comunidade" value={groupId} onChange={event => { setGroupId(event.target.value); setPage(1); }}><option value="">Toda a organização</option>{groups.map(group => <option key={group.id} value={group.id}>{group.typeName ? `${group.typeName} · ` : ''}{group.name}</option>)}</select></label></div><p className="game-help">Atividades concluídas no ano, pelo horário de Brasília. Em caso de empate, quem alcançou os pontos primeiro fica à frente.</p>{resource.data ? <><div className="game-own-rank"><span>Sua posição nesta comunidade</span>{resource.data.own ? <strong>{resource.data.own.position}º <small>· {number.format(resource.data.own.points)} pontos</small></strong> : <p>Conclua uma atividade que conceda pontos para aparecer aqui.</p>}</div><RankTable items={resource.data.items} ownId={user?.id} /><Pagination page={page} total={resource.data.total} pageSize={resource.data.pageSize} change={setPage} /></> : <LoadState error={resource.error} retry={resource.retry} />}</section>;
}

function RankTable({ items, ownId, org, closed = false }: { items: Rank[]; ownId?: string; org?: ManagedOrg; closed?: boolean }) {
  if (!items.length) return <div className="game-empty"><Trophy size={28} aria-hidden="true" /><p>Ainda não há participantes com pontos neste período e nesta comunidade.</p></div>;
  return <div className="game-table-wrap"><table className="game-ranks"><caption className="visually-hidden">Classificação por pontos de prática</caption><thead><tr><th scope="col">Posição</th><th scope="col">Participante</th><th scope="col">Pontos</th>{org && <th scope="col">{closed ? 'Prêmio concedido' : 'Prêmio previsto'}</th>}</tr></thead><tbody>{items.map(item => <tr key={item.studentId} className={item.studentId === ownId ? 'game-rank-own' : ''}><td><span className={`game-position ${item.position <= 3 ? 'game-podium' : ''}`}>{item.position <= 3 && <Medal size={15} aria-hidden="true" />}{item.position}º</span></td><th scope="row">{item.name}{item.studentId === ownId && <span className="game-you">Você</span>}</th><td>{number.format(item.points)}</td>{org && <td>{item.credits ? `${number.format(item.credits)} ${creditLabel(org, item.credits)}` : '—'}</td>}</tr>)}</tbody></table></div>;
}

function GamificationManagement({ central }: { central: boolean }) {
  const { org, user } = useAuth();
  if (!central && !user?.roles.includes('org_admin')) return <section className="game-page container"><div className="game-empty"><LockKeyhole size={30} aria-hidden="true" /><h1>Regras da organização</h1><p>A configuração de pontos, medalhas e campanhas é feita pelo administrador da organização.</p><Link className="button button-secondary" to="/admin">Voltar à gestão</Link></div></section>;
  return <section className="game-page container"><div className="member-breadcrumb"><Link to={central ? '/backoffice' : '/admin'}>{central ? 'Backoffice' : 'Gestão'}</Link><ChevronRight size={14} aria-hidden="true" /><span>Conquistas e campanhas</span></div><div className="game-heading"><div><span className="eyebrow">{central ? 'OPERAÇÃO MATRACA' : org?.name}</span><h1>Reconheça cada avanço.</h1><p>Defina pontos, medalhas e campanhas de incentivo para sua comunidade.</p></div><span className="game-heading-icon"><Gift size={35} strokeWidth={1.4} aria-hidden="true" /></span></div>{central ? <CentralManagement /> : org && <ManagedGamification org={org} prefix="/api/gamification/manage" />}</section>;
}

function CentralManagement() {
  const resource = useResource<{ orgs: ManagedOrg[] }>('/api/backoffice/orgs');
  const [orgId, setOrgId] = useState('');
  if (!resource.data) return <LoadState error={resource.error} retry={resource.retry} />;
  const orgs = resource.data.orgs.filter(org => org.kind !== 'backoffice' && org.status !== 'suspended');
  const org = orgs.find(item => item.id === orgId);
  return <><div className="game-org-picker"><label>Organização<select aria-label="Organização" value={orgId} onChange={event => setOrgId(event.target.value)}><option value="">Selecione uma organização</option>{orgs.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>{org ? <ManagedGamification key={org.id} org={org} prefix={`/api/backoffice/gamification/${org.id}`} /> : <div className="game-empty"><Trophy size={32} aria-hidden="true" /><h2>Escolha uma comunidade para começar.</h2><p>As regras e premiações são próprias de cada organização.</p></div>}</>;
}

function ManagedGamification({ org, prefix }: { org: ManagedOrg; prefix: string }) {
  const [tab, setTab] = useState<'campaigns' | 'policy'>('campaigns');
  const resource = useResource<PolicyView>(`${prefix}/policy`);
  return <><div className="game-tabs" aria-label="Gestão da gamificação"><button type="button" aria-pressed={tab === 'campaigns'} onClick={() => setTab('campaigns')}><Trophy size={17} aria-hidden="true" />Campanhas</button><button type="button" aria-pressed={tab === 'policy'} onClick={() => setTab('policy')}><Settings2 size={17} aria-hidden="true" />Pontos e medalhas</button></div>{resource.data ? <>{tab === 'campaigns' && <CampaignManagement prefix={prefix} org={org} groups={resource.data.groups} />}{tab === 'policy' && <PolicyEditor key={resource.data.revision} initial={resource.data} prefix={prefix} reload={resource.retry} />}</> : <LoadState error={resource.error} retry={resource.retry} />}</>;
}

function PolicyEditor({ initial, prefix, reload }: { initial: PolicyView; prefix: string; reload: () => void }) {
  const [policy, setPolicy] = useState<Policy>(() => structuredClone(initial.policy));
  const [revision, setRevision] = useState(initial.revision);
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null); const [saved, setSaved] = useState(false); const [conflict, setConflict] = useState(false);
  const busy = useRef(false);
  const change = (next: Policy) => { setPolicy(next); setSaved(false); };
  const updateBadge = (id: string, values: Partial<BadgeRule>) => change({ ...policy, badges: policy.badges.map(badge => badge.id === id ? { ...badge, ...values } : badge) });
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy.current || conflict) return; busy.current = true; setPending(true); setError(null); setSaved(false);
    try {
      const result = await apiJson<{ policy: Policy; revision: number }>(`${prefix}/policy`, { method: 'PUT', body: { policy, expectedRevision: revision } });
      setPolicy(result.policy); setRevision(result.revision); setSaved(true);
    } catch (problem) { setError(messageOf(problem)); if (problem instanceof ApiError && problem.status === 409) setConflict(true); }
    finally { busy.current = false; setPending(false); }
  }
  return <form className="game-policy" onSubmit={save}><section className="game-section"><div className="game-section-heading"><div><span className="eyebrow">RECONHECIMENTO DA PRÁTICA</span><h2>Pontos por atividade</h2></div><Sparkles size={23} aria-hidden="true" /></div><p className="game-help">Cada conclusão recebe pontos uma única vez. Alterar as regras vale para as próximas conquistas e preserva os pontos já recebidos.</p><fieldset disabled={pending || conflict} className="game-fieldset game-points">{(['lesson', 'review', 'course'] as const).map(kind => <label key={kind}>{eventNames[kind]}<span><input aria-label={eventNames[kind]} type="number" min={0} max={100000} step={1} required value={policy.points[kind]} onChange={event => change({ ...policy, points: { ...policy.points, [kind]: Number(event.target.value) } })} />XP</span></label>)}</fieldset></section><section className="game-section"><div className="game-section-heading"><div><span className="eyebrow">MARCOS DA JORNADA</span><h2>Medalhas</h2></div><span className="game-count">{policy.badges.length}/30</span></div><p className="game-help">A condição é verificada nas próximas atividades concluídas. Medalhas já conquistadas continuam no histórico, mesmo se a regra mudar ou for removida.</p><fieldset disabled={pending || conflict} className="game-fieldset"><div className="game-badge-rules">{policy.badges.map((badge, index) => <div className="game-badge-rule" key={badge.id}><span className="game-rule-icon"><Award size={23} aria-hidden="true" /></span><label>Nome da medalha<input aria-label={`Nome da medalha ${index + 1}`} required maxLength={100} value={badge.name} onChange={event => updateBadge(badge.id, { name: event.target.value })} /></label><label>Condição<select aria-label={`Condição da medalha ${index + 1}`} value={badge.metric} onChange={event => updateBadge(badge.id, { metric: event.target.value as Metric })}>{Object.entries(metricNames).map(([metric, label]) => <option key={metric} value={metric}>{label}</option>)}</select></label><label>Quantidade<input aria-label={`Quantidade da medalha ${index + 1}`} type="number" min={1} max={10000000} step={1} required value={badge.threshold} onChange={event => updateBadge(badge.id, { threshold: Number(event.target.value) })} /></label><button type="button" className="icon-button" aria-label={`Remover medalha ${badge.name || index + 1}`} onClick={() => change({ ...policy, badges: policy.badges.filter(item => item.id !== badge.id) })}><Trash2 size={18} /></button></div>)}</div>{policy.badges.length === 0 && <p className="game-help">Nenhuma medalha configurada. Adicione um marco para celebrar o progresso.</p>}<button type="button" className="button button-secondary" disabled={policy.badges.length >= 30} onClick={() => change({ ...policy, badges: [...policy.badges, { id: `badge-${crypto.randomUUID()}`, name: '', metric: 'lesson', threshold: 1 }] })}><Plus size={17} aria-hidden="true" />Adicionar medalha</button></fieldset></section>{error && <div className="form-error" role="alert">{error}{conflict && <><p>Recarregar descarta as alterações locais e traz as regras atuais.</p><button type="button" className="button button-secondary" onClick={reload}>Recarregar regras</button></>}</div>}{saved && <p className="game-notice" role="status"><Check size={18} aria-hidden="true" />Regras publicadas para as próximas conquistas.</p>}<div className="game-form-actions"><button type="submit" className="button button-primary" disabled={pending || conflict}>{pending ? 'Publicando…' : 'Publicar regras'}</button></div></form>;
}

function CampaignManagement({ prefix, org, groups }: { prefix: string; org: ManagedOrg; groups: Group[] }) {
  const [page, setPage] = useState(1); const [revision, setRevision] = useState(0); const [selectedId, setSelectedId] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  const resource = useResource<CampaignList>(`${prefix}/campaigns?page=${page}&pageSize=10`, revision);
  return <><section className="game-section"><div className="game-section-heading"><div><span className="eyebrow">UM INCENTIVO A MAIS</span><h2>Campanhas de premiação</h2></div><button type="button" className="button button-primary" onClick={() => setCreating(true)}><Plus size={17} aria-hidden="true" />Criar campanha</button></div><p className="game-help">Defina um período e uma comunidade. Ao encerrar a campanha, a classificação é registrada e os prêmios são adicionados às carteiras dos vencedores.</p>{resource.data ? <>{resource.data.items.length ? <div className="game-campaigns">{resource.data.items.map(campaign => <button type="button" key={campaign.id} className={`game-campaign ${selectedId === campaign.id ? 'selected' : ''}`} aria-pressed={selectedId === campaign.id} onClick={() => setSelectedId(campaign.id)}><span className="game-campaign-icon"><Trophy size={23} aria-hidden="true" /></span><span className="game-campaign-copy"><strong>{campaign.title}</strong><span>{dateTime(campaign.startsAt)} — {dateTime(campaign.endsAt)}</span><small>{groups.find(group => group.id === campaign.groupId)?.name ?? (campaign.groupId ? 'Comunidade da campanha' : 'Toda a organização')}</small></span><span className={`game-status ${campaign.closedAt ? 'closed' : ''}`}>{campaign.closedAt ? 'Premiada' : campaign.canClose ? 'Pronta para encerrar' : new Date(campaign.startsAt).getTime() > Date.now() ? 'Programada' : 'Em andamento'}</span><ChevronRight size={17} aria-hidden="true" /></button>)}</div> : <div className="game-empty"><Gift size={30} aria-hidden="true" /><h3>Uma nova razão para praticar.</h3><p>Crie a primeira campanha e escolha quais posições receberão prêmios.</p></div>}<Pagination page={page} total={resource.data.total} pageSize={resource.data.pageSize} change={setPage} /></> : <LoadState error={resource.error} retry={resource.retry} />}</section>{selectedId && <CampaignPanel key={selectedId} id={selectedId} prefix={prefix} org={org} groups={groups} changed={() => setRevision(value => value + 1)} />}{creating && <CampaignEditor prefix={prefix} org={org} groups={groups} close={() => setCreating(false)} created={campaign => { setCreating(false); setPage(1); setSelectedId(campaign.id); setRevision(value => value + 1); }} />}</>;
}

function CampaignPanel({ id, prefix, org, groups, changed }: { id: string; prefix: string; org: ManagedOrg; groups: Group[]; changed: () => void }) {
  const [page, setPage] = useState(1); const [revision, setRevision] = useState(0); const [confirm, setConfirm] = useState(false); const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState(false);
  const busy = useRef(false);
  const resource = useResource<CampaignDetail>(`${prefix}/campaigns/${id}?page=${page}&pageSize=15`, revision);
  async function closeCampaign() {
    if (busy.current) return; busy.current = true; setPending(true); setError(null);
    try {
      await apiJson<CampaignDetail>(`${prefix}/campaigns/${id}/close`, { method: 'POST' });
      setConfirm(false); setNotice(true); setPage(1); setRevision(value => value + 1); changed();
    } catch (problem) { setError(messageOf(problem)); }
    finally { busy.current = false; setPending(false); }
  }
  if (!resource.data) return <section className="game-section"><LoadState error={resource.error} retry={resource.retry} /></section>;
  const { campaign, ranking } = resource.data;
  const groupName = groups.find(group => group.id === campaign.groupId)?.name ?? (campaign.groupId ? 'Comunidade da campanha' : 'Toda a organização');
  return <section className="game-section game-campaign-detail" aria-label={`Campanha ${campaign.title}`}><div className="game-section-heading"><div><span className="eyebrow">{campaign.closedAt ? 'RESULTADO REGISTRADO' : 'CLASSIFICAÇÃO PARCIAL'}</span><h2>{campaign.title}</h2></div><button type="button" className="button button-secondary" onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />Atualizar</button></div><p className="game-help">{groupName} · {dateTime(campaign.startsAt)} até {dateTime(campaign.endsAt)} (Brasília). O horário final não é incluído na apuração.</p><div className="game-prizes">{campaign.prizes.map(prize => <div key={prize.position}><Medal size={22} aria-hidden="true" /><span>{prize.position}º lugar</span><strong>{number.format(prize.credits)} {creditLabel(org, prize.credits)}</strong></div>)}</div>{notice && <p className="game-notice" role="status"><Check size={18} aria-hidden="true" />Campanha encerrada. Os prêmios foram concedidos uma única vez.</p>}{campaign.closedAt ? <p className="game-help"><Check size={15} aria-hidden="true" />Resultado registrado em {dateTime(campaign.closedAt)}. Esta classificação permanece preservada.</p> : <div className="game-close-strip"><p><Clock3 size={18} aria-hidden="true" />{campaign.canClose ? 'O período terminou. Confira a classificação antes de premiar.' : 'A classificação pode mudar até a apuração. O encerramento fica disponível ao final do período.'}</p><button type="button" className="button button-primary" disabled={!campaign.canClose} onClick={() => { setError(null); setConfirm(true); }}>Encerrar e premiar</button></div>}<RankTable items={campaign.closedAt ? ranking.items : ranking.items.map(item => ({ ...item, credits: campaign.prizes.find(prize => prize.position === item.position)?.credits }))} org={org} closed={Boolean(campaign.closedAt)} /><Pagination page={page} total={ranking.total} pageSize={ranking.pageSize} change={setPage} />{confirm && <Dialog title="Encerrar e conceder prêmios" pending={pending} close={() => setConfirm(false)}><p>O resultado de <strong>{campaign.title}</strong> será registrado e os vencedores receberão os prêmios na carteira. Após o encerramento, esta classificação não será recalculada.</p><ul className="game-confirm-prizes">{campaign.prizes.map(prize => <li key={prize.position}>{prize.position}º lugar: {number.format(prize.credits)} {creditLabel(org, prize.credits)}</li>)}</ul><p className="game-help">Somente posições com participantes elegíveis recebem prêmio.</p>{error && <div className="form-error" role="alert">{error}</div>}<div className="game-form-actions"><button type="button" className="button button-secondary" disabled={pending} onClick={() => setConfirm(false)}>Voltar</button><button type="button" className="button button-primary" disabled={pending} onClick={() => void closeCampaign()}>{pending ? 'Concedendo prêmios…' : 'Confirmar encerramento'}</button></div></Dialog>}</section>;
}

function brasiliaInput(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).formatToParts(value);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function CampaignEditor({ prefix, org, groups, close, created }: { prefix: string; org: ManagedOrg; groups: Group[]; close: () => void; created: (campaign: Campaign) => void }) {
  const [title, setTitle] = useState(''); const [groupId, setGroupId] = useState('');
  const [startsAt, setStartsAt] = useState(() => brasiliaInput(new Date())); const [endsAt, setEndsAt] = useState(() => brasiliaInput(new Date(Date.now() + 7 * 86400000)));
  const [prizes, setPrizes] = useState<(Prize & { key: string })[]>(() => [3, 2, 1].map((credits, index) => ({ key: crypto.randomUUID(), position: index + 1, credits })));
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  const intent = useRef<{ fingerprint: string; clientKey: string } | null>(null); const busy = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy.current) return;
    const start = new Date(`${startsAt}:00-03:00`); const end = new Date(`${endsAt}:00-03:00`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) { setError('O fim da campanha precisa ser posterior ao início.'); return; }
    if (new Set(prizes.map(prize => prize.position)).size !== prizes.length) { setError('Cada posição deve aparecer uma única vez na premiação.'); return; }
    const body = { title: title.trim(), startsAt: start.toISOString(), endsAt: end.toISOString(), groupId: groupId || null, prizes: prizes.map(({ position, credits }) => ({ position, credits })).sort((a, b) => a.position - b.position) };
    const fingerprint = JSON.stringify(body);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, clientKey: crypto.randomUUID() };
    busy.current = true; setPending(true); setError(null);
    try { const result = await apiJson<{ campaign: Campaign }>(`${prefix}/campaigns`, { method: 'POST', body: { ...body, clientKey: intent.current.clientKey } }); created(result.campaign); }
    catch (problem) { setError(messageOf(problem)); }
    finally { busy.current = false; setPending(false); }
  }
  return <Dialog title="Nova campanha" close={close} pending={pending}><form onSubmit={submit}><fieldset className="game-fieldset game-campaign-form" disabled={pending}><label>Nome da campanha<input value={title} onChange={event => setTitle(event.target.value)} required maxLength={140} placeholder="Uma semana para soltar a voz" /></label><label>Comunidade<select aria-label="Comunidade" value={groupId} onChange={event => setGroupId(event.target.value)}><option value="">Toda a organização</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><div className="game-dates"><label>Início (Brasília)<input type="datetime-local" value={startsAt} onChange={event => setStartsAt(event.target.value)} required /></label><label>Fim (Brasília)<input type="datetime-local" value={endsAt} onChange={event => setEndsAt(event.target.value)} required min={startsAt} /></label></div><p className="game-help">A apuração inclui o início e termina imediatamente antes do horário final. Nome, período, comunidade e prêmios ficam definidos após a criação.</p><h3>Premiação</h3><div className="game-prize-inputs">{prizes.map((prize, index) => <div key={prize.key}><label>Posição<input aria-label={`Posição do prêmio ${index + 1}`} type="number" required min={1} max={100} step={1} value={prize.position} onChange={event => setPrizes(rows => rows.map(row => row.key === prize.key ? { ...row, position: Number(event.target.value) } : row))} /></label><label>{creditLabel(org, 2)}<input aria-label={`Quantidade do prêmio ${index + 1}`} type="number" required min={1} max={10000} step={1} value={prize.credits} onChange={event => setPrizes(rows => rows.map(row => row.key === prize.key ? { ...row, credits: Number(event.target.value) } : row))} /></label><button type="button" className="icon-button" aria-label={`Remover prêmio ${index + 1}`} disabled={prizes.length === 1} onClick={() => setPrizes(rows => rows.filter(row => row.key !== prize.key))}><Trash2 size={18} /></button></div>)}</div><button type="button" className="button button-secondary" disabled={prizes.length >= 100} onClick={() => { const occupied = new Set(prizes.map(prize => prize.position)); const next = Array.from({ length: 100 }, (_, index) => index + 1).find(position => !occupied.has(position))!; setPrizes(rows => [...rows, { key: crypto.randomUUID(), position: next, credits: 1 }]); }}><Plus size={17} aria-hidden="true" />Adicionar posição</button></fieldset>{error && <div className="form-error" role="alert">{error}</div>}<div className="game-form-actions"><button type="button" className="button button-secondary" disabled={pending} onClick={close}>Cancelar</button><button type="submit" className="button button-primary" disabled={pending}>{pending ? 'Criando…' : 'Criar campanha'}</button></div></form></Dialog>;
}
