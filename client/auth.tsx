import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, Navigate, NavLink, useLocation, useSearchParams } from 'react-router';
import { Activity, ArrowRight, AudioLines, BookOpen, Building2, Check, ChevronRight, CircleCheck, ClipboardList, LockKeyhole, LogOut, Mail, MessageSquare, RefreshCw, Trophy, ShoppingBag, ReceiptText, UserRound, Users, Wallet, Compass, TrendingUp } from 'lucide-react';
import { ApiError, apiJson } from './api';

export type Organization = {
  id: string;
  slug: string;
  name: string;
  kind: 'matraca' | 'partner' | 'backoffice';
  settings: Record<string, unknown>;
  branding: Record<string, unknown>;
};

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  orgId: string;
};

type AuthState = {
  status: 'loading' | 'ready' | 'error';
  org: Organization | null;
  user: SessionUser | null;
  error: string | null;
};

type AuthContextValue = AuthState & {
  reload: () => void;
  refreshOrganization: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function messageFrom(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Não foi possível concluir esta ação. Tente novamente.';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', org: null, user: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  const refreshOrganization = useCallback(async () => {
    const { org } = await apiJson<{ org: Organization }>('/api/context');
    setState(current => current.org?.id === org.id ? { ...current, org } : current);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', org: null, user: null, error: null });

    async function load() {
      try {
        const [context, session] = await Promise.all([
          apiJson<{ org: Organization }>('/api/context', { signal: controller.signal }),
          apiJson<{ user: SessionUser; org: Organization }>('/api/auth/session', { signal: controller.signal }).catch(error => {
            if (error instanceof ApiError && error.status === 401) return null;
            throw error;
          }),
        ]);

        if (!context.org?.id || !context.org.name || !['matraca', 'partner', 'backoffice'].includes(context.org.kind)) {
          throw new ApiError(0, 'Não foi possível identificar a organização deste endereço.');
        }
        if (session && (!session.user?.id || !Array.isArray(session.user.roles) || session.user.orgId !== context.org.id || session.org?.id !== context.org.id)) {
          throw new ApiError(0, 'Não foi possível confirmar seu acesso a esta organização. Entre novamente.');
        }

        if (!controller.signal.aborted) setState({ status: 'ready', org: context.org, user: session?.user ?? null, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: 'error', org: null, user: null, error: messageFrom(error) });
      }
    }

    void load();
    return () => controller.abort();
  }, [attempt]);

  const logout = useCallback(async () => {
    try {
      await apiJson<void>('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    setState(current => ({ ...current, user: null }));
  }, []);

  return <AuthContext.Provider value={{ ...state, reload, refreshOrganization, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth precisa estar dentro de AuthProvider.');
  return context;
}

export function sessionHome(org: Organization | null): string {
  return org?.kind === 'backoffice' ? '/backoffice' : '/app';
}

function AccessState() {
  const { status, error, reload } = useAuth();
  return (
    <section className="access-state container" aria-live="polite" aria-busy={status === 'loading'}>
      <span className="access-state-icon"><RefreshCw size={26} className={status === 'loading' ? 'spinning' : ''} aria-hidden="true" /></span>
      <h1>{status === 'loading' ? 'Preparando seu espaço.' : 'Não foi possível abrir seu espaço.'}</h1>
      <p>{status === 'loading' ? 'Estamos confirmando a organização e o seu acesso.' : error}</p>
      {status === 'error' && <button type="button" className="button button-primary" onClick={reload}>Tentar novamente <ArrowRight size={17} aria-hidden="true" /></button>}
    </section>
  );
}

export function LoginPage() {
  const { status, org, user } = useAuth();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidLink = searchParams.get('error') === 'invalid_link';

  if (status !== 'ready' || !org) return <AccessState />;
  if (user) return <Navigate to={sessionHome(org)} replace />;

  const allowRegister = org.kind === 'matraca';
  const registering = allowRegister && mode === 'register';
  const partner = org.kind === 'partner';
  const backoffice = org.kind === 'backoffice';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await apiJson<void>(registering ? '/api/auth/register' : '/api/auth/request', {
        method: 'POST',
        body: registering ? { name: name.trim(), email: email.trim() } : { email: email.trim() },
      });
      setRequested(true);
    } catch (requestError) {
      setError(messageFrom(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="auth-page container">
      <div className="auth-story">
        <span className="eyebrow">{backoffice ? 'OPERAÇÃO MATRACA' : partner ? 'O ESPAÇO DA SUA ORGANIZAÇÃO' : 'UMA NOVA CONVERSA COMEÇA AQUI'}</span>
        <h1>{backoffice ? <>Tudo começa <br />com um bom <br /><em>acompanhamento.</em></> : <>Sua voz. <br />Seu espaço. <br /><em>Seu próximo passo.</em></>}</h1>
        <p>{backoffice ? 'Acesse o ambiente de operação da plataforma com sua conta autorizada.' : partner ? `Entre no ambiente de ${org.name} com o e-mail cadastrado pela sua organização.` : 'Um lugar para praticar sua fala e construir confiança, uma apresentação de cada vez.'}</p>
        <div className="auth-organization"><span><Building2 size={21} aria-hidden="true" /></span><div><small>Você está acessando</small><strong>{org.name}</strong></div></div>
        <div className="auth-story-note"><LockKeyhole size={16} aria-hidden="true" /><span>Seu acesso pertence a esta organização.<br />Cada espaço tem sua própria conta e jornada.</span></div>
      </div>

      <div className="auth-card">
        {requested ? (
          <div className="auth-requested" aria-live="polite">
            <span className="auth-card-icon"><Mail size={27} strokeWidth={1.6} aria-hidden="true" /></span>
            <span className="eyebrow">SOLICITAÇÃO RECEBIDA</span>
            <h2>O próximo passo está no seu e-mail.</h2>
            <p>Se o acesso estiver disponível para <strong>{email.trim()}</strong>, você receberá um link para entrar em {org.name}.</p>
            <div className="local-mail-notice"><span className="local-mail-label">E-mail simulado · Piloto local</span><p>No piloto local, consulte a mensagem com <code>npm run inbox</code>.</p><p>Abra o link da mensagem para concluir o acesso. Nenhum e-mail externo é enviado nesta etapa.</p></div>
            <button type="button" className="button button-secondary auth-full-width" onClick={() => { setRequested(false); setError(null); }}>Usar outro e-mail</button>
            <p className="auth-fine-print">O link é de uso único. Se ele expirar, solicite outro acesso.</p>
          </div>
        ) : (
          <>
            <span className="auth-card-icon"><AudioLines size={29} strokeWidth={1.8} aria-hidden="true" /></span>
            <h2>{registering ? 'Encontre seu ponto de partida.' : 'Que bom ter você por aqui.'}</h2>
            <p className="auth-card-description">{registering ? 'Crie sua conta para começar a jornada no Matraca.' : 'Entre com um link de acesso. Você não precisa de senha.'}</p>
            {allowRegister && <div className="auth-tabs" role="group" aria-label="Tipo de acesso"><button type="button" aria-pressed={!registering} disabled={pending} className={!registering ? 'active' : ''} onClick={() => { setMode('login'); setError(null); }}>Entrar</button><button type="button" aria-pressed={registering} disabled={pending} className={registering ? 'active' : ''} onClick={() => { setMode('register'); setError(null); }}>Criar conta</button></div>}
            {invalidLink && <div className="form-notice" role="status">Este link não está mais disponível ou não pertence a este endereço. Solicite um novo link para entrar.</div>}
            <form onSubmit={submit} className="auth-form">
              {registering && <label htmlFor="auth-name">Como podemos chamar você?<input id="auth-name" name="name" autoComplete="name" value={name} onChange={event => setName(event.target.value)} placeholder="Seu nome" required minLength={2} maxLength={120} disabled={pending} /></label>}
              <label htmlFor="auth-email">Seu e-mail<input id="auth-email" name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} value={email} onChange={event => setEmail(event.target.value)} placeholder="voce@exemplo.com" required maxLength={254} disabled={pending} aria-describedby={error ? 'auth-error' : undefined} /></label>
              {error && <p className="form-error" id="auth-error" role="alert">{error}</p>}
              <button type="submit" className="button button-primary auth-full-width" disabled={pending}>{pending ? <><RefreshCw size={17} className="spinning" aria-hidden="true" /> Solicitando acesso…</> : <>{registering ? 'Criar conta e receber link' : 'Receber link de acesso'} <ArrowRight size={17} aria-hidden="true" /></>}</button>
            </form>
            <p className="auth-fine-print">{partner ? 'Ainda não tem acesso? Peça o cadastro à sua escola ou ao administrador da organização.' : backoffice ? 'Este ambiente é exclusivo para a equipe autorizada do Matraca.' : 'Um link individual para acessar sua conta com segurança.'}</p>
          </>
        )}
      </div>
    </section>
  );
}

const roleNames: Record<string, string> = {
  student: 'Aluno',
  teacher: 'Professor',
  school: 'Gestão de escola',
  org_admin: 'Administrador da organização',
  operator: 'Operação Matraca',
};

export function LogoutButton() {
  const { logout } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await logout();
    } catch (logoutError) {
      setError(messageFrom(logoutError));
      setPending(false);
    }
  }

  return <div className="logout-control"><button className="button button-secondary" type="button" disabled={pending} onClick={() => void signOut()}><LogOut size={16} aria-hidden="true" />{pending ? 'Saindo…' : 'Sair da conta'}</button>{error && <p className="form-error" role="alert">{error}</p>}</div>;
}

export function WorkspaceNavigation() {
  const { user, org } = useAuth();
  const location = useLocation();
  if (!user || !/^\/(app|admin|teacher|backoffice)(\/|$)/.test(location.pathname)) return null;
  return <div className="workspace-nav-wrap"><nav className="workspace-nav container" aria-label="Navegação do seu espaço">{org?.kind !== 'backoffice' && !user.roles.includes('student') && <NavLink to="/app" end><UserRound size={16} aria-hidden="true" />Visão geral</NavLink>}{user.roles.includes('student') && <NavLink to="/app/journey"><Compass size={16} aria-hidden="true" />Minha jornada</NavLink>}{user.roles.includes('student') && <NavLink to="/app/classes"><Users size={16} aria-hidden="true" />Minhas turmas</NavLink>}{user.roles.includes('student') && org?.settings.coursesEnabled !== false && <NavLink to="/app/courses"><BookOpen size={16} aria-hidden="true" />Meus cursos</NavLink>}{user.roles.includes('student') && <NavLink to="/app/recordings"><AudioLines size={16} aria-hidden="true" />Estúdio de prática</NavLink>}{user.roles.includes('student') && <NavLink to="/app/evaluations"><ClipboardList size={16} aria-hidden="true" />Avaliações</NavLink>}{user.roles.includes('student') && <NavLink to="/app/evolution"><TrendingUp size={16} aria-hidden="true" />Evolução</NavLink>}{user.roles.includes('student') && <NavLink to="/app/mentoring"><MessageSquare size={16} aria-hidden="true" />Mentorias</NavLink>}{user.roles.includes('teacher') && <NavLink to="/teacher/mentoring"><MessageSquare size={16} aria-hidden="true" />Acompanhamento docente</NavLink>}{user.roles.some(role => role === 'org_admin' || role === 'school') && <NavLink to="/admin/mentoring"><MessageSquare size={16} aria-hidden="true" />Acompanhamento</NavLink>}{user.roles.includes('student') && <NavLink to="/app/achievements"><Trophy size={16} aria-hidden="true" />Conquistas</NavLink>}{user.roles.includes('org_admin') && <NavLink to="/admin/gamification"><Trophy size={16} aria-hidden="true" />Rankings</NavLink>}{user.roles.includes('student') && org?.kind === 'matraca' && <NavLink to="/app/store"><ShoppingBag size={16} aria-hidden="true" />Loja</NavLink>}{user.roles.includes('org_admin') && org?.kind === 'partner' && <NavLink to="/admin/billing"><ReceiptText size={16} aria-hidden="true" />Faturamento</NavLink>}{user.roles.includes('student') && <NavLink to="/app/wallet"><Wallet size={16} aria-hidden="true" />Minha carteira</NavLink>}{user.roles.includes('teacher') && <NavLink to="/teacher"><BookOpen size={16} aria-hidden="true" />Área do professor</NavLink>}{user.roles.some(role => role === 'org_admin' || role === 'school') && <NavLink to="/admin/education"><Users size={16} aria-hidden="true" />Pessoas e turmas</NavLink>}{user.roles.some(role => role === 'org_admin' || role === 'school') && <NavLink to="/admin/credits"><Wallet size={16} aria-hidden="true" />Créditos</NavLink>}{user.roles.some(role => role === 'org_admin' || role === 'school') && <NavLink to="/admin/courses"><BookOpen size={16} aria-hidden="true" />Cursos</NavLink>}{user.roles.includes('org_admin') && <NavLink to="/admin" end><Building2 size={16} aria-hidden="true" />Identidade e preferências</NavLink>}{org?.kind === 'backoffice' && user.roles.includes('operator') && <><NavLink to="/backoffice" end><Building2 size={16} aria-hidden="true" />Organizações</NavLink><NavLink to="/backoffice/operations"><Activity size={16} aria-hidden="true" />Operação</NavLink><NavLink to="/backoffice/courses"><BookOpen size={16} aria-hidden="true" />Cursos</NavLink><NavLink to="/backoffice/gamification"><Trophy size={16} aria-hidden="true" />Rankings</NavLink><NavLink to="/backoffice/credits"><Wallet size={16} aria-hidden="true" />Créditos</NavLink><NavLink to="/backoffice/commerce"><ShoppingBag size={16} aria-hidden="true" />Loja e pedidos</NavLink><NavLink to="/backoffice/billing"><ReceiptText size={16} aria-hidden="true" />Faturamento</NavLink></>}</nav></div>;
}

export function AuthenticatedArea({ area = 'student', children }: { area?: 'student' | 'admin' | 'teacher' | 'learner' | 'backoffice'; children?: ReactNode }) {
  const { status, org, user } = useAuth();
  if (status !== 'ready' || !org) return <AccessState />;
  if (!user) return <Navigate to="/login" replace />;

  const canAdmin = user.roles.some(role => role === 'org_admin' || role === 'school');
  const canOperate = org.kind === 'backoffice' && user.roles.includes('operator');
  const allowed = area === 'backoffice' ? canOperate : area === 'admin' ? canAdmin : area === 'teacher' ? user.roles.includes('teacher') : area === 'learner' ? user.roles.includes('student') : org.kind !== 'backoffice';
  if (area === 'student' && canOperate) return <Navigate to="/backoffice" replace />;

  if (!allowed) return (
    <section className="access-state container"><span className="access-state-icon"><LockKeyhole size={27} aria-hidden="true" /></span><span className="eyebrow">ACESSO RESTRITO</span><h1>Esta área tem outro perfil de acesso.</h1><p>Sua conta está conectada a {org.name}, mas não tem permissão para acessar esta área.</p><div className="access-state-actions">{(org.kind !== 'backoffice' || canOperate) && <Link className="button button-primary" to={sessionHome(org)}>Ir para meu espaço <ArrowRight size={17} aria-hidden="true" /></Link>}<LogoutButton /></div></section>
  );

  if (children) return children;

  const management = area !== 'student';
  const heading = area === 'backoffice' ? 'Um espaço para cuidar de cada jornada.' : area === 'admin' ? 'Acompanhe quem aprende com você.' : 'Sua voz já tem um lugar aqui.';

  return (
    <section className="member-page container">
      <div className="member-breadcrumb"><Link to={sessionHome(org)}>Meu espaço</Link><ChevronRight size={14} aria-hidden="true" /><span>{area === 'backoffice' ? 'Backoffice' : area === 'admin' ? 'Gestão' : 'Visão geral'}</span></div>
      <div className="member-heading"><div><span className="eyebrow">{org.name}</span><h1>Olá, {user.name.split(' ')[0]}.</h1><p>{heading}</p></div><LogoutButton /></div>
      <div className="member-grid">
        <article className="member-identity"><span className="member-avatar"><UserRound size={28} strokeWidth={1.6} aria-hidden="true" /></span><h2>{user.name}</h2><p>{user.email}</p><div className="role-tags">{user.roles.map(role => <span key={role}>{roleNames[role] ?? 'Perfil da organização'}</span>)}</div><div className="identity-divider" /><span className="member-org-label">Organização atual</span><strong className="member-org-name"><Building2 size={16} aria-hidden="true" />{org.name}</strong><span className="session-confirmation"><CircleCheck size={14} aria-hidden="true" />Acesso confirmado</span><p className="member-isolation-note">Seu perfil e sua jornada ficam separados dos seus acessos em outras organizações.</p></article>
        <div className="member-main">
          <div className="education-dashboard-links">{user.roles.includes('student') && org.settings.coursesEnabled !== false && <Link to="/app/courses"><BookOpen size={20} /><span><strong>Meus cursos</strong><small>Conteúdo, práticas e referências da sua jornada.</small></span><ArrowRight size={17} /></Link>}{canAdmin && <Link to="/admin/courses"><BookOpen size={20} /><span><strong>Cursos e programas</strong><small>{user.roles.includes('org_admin') ? 'Monte a metodologia e publique para seus alunos.' : 'Atribua os programas da organização à sua escola.'}</small></span><ArrowRight size={17} /></Link>}{user.roles.includes('student') && <Link to="/app/wallet"><Wallet size={20} /><span><strong>Minha carteira</strong><small>Saldo disponível, recebimentos e histórico de consumo.</small></span><ArrowRight size={17} /></Link>}{canAdmin && <Link to="/admin/credits"><Wallet size={20} /><span><strong>Gestão de créditos</strong><small>Carteiras, concessões e limites das escolas.</small></span><ArrowRight size={17} /></Link>}{user.roles.includes('student') && <Link to="/app/classes"><Users size={20} /><span><strong>Minhas turmas e escolas</strong><small>Acompanhe seus vínculos e seu histórico.</small></span><ArrowRight size={17} /></Link>}{user.roles.includes('teacher') && <Link to="/teacher"><BookOpen size={20} /><span><strong>Minha área de professor</strong><small>Turmas e alunos atribuídos a você.</small></span><ArrowRight size={17} /></Link>}{canAdmin && <Link to="/admin/education"><Users size={20} /><span><strong>Pessoas e turmas</strong><small>Cadastros, vínculos e gestão escolar.</small></span><ArrowRight size={17} /></Link>}</div>
          {user.roles.includes('teacher') && <Link className="member-management-link" to="/teacher/mentoring">
            <span><MessageSquare size={17} aria-hidden="true" />Consulte mentorias e planos dos seus alunos.</span>
            <span>Abrir mentorias <ArrowRight size={16} aria-hidden="true" /></span>
          </Link>}
          {canAdmin && <Link className="member-management-link" to="/admin/mentoring">
            <span><MessageSquare size={17} aria-hidden="true" />Acompanhe a evolução dos alunos.</span>
            <span>Abrir acompanhamento <ArrowRight size={16} aria-hidden="true" /></span>
          </Link>}
          {area === 'student' && canAdmin && <Link className="member-management-link" to="/admin"><span><Check size={17} aria-hidden="true" />Você também tem acesso à gestão.</span><span>Abrir gestão <ArrowRight size={16} aria-hidden="true" /></span></Link>}
          {area === 'admin' && <Link className="button button-text" to="/app">Voltar ao meu espaço <ArrowRight size={16} aria-hidden="true" /></Link>}
        </div>
      </div>
    </section>
  );
}
