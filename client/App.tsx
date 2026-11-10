import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router';
import {
  ArrowDown,
  ArrowRight,
  AudioLines,
  BookOpen,
  Check,
  ChevronRight,
  CircleCheck,
  Compass,
  Database,
  ExternalLink,
  Layers3,
  Menu,
  Mic,
  Monitor,
  RefreshCw,
  Server,
  Sparkles,
  Sprout,
  Users,
  X,
} from 'lucide-react';
import { AuthProvider, AuthenticatedArea, LoginPage, sessionHome, useAuth } from './auth';
import { apiJson } from './api';

const waveformHeights = [18, 30, 23, 42, 57, 36, 25, 48, 68, 52, 31, 44, 60, 79, 65, 43, 29, 46, 63, 48, 34, 54, 72, 49, 31, 45, 58, 35, 25, 39, 22, 14];

export function Brand() {
  const { org } = useAuth();
  const partner = org?.kind === 'partner';
  return (
    <Link className={`brand${partner ? ' tenant-brand' : ''}`} to="/" aria-label={`${partner ? org.name : 'Matraca'}, página inicial`}>
      <span className="brand-mark" aria-hidden="true"><AudioLines size={25} strokeWidth={2.4} /></span>
      <span className="brand-name">{partner ? org.name : <>matraca<span className="brand-period">.</span></>}</span>
    </Link>
  );
}

function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const { org, user } = useAuth();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <header className="site-header">
      <div className="container header-inner">
        <Brand />
        <button
          className="menu-toggle icon-button"
          type="button"
          aria-label={menuOpen ? 'Fechar navegação' : 'Abrir navegação'}
          aria-expanded={menuOpen}
          aria-controls="main-navigation"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
        <nav id="main-navigation" className={`main-navigation${menuOpen ? ' is-open' : ''}`} aria-label="Navegação principal">
          {(!org || org.kind === 'matraca') && <><a href="/#como-funciona" onClick={() => setMenuOpen(false)}>Como funciona</a><a href="/#para-escolas" onClick={() => setMenuOpen(false)}>Para escolas</a></>}
          {org?.kind === 'partner' && <span className="tenant-header-note">Seu espaço de aprendizagem</span>}
          {org?.kind === 'backoffice' && <span className="tenant-header-note">Operação Matraca</span>}
          <Link className="header-login" to={user ? sessionHome(org) : '/login'}>{user ? 'Meu espaço' : 'Entrar'} <ArrowRight size={16} aria-hidden="true" /></Link>
        </nav>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div className="footer-brand"><Brand /><p>Um espaço para a sua voz evoluir.</p></div>
        <div className="footer-meta">
          <Link to="/status"><span className="status-dot neutral" /> Status do ambiente <ExternalLink size={13} aria-hidden="true" /></Link>
          <span>Matraca · Piloto em desenvolvimento</span>
        </div>
      </div>
    </footer>
  );
}

function JourneyPreview() {
  return (
    <div className="journey-preview" aria-label="Prévia ilustrativa da jornada de aprendizagem">
      <div className="preview-orbit orbit-one" aria-hidden="true" />
      <div className="preview-orbit orbit-two" aria-hidden="true" />
      <div className="preview-note"><Sprout size={17} aria-hidden="true" /> No seu ritmo.</div>
      <div className="voice-card">
        <div className="voice-card-top"><span className="eyebrow">SEU ESPAÇO DE PRÁTICA</span><span className="preview-label">Prévia</span></div>
        <div className="voice-card-title"><span className="mic-icon"><Mic size={25} strokeWidth={1.7} /></span><div><h2>Deixe a sua ideia sair.</h2><p>Uma apresentação de cada vez.</p></div></div>
        <div className="waveform" aria-hidden="true">
          {waveformHeights.map((height, index) => <span key={index} style={{ height: `${height}px` }} />)}
        </div>
        <div className="recording-caption"><span>Exercícios curtos</span><span>Revisões completas</span></div>
        <div className="preview-divider" />
        <div className="preview-step"><span className="step-indicator step-done"><Check size={14} /></span><div><strong>Encontre o seu ponto de partida</strong><span>Seus objetivos orientam a jornada.</span></div></div>
        <div className="preview-step"><span className="step-indicator step-current"><span /></span><div><strong>Pratique com intenção</strong><span>Uma habilidade em cada exercício.</span></div></div>
        <div className="preview-step"><span className="step-indicator step-next">3</span><div><strong>Perceba a sua evolução</strong><span>Revisite a fala. Reconheça o avanço.</span></div></div>
      </div>
      <div className="preview-caption"><Sparkles size={16} aria-hidden="true" /> A próxima versão começa com você.</div>
    </div>
  );
}

function HomePage() {
  return (
    <>
      <section className="hero-section">
        <div className="container hero-grid">
          <div className="hero-copy">
            <div className="pilot-label"><span /> O SEU NOVO ESPAÇO DE ORATÓRIA</div>
            <h1>Pratique sua fala.<br />Dê espaço às<br /><span>suas ideias.</span></h1>
            <p className="hero-description">Organize o que você quer dizer, pratique apresentações e acompanhe sua evolução. Um próximo passo para cada momento da sua jornada.</p>
            <div className="hero-actions"><Link className="button button-primary" to="/login">Acessar minha área <ArrowRight size={18} aria-hidden="true" /></Link><a className="button button-text" href="#como-funciona">Conhecer a jornada <ArrowDown size={16} aria-hidden="true" /></a></div>
            <div className="hero-footnote"><span className="tiny-mark"><AudioLines size={17} /></span><span>Para quem está começando.<br /><strong>E para quem quer continuar evoluindo.</strong></span></div>
          </div>
          <JourneyPreview />
        </div>
      </section>

      <section className="journey-section section-pad" id="como-funciona">
        <div className="container">
          <div className="section-heading"><div><span className="eyebrow">DA PRIMEIRA FALA AO PRÓXIMO PASSO</span><h2>Uma jornada com direção.</h2></div><p>A prática se conecta ao que você<br className="desktop-break" /> precisa comunicar no dia a dia.</p></div>
          <div className="feature-grid">
            <article className="feature-card"><div className="feature-card-top"><span className="feature-icon icon-peach"><Compass size={23} strokeWidth={1.6} /></span><span className="feature-number">01</span></div><h3>Comece pelo seu objetivo</h3><p>Uma reunião, uma apresentação ou uma conversa importante. O seu contexto dá sentido à prática.</p><span className="feature-caption">Um ponto de partida que é seu</span></article>
            <article className="feature-card"><div className="feature-card-top"><span className="feature-icon icon-green"><Mic size={23} strokeWidth={1.6} /></span><span className="feature-number">02</span></div><h3>Experimente a sua voz</h3><p>Exercícios de fala ajudam a trabalhar clareza, estrutura e expressão, uma habilidade por vez.</p><span className="feature-caption">Espaço para ensaiar e tentar de novo</span></article>
            <article className="feature-card"><div className="feature-card-top"><span className="feature-icon icon-lilac"><BookOpen size={23} strokeWidth={1.6} /></span><span className="feature-number">03</span></div><h3>Acompanhe o caminho</h3><p>Retome suas práticas, reconheça suas conquistas e descubra onde concentrar a próxima tentativa.</p><span className="feature-caption">Cada etapa faz parte da sua evolução</span></article>
          </div>
        </div>
      </section>

      <section className="schools-section" id="para-escolas">
        <div className="container">
          <div className="schools-panel">
            <div className="schools-copy"><span className="eyebrow">PARA ESCOLAS E EMPRESAS</span><h2>O seu curso.<br />A identidade da sua escola.</h2><p>Um ambiente para conectar conteúdo, prática e acompanhamento, com a marca de quem ensina e o contexto de quem aprende.</p><Link className="button button-light" to="/admin">Conhecer a área de gestão <ArrowRight size={17} aria-hidden="true" /></Link></div>
            <div className="school-capabilities"><div><span><Layers3 size={22} strokeWidth={1.6} /></span><section><h3>Cursos e turmas organizados</h3><p>Uma estrutura para a sua metodologia.</p></section></div><div><span><Users size={22} strokeWidth={1.6} /></span><section><h3>Acompanhamento de cada aluno</h3><p>Práticas e evolução na mesma jornada.</p></section></div><div><span><Sparkles size={22} strokeWidth={1.6} /></span><section><h3>Uma experiência com a sua marca</h3><p>Identidade própria em cada organização.</p></section></div></div>
          </div>
        </div>
      </section>
    </>
  );
}

type HealthPayload = {
  status: 'ok';
  service: string;
  database: 'ok';
  mode: string;
  version: string;
};

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: HealthPayload; checkedAt: Date }
  | { kind: 'error'; message: string };

function StatusPage() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    setHealth({ kind: 'loading' });

    async function checkHealth() {
      try {
        const data = await apiJson<HealthPayload>('/api/health', { signal: controller.signal });
        if (data?.status !== 'ok' || data?.database !== 'ok' || typeof data?.service !== 'string' || typeof data?.mode !== 'string' || typeof data?.version !== 'string') {
          throw new Error('O ambiente ainda não confirmou que todos os serviços estão disponíveis.');
        }

        if (active) setHealth({ kind: 'ready', data, checkedAt: new Date() });
      } catch (error) {
        if (!active) return;
        setHealth({
          kind: 'error',
          message: controller.signal.aborted
            ? 'A consulta demorou mais que o esperado. Tente verificar novamente.'
            : error instanceof Error ? error.message : 'Não foi possível consultar o ambiente agora.',
        });
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void checkHealth();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [attempt]);

  return (
    <section className="utility-page container">
      <Link className="back-link" to="/">Matraca <ChevronRight size={14} aria-hidden="true" /> Status do ambiente</Link>
      <div className="utility-heading"><span className="eyebrow">AMBIENTE DO PILOTO</span><h1>Como está tudo por aqui.</h1><p>Esta página consulta a aplicação e a conexão com o banco de dados.</p></div>
      <div className="health-panel" aria-live="polite" aria-busy={health.kind === 'loading'}>
        <div className="health-summary">
          <span className={`health-symbol ${health.kind}`}><Server size={24} strokeWidth={1.7} /></span>
          <div><h2>{health.kind === 'ready' ? 'Ambiente disponível' : health.kind === 'loading' ? 'Verificando o ambiente' : 'Verificação indisponível'}</h2><p>{health.kind === 'ready' ? 'A aplicação respondeu e confirmou a conexão com o banco.' : health.kind === 'loading' ? 'Consultando os serviços locais do Matraca…' : health.message}</p></div>
          <button className="button button-secondary refresh-button" type="button" onClick={() => setAttempt(value => value + 1)} disabled={health.kind === 'loading'}><RefreshCw size={16} className={health.kind === 'loading' ? 'spinning' : ''} aria-hidden="true" /> Verificar novamente</button>
        </div>
        <dl className="health-details">
          <div><dt><Server size={16} aria-hidden="true" /> Aplicação</dt><dd>{health.kind === 'ready' ? <><span className="status-dot" /> {health.data.service}</> : 'Aguardando confirmação'}</dd></div>
          <div><dt><Database size={16} aria-hidden="true" /> Banco de dados</dt><dd>{health.kind === 'ready' ? <><CircleCheck size={15} /> Conectado</> : 'Aguardando confirmação'}</dd></div>
          <div><dt><Monitor size={16} aria-hidden="true" /> Ambiente</dt><dd>{health.kind === 'ready' ? health.data.mode : '—'}</dd></div>
          <div><dt><Layers3 size={16} aria-hidden="true" /> Versão</dt><dd>{health.kind === 'ready' ? health.data.version : '—'}</dd></div>
        </dl>
        <div className="health-footnote">{health.kind === 'ready' ? `Última consulta às ${new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(health.checkedAt)}.` : 'O resultado será atualizado quando uma consulta for concluída.'}</div>
      </div>
    </section>
  );
}

function NotFoundPage() {
  return (
    <section className="construction-page container"><span className="construction-label">Página não encontrada</span><h1>Vamos retomar o caminho.</h1><p>Este endereço não corresponde a uma página do Matraca.</p><Link className="button button-primary" to="/">Voltar ao início <ArrowRight size={17} aria-hidden="true" /></Link></section>
  );
}

function HomeEntry() {
  const { org } = useAuth();
  return org?.kind === 'matraca' ? <HomePage /> : <LoginPage />;
}

function AppShell() {
  const location = useLocation();

  useEffect(() => {
    const titles: Record<string, string> = {
      '/': 'Matraca — Um espaço para a sua voz',
      '/status': 'Status do ambiente — Matraca',
      '/login': 'Acesso ao piloto — Matraca',
      '/app': 'Área do aluno — Matraca',
      '/admin': 'Gestão — Matraca',
      '/backoffice': 'Backoffice — Matraca',
    };
    document.title = titles[location.pathname] ?? 'Página não encontrada — Matraca';
    if (!location.hash) window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#conteudo">Ir para o conteúdo</a>
      <SiteHeader />
      <main id="conteudo"><Routes><Route path="/" element={<HomeEntry />} /><Route path="/status" element={<StatusPage />} /><Route path="/login" element={<LoginPage />} /><Route path="/app" element={<AuthenticatedArea />} /><Route path="/admin" element={<AuthenticatedArea area="admin" />} /><Route path="/backoffice" element={<AuthenticatedArea area="backoffice" />} /><Route path="*" element={<NotFoundPage />} /></Routes></main>
      <SiteFooter />
    </div>
  );
}

export default function App() {
  return <AuthProvider><AppShell /></AuthProvider>;
}
