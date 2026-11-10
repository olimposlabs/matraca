import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, ArrowRight, AudioLines, BookOpen, Building2, Check, CircleCheck, ExternalLink, History, ImagePlus, Palette, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, Users } from 'lucide-react';
import { ApiError, apiJson } from './api';
import { AuthenticatedArea, LogoutButton, useAuth } from './auth';
import type { Organization } from './auth';

type Branding = {
  displayName: string;
  primary: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  font: 'sans' | 'serif';
  creditSingular: string;
  creditPlural: string;
  logoKey?: string;
};

type ManagedOrganization = Organization & {
  status: 'active' | 'suspended';
  hostname: string;
  portalUrl: string;
  userCount: number;
};

type BrandingRevision = { revision: number; branding: Record<string, unknown>; createdAt: string; actorId: string | null };
type ManagementResponse = { org: ManagedOrganization; brandingHistory: BrandingRevision[] };
type OrganizationSettings = { coursesEnabled: boolean; strictJourney: boolean; leaderboardEnabled: boolean; diagnosticEnabled: boolean };

const defaults: Omit<Branding, 'displayName'> = {
  primary: '#b8442b', background: '#faf8f2', surface: '#ffffff', text: '#1f2925', muted: '#59665f',
  font: 'sans', creditSingular: 'crédito', creditPlural: 'créditos',
};
const hexColor = /^#[0-9a-f]{6}$/i;

export function brandDisplayName(org: Organization | null): string {
  return typeof org?.branding.displayName === 'string' && org.branding.displayName.trim() ? org.branding.displayName : org?.name ?? 'Matraca';
}

function readBranding(org: Organization): Branding {
  const raw = org.branding;
  const color = (key: 'primary' | 'background' | 'surface' | 'text' | 'muted') => typeof raw[key] === 'string' && hexColor.test(raw[key]) ? raw[key] : defaults[key];
  return {
    displayName: brandDisplayName(org), primary: color('primary'), background: color('background'), surface: color('surface'), text: color('text'), muted: color('muted'),
    font: raw.font === 'serif' ? 'serif' : 'sans',
    creditSingular: typeof raw.creditSingular === 'string' ? raw.creditSingular : defaults.creditSingular,
    creditPlural: typeof raw.creditPlural === 'string' ? raw.creditPlural : defaults.creditPlural,
    ...(typeof raw.logoKey === 'string' && raw.logoKey ? { logoKey: raw.logoKey } : {}),
  };
}

export function organizationTheme(org: Organization | null): CSSProperties {
  if (!org) return {};
  return brandingTheme(readBranding(org));
}

function brandingTheme(branding: Branding): CSSProperties {
  const color = (value: string, fallback: string) => hexColor.test(value) ? value : fallback;
  const primary = color(branding.primary, defaults.primary);
  const background = color(branding.background, defaults.background);
  return {
    '--color-background': color(branding.background, defaults.background),
    '--color-surface': color(branding.surface, defaults.surface),
    '--color-ink': color(branding.text, defaults.text),
    '--color-muted': color(branding.muted, defaults.muted),
    '--color-primary': primary,
    '--color-accent-text': contrast(primary, background) >= 4.5 ? primary : color(branding.text, defaults.text),
    '--color-primary-hover': `color-mix(in srgb, ${color(branding.primary, defaults.primary)}, black 15%)`,
    '--color-line': `color-mix(in srgb, ${color(branding.text, defaults.text)} 16%, ${color(branding.background, defaults.background)})`,
    '--font-family': branding.font === 'serif' ? "Georgia, 'Times New Roman', serif" : "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  } as CSSProperties;
}

function readSettings(org: Organization): OrganizationSettings {
  return { coursesEnabled: org.settings.coursesEnabled !== false, strictJourney: org.settings.strictJourney === true, leaderboardEnabled: org.settings.leaderboardEnabled !== false, diagnosticEnabled: org.settings.diagnosticEnabled !== false };
}

function luminance(hex: string): number {
  const linear = [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

function brandingIssues(branding: Branding): string[] {
  const issues: string[] = [];
  if (!branding.displayName.trim()) issues.push('Informe o nome que será exibido no portal.');
  if (!branding.creditSingular.trim() || !branding.creditPlural.trim()) issues.push('Preencha o nome dos créditos no singular e no plural.');
  const colors = [branding.primary, branding.background, branding.surface, branding.text, branding.muted];
  if (colors.some(color => !hexColor.test(color))) return [...issues, 'Use cores no formato hexadecimal de seis dígitos, como #b8442b.'];
  if (contrast(branding.primary, '#ffffff') < 4.5) issues.push('Escureça a cor principal para manter os textos brancos dos botões legíveis.');
  if ([branding.background, branding.surface].some(background => contrast(branding.text, background) < 4.5)) issues.push('Ajuste a cor do texto para ter contraste suficiente com o fundo e os cartões.');
  if ([branding.background, branding.surface].some(background => contrast(branding.muted, background) < 4.5)) issues.push('Ajuste a cor do texto secundário para manter a leitura sobre o fundo e os cartões.');
  return issues;
}

function messageFrom(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Não foi possível concluir esta ação. Tente novamente.';
}

function safePortalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) ? url.origin : null;
  } catch { return null; }
}

function publishedLogo(org: ManagedOrganization): string | undefined {
  if (!org.branding.logoKey) return undefined;
  const portal = safePortalUrl(org.portalUrl);
  return portal ? `${portal}/api/branding/logo?v=${Number(org.branding._revision) || 0}` : undefined;
}

async function uploadLogo(path: string, file: File): Promise<{ logoKey: string }> {
  const data = new FormData();
  data.set('file', file);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { method: 'POST', body: data, headers: { 'x-matraca-request': '1', Accept: 'application/json' }, credentials: 'same-origin', mode: 'same-origin', signal: controller.signal });
    if (!response.ok) throw new ApiError(response.status, response.status === 413 ? 'O logo precisa ter até 2 MB.' : response.status === 415 ? 'Envie uma imagem PNG, JPEG ou WebP válida.' : 'Não foi possível enviar o logo. Confira a imagem e tente novamente.');
    const result = await response.json();
    if (typeof result?.logoKey !== 'string') throw new ApiError(0, 'O serviço não confirmou o envio do logo.');
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, 'Não foi possível enviar o logo. Verifique sua conexão e tente novamente.');
  } finally { window.clearTimeout(timeout); }
}

function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <div className="organization-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{children}</div>;
}

function LoadingPanel({ error, retry }: { error: string | null; retry: () => void }) {
  return <div className="organization-state" role="status"><RefreshCw size={25} className={error ? '' : 'spinning'} aria-hidden="true" /><h2>{error ? 'Não foi possível carregar este espaço.' : 'Carregando sua organização…'}</h2>{error && <><p>{error}</p><button className="button button-secondary" type="button" onClick={retry}>Tentar novamente</button></>}</div>;
}

export function OrganizationsPage() {
  return <AuthenticatedArea area="backoffice"><OrganizationsConsole /></AuthenticatedArea>;
}

function OrganizationsConsole() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('org');
  const [orgs, setOrgs] = useState<ManagedOrganization[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ManagedOrganization | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    if (!selected) void apiJson<{ orgs: ManagedOrganization[] }>('/api/backoffice/orgs', { signal: controller.signal }).then(result => setOrgs(result.orgs)).catch(loadError => { if (!controller.signal.aborted) setError(messageFrom(loadError)); });
    return () => controller.abort();
  }, [attempt, selected]);

  if (selected) return <OrganizationEditor organizationId={selected} back={() => setParams({})} />;
  const visible = (orgs ?? []).filter(org => `${org.name} ${org.slug}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')));

  return <section className="organization-page container">
    <PageHeading eyebrow="BACKOFFICE MATRACA" title="Cada organização, um espaço próprio." description="Crie parceiros e acompanhe os ambientes da plataforma."><div className="organization-heading-actions"><button type="button" className="button button-primary" onClick={() => setCreating(value => !value)}><Plus size={17} aria-hidden="true" />Nova organização</button><LogoutButton /></div></PageHeading>
    {created && <div className="organization-success" role="status"><CircleCheck size={20} aria-hidden="true" /><div><strong>{created.name} foi criada.</strong><p>O administrador cadastrado já pode solicitar um link de acesso no portal da organização.</p>{safePortalUrl(created.portalUrl) && <a href={safePortalUrl(created.portalUrl)!} target="_blank" rel="noreferrer">Abrir o portal <ExternalLink size={13} aria-hidden="true" /></a>}</div></div>}
    {creating && <CreateOrganization onCancel={() => setCreating(false)} onCreated={org => { setCreated(org); setCreating(false); setAttempt(value => value + 1); }} />}
    {!orgs || error ? <LoadingPanel error={error} retry={() => setAttempt(value => value + 1)} /> : <div className="organization-list-card"><div className="organization-list-toolbar"><div><h2>Organizações</h2><span>{orgs.length} {orgs.length === 1 ? 'ambiente cadastrado' : 'ambientes cadastrados'}</span></div><label className="organization-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Buscar organização</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar organização" /></label></div><div className="organization-list" role="list">{visible.map(org => <div className="organization-row" key={org.id} role="listitem"><span className="organization-row-icon"><Building2 size={23} strokeWidth={1.6} aria-hidden="true" /></span><div className="organization-row-name"><strong>{org.name}</strong><span>{org.hostname || org.slug}</span></div><span className="organization-type">{org.kind === 'matraca' ? 'Matraca direto' : org.kind === 'backoffice' ? 'Operação' : 'Parceiro white label'}</span><span className="organization-person-count"><Users size={15} aria-hidden="true" />{org.userCount ?? 0} pessoas</span><span className={`organization-status ${org.status}`}>{org.status === 'active' ? 'Ativa' : 'Suspensa'}</span><button className="button button-secondary organization-open" type="button" onClick={() => setParams({ org: org.id })} aria-label={`Gerenciar ${org.name}`}>Gerenciar <ArrowRight size={15} aria-hidden="true" /></button></div>)}</div>{visible.length === 0 && <p className="organization-empty">Nenhuma organização encontrada para esta busca.</p>}</div>}
  </section>;
}

function CreateOrganization({ onCancel, onCreated }: { onCancel: () => void; onCreated: (org: ManagedOrganization) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError(null);
    try {
      const result = await apiJson<ManagementResponse>('/api/backoffice/orgs', { method: 'POST', body: { name: name.trim(), slug: slug.trim(), adminName: adminName.trim(), adminEmail: adminEmail.trim() } });
      onCreated(result.org);
    } catch (createError) {
      setError(createError instanceof ApiError && createError.status === 409 ? 'Este endereço já está em uso. Escolha outro identificador para a organização.' : messageFrom(createError));
      setPending(false);
    }
  }

  return <form className="organization-create-panel organization-form" onSubmit={submit}><div className="form-section-heading"><span className="feature-icon icon-green"><Building2 size={23} aria-hidden="true" /></span><div><h2>Um novo parceiro começa aqui.</h2><p>Cadastre a organização e a pessoa que vai administrar o portal.</p></div></div><div className="organization-field-grid"><label>Nome da organização<input value={name} onChange={event => setName(event.target.value)} required maxLength={160} disabled={pending} placeholder="Ex.: Escola Horizonte" /></label><label>Identificador do portal<input value={slug} onChange={event => setSlug(event.target.value.toLowerCase())} required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" minLength={3} maxLength={40} disabled={pending} placeholder="escola-horizonte" autoCapitalize="none" /><small>{slug || 'sua-organizacao'}.matraca.localhost</small></label><label>Nome do administrador<input value={adminName} onChange={event => setAdminName(event.target.value)} required maxLength={120} disabled={pending} autoComplete="name" /></label><label>E-mail do administrador<input value={adminEmail} onChange={event => setAdminEmail(event.target.value)} required type="email" maxLength={254} disabled={pending} autoComplete="email" /></label></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="organization-form-actions"><button className="button button-primary" type="submit" disabled={pending}>{pending ? 'Criando organização…' : 'Criar organização'}<ArrowRight size={16} aria-hidden="true" /></button><button className="button button-text" type="button" disabled={pending} onClick={onCancel}>Cancelar</button></div></form>;
}

export function OrganizationSettingsPage() {
  return <AuthenticatedArea area="admin"><OrganizationSettingsEntry /></AuthenticatedArea>;
}

function OrganizationSettingsEntry() {
  const { user, org } = useAuth();
  if (!user?.roles.includes('org_admin')) return <section className="organization-page container"><PageHeading eyebrow={org?.name ?? 'SUA ESCOLA'} title="Seu espaço de gestão está preparado." description="O cadastro de alunos, professores, escolas e turmas será adicionado na próxima etapa do piloto."><LogoutButton /></PageHeading><div className="organization-school-placeholder"><span className="feature-icon icon-green"><Users size={26} aria-hidden="true" /></span><h2>A gestão da sua escola está em construção.</h2><p>A identidade visual e as preferências do portal são definidas pelo administrador da organização.</p><Link className="button button-secondary" to="/app">Voltar ao meu espaço <ArrowRight size={16} aria-hidden="true" /></Link></div></section>;
  return <OrganizationEditor />;
}

function OrganizationEditor({ organizationId, back }: { organizationId?: string; back?: () => void }) {
  const { org: sessionOrg, refreshOrganization } = useAuth();
  const central = Boolean(organizationId);
  const endpoint = central ? `/api/backoffice/orgs/${encodeURIComponent(organizationId!)}` : '/api/org/manage';
  const brandingEndpoint = central ? `${endpoint}/branding` : '/api/org/branding';
  const logoEndpoint = central ? `${endpoint}/logo` : '/api/org/logo';
  const [data, setData] = useState<ManagementResponse | null>(null);
  const [draft, setDraft] = useState<Branding | null>(null);
  const [settings, setSettings] = useState<OrganizationSettings | null>(null);
  const [recordName, setRecordName] = useState('');
  const [recordStatus, setRecordStatus] = useState<'active' | 'suspended'>('active');
  const [tab, setTab] = useState<'branding' | 'settings' | 'history'>('branding');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoPending, setLogoPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const accept = useCallback((result: ManagementResponse) => {
    setData(result); setDraft(readBranding(result.org)); setSettings(readSettings(result.org)); setRecordName(result.org.name); setRecordStatus(result.org.status); setConflict(false); setLogoPreview(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void apiJson<ManagementResponse>(endpoint, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { accept(result); setLoading(false); } }).catch(loadError => { if (!controller.signal.aborted) { setError(messageFrom(loadError)); setLoading(false); } });
    return () => controller.abort();
  }, [endpoint, attempt, accept]);

  useEffect(() => () => { if (logoPreview) URL.revokeObjectURL(logoPreview); }, [logoPreview]);

  async function update(path: string, method: 'PUT' | 'PATCH' | 'POST', body: unknown, success: string, kind: 'branding' | 'settings' | 'record' = 'branding') {
    if (pending || logoPending) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await apiJson<ManagementResponse>(path, { method, body });
      if (kind === 'branding') {
        setData(current => ({ ...result, org: { ...result.org, settings: current?.org.settings ?? result.org.settings } }));
        setDraft(readBranding(result.org)); setLogoPreview(null); setConflict(false);
      } else {
        setData(current => current ? { ...current, org: { ...result.org, branding: current.org.branding } } : result);
        if (kind === 'settings') setSettings(readSettings(result.org));
        else { setRecordName(result.org.name); setRecordStatus(result.org.status); }
      }
      if (result.org.id === sessionOrg?.id) await refreshOrganization();
      setNotice(success);
    } catch (updateError) {
      if (updateError instanceof ApiError && updateError.status === 409) { setConflict(true); setError('Esta configuração mudou em outro acesso. Recarregue a versão atual antes de publicar suas alterações.'); }
      else setError(messageFrom(updateError));
    } finally { setPending(false); }
  }

  async function chooseLogo(file: File | undefined) {
    if (!file || !draft) return;
    setError(null); setNotice(null);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError('Escolha um logo em PNG, JPEG ou WebP.'); return; }
    if (file.size > 2 * 1024 * 1024) { setError('O logo precisa ter até 2 MB.'); return; }
    setLogoPending(true);
    try {
      const result = await uploadLogo(logoEndpoint, file);
      setDraft(current => current ? { ...current, logoKey: result.logoKey } : current);
      setLogoPreview(URL.createObjectURL(file));
      setNotice('Logo preparado. Publique a identidade para exibi-lo no portal.');
    } catch (uploadError) { setError(messageFrom(uploadError)); }
    finally { setLogoPending(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  if (loading || !data || !draft || !settings) return <section className="organization-page container">{back && <button className="organization-back" type="button" onClick={back}><ArrowLeft size={15} aria-hidden="true" />Todas as organizações</button>}<LoadingPanel error={loading ? null : error} retry={() => setAttempt(value => value + 1)} /></section>;

  const revision = Number(data.org.branding._revision) || 0;
  const issues = brandingIssues(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(readBranding(data.org));
  const portal = safePortalUrl(data.org.portalUrl);
  const logo = draft.logoKey ? logoPreview ?? (draft.logoKey === data.org.branding.logoKey ? publishedLogo(data.org) : undefined) : undefined;
  const change = <Key extends keyof Branding>(key: Key, value: Branding[Key]) => setDraft(current => current ? { ...current, [key]: value } : current);

  return <section className="organization-page container">
    {back && <button className="organization-back" type="button" onClick={back}><ArrowLeft size={15} aria-hidden="true" />Todas as organizações</button>}
    <PageHeading eyebrow={central ? 'GESTÃO CENTRAL DA ORGANIZAÇÃO' : 'GESTÃO DA ORGANIZAÇÃO'} title={data.org.name} description="Dê identidade ao portal e escolha como a jornada vai funcionar."><div className="organization-heading-actions">{portal && <a className="button button-secondary" href={portal} target="_blank" rel="noreferrer">Abrir portal <ExternalLink size={15} aria-hidden="true" /></a>}<LogoutButton /></div></PageHeading>
    <div className="organization-context-strip"><span><Building2 size={15} aria-hidden="true" />{data.org.hostname}</span><span className={`organization-status ${data.org.status}`}>{data.org.status === 'active' ? 'Ativa' : 'Suspensa'}</span><span>Identidade publicada · versão {revision}</span></div>
    {notice && <div className="organization-inline-success" role="status"><CircleCheck size={17} aria-hidden="true" />{notice}</div>}
    {error && <div className="form-error organization-editor-error" role="alert">{error}{conflict && <button className="button button-secondary" type="button" onClick={() => { setNotice(null); setAttempt(value => value + 1); }}>Recarregar versão atual <RefreshCw size={14} aria-hidden="true" /></button>}</div>}
    <div className="organization-tabs" role="tablist" aria-label="Configurações da organização">{([{ id: 'branding', label: 'Identidade visual', icon: Palette }, { id: 'settings', label: 'Preferências', icon: Settings2 }, { id: 'history', label: 'Histórico', icon: History }] as const).map(item => <button key={item.id} id={`tab-${item.id}`} role="tab" type="button" aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} onClick={() => setTab(item.id)}><item.icon size={17} aria-hidden="true" />{item.label}</button>)}</div>

    {tab === 'branding' && <div role="tabpanel" id="panel-branding" aria-labelledby="tab-branding" className="branding-layout"><form className="organization-form branding-form" onSubmit={event => { event.preventDefault(); if (issues.length === 0) void update(brandingEndpoint, 'PUT', { branding: draft, expectedRevision: revision }, 'Identidade publicada. O portal já está usando esta versão.'); }}><div className="branding-section"><h2>A marca de quem ensina.</h2><p>As alterações aparecem na prévia. O portal muda quando você publica.</p><div className="organization-field-grid"><label>Nome exibido no portal<input value={draft.displayName} onChange={event => change('displayName', event.target.value)} required maxLength={80} disabled={pending} /></label><label>Tipografia<select value={draft.font} onChange={event => change('font', event.target.value as Branding['font'])} disabled={pending}><option value="sans">Sem serifa · contemporânea</option><option value="serif">Com serifa · editorial</option></select></label></div><div className="logo-editor"><div className="logo-editor-preview">{logo ? <img src={logo} alt="Prévia do logo" /> : <AudioLines size={32} aria-hidden="true" />}</div><div><strong>Logo da organização</strong><p>PNG, JPEG ou WebP. Até 2 MB.</p><div className="logo-editor-actions"><button type="button" className="button button-secondary" disabled={pending || logoPending} onClick={() => fileInput.current?.click()}><ImagePlus size={15} aria-hidden="true" />{logoPending ? 'Preparando…' : 'Escolher imagem'}</button>{draft.logoKey && <button type="button" className="button button-text" disabled={pending || logoPending} onClick={() => { change('logoKey', undefined); setLogoPreview(null); }}><Trash2 size={14} aria-hidden="true" />Remover</button>}</div><input ref={fileInput} className="sr-only" tabIndex={-1} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Selecionar logo" onChange={event => void chooseLogo(event.target.files?.[0])} /></div></div></div><div className="branding-section"><h2>Uma paleta que combina com você.</h2><p>Vamos manter os textos legíveis em todas as combinações.</p><div className="color-field-grid">{([{ key: 'primary', label: 'Cor principal' }, { key: 'background', label: 'Fundo da página' }, { key: 'surface', label: 'Fundo dos cartões' }, { key: 'text', label: 'Texto principal' }, { key: 'muted', label: 'Texto secundário' }] as const).map(field => <label className="color-field" key={field.key}>{field.label}<div><input type="color" aria-label={`Selecionar ${field.label.toLowerCase()}`} value={hexColor.test(draft[field.key]) ? draft[field.key] : defaults[field.key]} onChange={event => change(field.key, event.target.value)} disabled={pending} /><input aria-label={field.label} value={draft[field.key]} onChange={event => change(field.key, event.target.value)} maxLength={7} spellCheck={false} disabled={pending} /></div></label>)}</div>{issues.length > 0 ? <div className="branding-validation" role="status"><strong>Ajustes para publicar</strong><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div> : <div className="branding-contrast-ok"><ShieldCheck size={16} aria-hidden="true" />Cores com contraste adequado para leitura.</div>}</div><div className="branding-section"><h2>Como seus créditos se chamam?</h2><p>O nome muda. Cada unidade continua representando um minuto de avaliação, arredondado para cima.</p><div className="organization-field-grid"><label>Nome no singular<input value={draft.creditSingular} onChange={event => change('creditSingular', event.target.value)} required maxLength={32} disabled={pending} /></label><label>Nome no plural<input value={draft.creditPlural} onChange={event => change('creditPlural', event.target.value)} required maxLength={40} disabled={pending} /></label></div></div><div className="branding-publish"><span>{dirty ? 'Você tem alterações ainda não publicadas.' : 'Você está vendo a identidade publicada.'}</span><button type="submit" className="button button-primary" disabled={pending || logoPending || conflict || !dirty || issues.length > 0}>{pending ? 'Publicando…' : 'Publicar identidade'}<Check size={16} aria-hidden="true" /></button></div></form><aside className="branding-preview-column"><div className="branding-preview-title"><span><Palette size={16} aria-hidden="true" />Prévia em tempo real</span><small>Somente visualização</small></div><div className="branding-preview" style={brandingTheme(draft)}><div className="branding-preview-header">{logo ? <img src={logo} alt="" /> : <AudioLines size={23} aria-hidden="true" />}<strong>{draft.displayName || 'Sua organização'}</strong></div><div className="branding-preview-body"><span className="eyebrow">SEU ESPAÇO PARA EVOLUIR</span><h3>Uma nova etapa para a sua voz.</h3><p>Pratique com intenção. Dê espaço às suas ideias.</p><div className="branding-preview-card"><BookOpen size={22} aria-hidden="true" /><h4>Sua jornada começa aqui.</h4><p>Aulas, prática e conquistas no seu ritmo.</p><span className="branding-preview-button">Acessar minha jornada <ArrowRight size={15} aria-hidden="true" /></span></div><span className="branding-preview-credit">1 {draft.creditSingular || 'crédito'} · 2 {draft.creditPlural || 'créditos'}</span></div></div><p className="branding-preview-note">A prévia usa suas cores, tipografia e logo. Publique para aplicar ao portal e à área de acesso.</p></aside></div>}

    {tab === 'settings' && <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" className="organization-settings-layout"><form className="organization-form organization-settings-card" onSubmit={event => { event.preventDefault(); void update(central ? endpoint : '/api/org/settings', 'PATCH', central ? { settings } : settings, 'Preferências salvas para esta organização.', 'settings'); }}><div className="form-section-heading"><span className="feature-icon icon-green"><Settings2 size={23} aria-hidden="true" /></span><div><h2>Uma jornada do seu jeito.</h2><p>Defina as opções disponíveis no portal desta organização.</p></div></div>{([{ key: 'coursesEnabled', title: 'Cursos na plataforma', description: 'Permitir conteúdo e aulas no portal. Quando desativado, a trilha funciona como acompanhamento das práticas.' }, { key: 'strictJourney', title: 'Seguir todas as etapas', description: 'Exigir que o aluno siga a sequência completa, sem pular módulos.' }, { key: 'diagnosticEnabled', title: 'Avaliação inicial', description: 'Permitir um diagnóstico para identificar o ponto de partida de cada aluno.' }, { key: 'leaderboardEnabled', title: 'Rankings da organização', description: 'Permitir a participação nos rankings da própria organização.' }] as const).map(setting => <label className="organization-setting-toggle" key={setting.key}><span><strong>{setting.title}</strong><small>{setting.description}</small></span><input type="checkbox" checked={settings[setting.key]} disabled={pending} onChange={event => setSettings(current => current ? { ...current, [setting.key]: event.target.checked } : current)} /></label>)}<div className="organization-settings-note">As preferências ficam salvas agora. Os módulos de cursos, diagnóstico e rankings serão disponibilizados nas próximas etapas do piloto.</div><button className="button button-primary" type="submit" disabled={pending || conflict || JSON.stringify(settings) === JSON.stringify(readSettings(data.org))}>{pending ? 'Salvando…' : 'Salvar preferências'}<Check size={16} aria-hidden="true" /></button></form>{central && <form className="organization-form organization-record-card" onSubmit={event => { event.preventDefault(); void update(endpoint, 'PATCH', { name: recordName.trim(), status: recordStatus }, 'Dados da organização atualizados.', 'record'); }}><h2>Cadastro da organização</h2><p>O nome do cadastro é independente do nome exibido no portal.</p><label>Nome no cadastro<input value={recordName} onChange={event => setRecordName(event.target.value)} required maxLength={160} disabled={pending} /></label><label>Situação<select value={recordStatus} onChange={event => setRecordStatus(event.target.value as 'active' | 'suspended')} disabled={pending}><option value="active">Ativa</option><option value="suspended">Suspensa</option></select></label>{recordStatus === 'suspended' && <p className="form-notice">Enquanto estiver suspensa, a organização não permite acesso de seus usuários.</p>}<button className="button button-secondary" type="submit" disabled={pending || (recordName.trim() === data.org.name && recordStatus === data.org.status)}>Salvar cadastro<Check size={16} aria-hidden="true" /></button></form>}</div>}

    {tab === 'history' && <div role="tabpanel" id="panel-history" aria-labelledby="tab-history" className="branding-history"><div className="form-section-heading"><span className="feature-icon icon-lilac"><History size={23} aria-hidden="true" /></span><div><h2>Cada mudança tem sua história.</h2><p>Restaurar uma versão cria uma nova publicação e preserva o histórico.</p></div></div>{data.brandingHistory.length === 0 && <p className="organization-empty">A primeira publicação de identidade vai aparecer aqui.</p>}<div className="branding-history-list">{[...data.brandingHistory].sort((a, b) => b.revision - a.revision).map(entry => <div className="branding-history-row" key={entry.revision}><div className="history-color-preview" aria-hidden="true" style={{ background: typeof entry.branding.primary === 'string' && hexColor.test(entry.branding.primary) ? entry.branding.primary : defaults.primary }} /><div><strong>Versão {entry.revision}</strong><span>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.createdAt))}</span></div><span className="branding-history-name">{typeof entry.branding.displayName === 'string' ? entry.branding.displayName : data.org.name}</span>{entry.revision === revision ? <span className="organization-status active">Publicada</span> : <button type="button" className="button button-secondary" disabled={pending || conflict} onClick={() => void update(`${brandingEndpoint}/restore`, 'POST', { revision: entry.revision, expectedRevision: revision }, `A identidade da versão ${entry.revision} foi restaurada em uma nova publicação.`)}>Restaurar versão {entry.revision}<History size={15} aria-hidden="true" /></button>}</div>)}</div></div>}
  </section>;
}
