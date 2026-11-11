import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, ArrowRight, AudioLines, Camera, Check, ChevronRight, Clock3, Download, FileAudio, Headphones, Mic, MonitorPlay, RefreshCw, ShieldCheck, Square, Trash2, Upload, Video, X } from 'lucide-react';
import { apiJson, ApiError } from './api';
import { useAuth } from './auth';
import './recordings.css';

type Scenario = 'one_on_one' | 'executive' | 'audience';
type Purpose = 'free' | 'diagnostic' | 'course';
type Phase = 'idle' | 'requesting' | 'ready' | 'recording' | 'stopping' | 'preview' | 'uploading';
export interface RecordingView {
  id: string; studentId: string; filename: string; mimeType: string; byteLength: number;
  durationMicroseconds: number; hasAudio: boolean; hasVideo: boolean; objective: string;
  purpose: Purpose; enrollmentId: string | null; versionId: string | null; unitId: string | null;
  scenario: Scenario; maximumSeconds: number; source: 'upload' | 'capture'; createdAt: string; estimatedCredits: number;
}
interface Options {
  constraints: { maximumBytes: number; maximumSeconds: number; acceptedMedia: ('audio' | 'video')[] };
  scenario: Scenario; unit: { id: string; title: string } | null;
}
interface RecordingList { items: RecordingView[]; total: number; page: number; pageSize: number }
interface StudioProps { purpose: Purpose; enrollmentId: string; unitId: string; renderActions?: (recording: RecordingView) => ReactNode }
const scenarios: Record<Scenario, { title: string; description: string; prompt: string }> = {
  one_on_one: { title: 'Uma conversa', description: 'Uma pessoa, atenção por inteiro.', prompt: 'Imagine que você está explicando sua ideia a alguém que acabou de conhecer.' },
  executive: { title: 'Reunião executiva', description: 'Uma mesa. Seis perspectivas.', prompt: 'Apresente uma proposta para seis colegas. Dê contexto, um argumento e um próximo passo.' },
  audience: { title: 'Grande plateia', description: 'Sua mensagem alcança mais longe.', prompt: 'Imagine um auditório cheio. Faça uma abertura clara e convide o público a acompanhar sua ideia.' },
};
const clock = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const durationLabel = (seconds: number) => seconds < 60 ? `${Math.ceil(seconds)} segundos` : `${Math.floor(seconds / 60)} min${seconds % 60 >= 1 ? ` ${Math.ceil(seconds % 60)} s` : ''}`;
const message = (error: unknown) => error instanceof Error ? error.message : 'Não foi possível concluir esta ação. Tente novamente.';

function deviceError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (['NotAllowedError', 'SecurityError'].includes(name)) return 'O acesso foi recusado. Libere câmera ou microfone nas permissões deste site e tente novamente. Você também pode selecionar um arquivo.';
  if (['NotFoundError', 'DevicesNotFoundError'].includes(name)) return 'Não encontramos o dispositivo solicitado. Confira as conexões ou selecione um arquivo para continuar.';
  if (['NotReadableError', 'TrackStartError'].includes(name)) return 'O dispositivo está indisponível. Feche outros aplicativos que estejam usando a câmera ou o microfone e tente novamente.';
  if (name === 'OverconstrainedError') return 'O dispositivo escolhido não está disponível. Selecione a opção padrão e tente novamente.';
  return 'Não foi possível iniciar a captura. Confira seus dispositivos ou selecione um arquivo.';
}
function supportedMime(mode: 'audio' | 'video'): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const choices = mode === 'video'
    ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return choices.find(type => MediaRecorder.isTypeSupported(type));
}

function Scene({ scenario: selected }: { scenario: Scenario }) {
  const count = selected === 'one_on_one' ? 1 : selected === 'executive' ? 6 : 45;
  return <div className={`studio-scene studio-scene-${selected}`} aria-hidden="true">
    <div className="studio-scene-window" /><div className="studio-scene-light" />
    <div className="studio-scene-people">{Array.from({ length: count }, (_, index) => <span key={index} className={`scene-person person-${index % 4}`}><i /><b /></span>)}</div>
    {selected === 'executive' && <div className="studio-scene-table" />}
    {selected === 'audience' && <div className="studio-scene-stage" />}
  </div>;
}

export function RecordingPlayer({ recording }: { recording: RecordingView }) {
  const [error, setError] = useState(false);
  const path = `/api/recordings/${encodeURIComponent(recording.id)}/media`;
  useEffect(() => setError(false), [recording.id]);
  return <div className="recording-player">
    {recording.hasVideo ? <video key={recording.id} src={path} controls playsInline preload="metadata" onError={() => setError(true)} aria-label="Reprodução da gravação" />
      : <div className="recording-audio-player"><span><AudioLines size={42} aria-hidden="true" /></span><audio key={recording.id} src={path} controls preload="metadata" onError={() => setError(true)} aria-label="Reprodução do áudio" /></div>}
    {error && <p className="form-error" role="alert">Não foi possível reproduzir esta gravação. Confira seu acesso ou tente o download.</p>}
    <div className="recording-player-meta"><span><Clock3 size={14} aria-hidden="true" />{durationLabel(recording.durationMicroseconds / 1_000_000)}</span><span>{(recording.byteLength / (1024 * 1024)).toFixed(1)} MB</span><a href={path} download={recording.filename}><Download size={14} aria-hidden="true" />Baixar arquivo</a></div>
  </div>;
}

export function RecordingsPage({ renderActions }: { renderActions?: (recording: RecordingView) => ReactNode }) {
  const [params] = useSearchParams();
  const requested = params.get('purpose');
  const purpose: Purpose = requested === 'course' || requested === 'diagnostic' ? requested : 'free';
  const enrollmentId = params.get('enrollmentId') ?? '', unitId = params.get('unitId') ?? '';
  return <RecordingStudio key={`${purpose}:${enrollmentId}:${unitId}`} purpose={purpose} enrollmentId={enrollmentId} unitId={unitId} renderActions={renderActions} />;
}

function RecordingStudio({ purpose, enrollmentId, unitId, renderActions }: StudioProps) {
  const { org, user } = useAuth();
  const [options, setOptions] = useState<Options | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [objective, setObjective] = useState('');
  const [selectedScenario, setScenario] = useState<Scenario>('one_on_one');
  const [mode, setMode] = useState<'video' | 'audio'>('video');
  const [phase, setPhase] = useState<Phase>('idle');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioId, setAudioId] = useState('');
  const [videoId, setVideoId] = useState('');
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<'upload' | 'capture'>('upload');
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewSeconds, setPreviewSeconds] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecordingView | null>(null);
  const [list, setList] = useState<RecordingList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [listRevision, setListRevision] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const selectedRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestRef = useRef<XMLHttpRequest | null>(null);
  const alive = useRef(true);
  const attempt = useRef(0);
  const startedAt = useRef(0);
  const preferenceKey = `matraca:recording-devices:${org?.id ?? ''}:${user?.id ?? ''}`;
  const busy = ['requesting', 'recording', 'stopping', 'uploading'].includes(phase);
  const plural = typeof org?.branding.creditPlural === 'string' ? org.branding.creditPlural : 'créditos';
  const singular = typeof org?.branding.creditSingular === 'string' ? org.branding.creditSingular : 'crédito';
  const allowed = options?.constraints.acceptedMedia ?? ['audio', 'video'];
  const captureSupported = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const tooLong = previewSeconds !== null && options !== null && previewSeconds > options.constraints.maximumSeconds;
  const previewAudio = file?.type.startsWith('audio/') || /\.(wav|mp3|m4a)$/i.test(file?.name ?? '');

  const releaseDevices = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    setLiveStream(null); setLevel(0);
  }, []);
  const reset = useCallback(() => {
    attempt.current += 1;
    const recorder = recorderRef.current;
    if (recorder) { recorder.onstop = null; recorder.ondataavailable = null; if (recorder.state !== 'inactive') recorder.stop(); }
    recorderRef.current = null;
    releaseDevices(); setFile(null); setPreviewSeconds(null); setElapsed(0); setPhase('idle'); setError(null); setNotice(null);
    if (fileRef.current) fileRef.current.value = '';
  }, [releaseDevices]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; attempt.current += 1; requestRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder) { recorder.onstop = null; recorder.ondataavailable = null; if (recorder.state !== 'inactive') recorder.stop(); }
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setOptions(null); setOptionsError(null);
    const query = new URLSearchParams({ purpose, ...(purpose === 'course' ? { enrollmentId, unitId } : {}) });
    void apiJson<Options>(`/api/recordings/options?${query}`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setOptions(value); setScenario(value.scenario); if (!value.constraints.acceptedMedia.includes('video')) setMode('audio'); }
    }).catch(problem => { if (!controller.signal.aborted) setOptionsError(message(problem)); });
    return () => controller.abort();
  }, [purpose, enrollmentId, unitId, reload]);
  useEffect(() => {
    const controller = new AbortController(); setListError(null);
    void apiJson<RecordingList>(`/api/recordings?page=${page}&pageSize=6`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setList(value); }).catch(problem => { if (!controller.signal.aborted) setListError(message(problem)); });
    return () => controller.abort();
  }, [page, listRevision]);
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}') as Record<string, unknown>; if (typeof saved.audio === 'string') setAudioId(saved.audio); if (typeof saved.video === 'string') setVideoId(saved.video); } catch { /* Device choice remains optional when local storage is unavailable. */ }
  }, [preferenceKey]);
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let active = true;
    const enumerate = () => { void media.enumerateDevices().then(items => { if (active) setDevices(items); }).catch(() => {}); };
    enumerate(); media.addEventListener('devicechange', enumerate);
    return () => { active = false; media.removeEventListener('devicechange', enumerate); };
  }, []);
  useEffect(() => {
    if (!file) { setPreviewUrl(''); return; }
    const url = URL.createObjectURL(file); setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => { if (videoRef.current) videoRef.current.srcObject = liveStream; }, [liveStream]);
  useEffect(() => {
    if (selected) selectedRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }, [selected]);
  useEffect(() => {
    if (!liveStream || typeof AudioContext === 'undefined') return;
    const context = new AudioContext();
    const analyser = context.createAnalyser(); analyser.fftSize = 256;
    context.createMediaStreamSource(liveStream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize); let frame = 0;
    const measure = () => { analyser.getByteTimeDomainData(samples); let sum = 0; for (const sample of samples) sum += ((sample - 128) / 128) ** 2; setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4)); frame = requestAnimationFrame(measure); };
    void context.resume().catch(() => {}); measure();
    return () => { cancelAnimationFrame(frame); void context.close().catch(() => {}); };
  }, [liveStream]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') { setPhase('stopping'); recorder.stop(); }
  }, []);
  useEffect(() => {
    if (phase !== 'recording' || !options) return;
    const timer = window.setInterval(() => {
      const seconds = (performance.now() - startedAt.current) / 1000; setElapsed(seconds);
      // Stop slightly before the published ceiling; the server still measures the final file.
      if (seconds >= Math.max(0.2, options.constraints.maximumSeconds - 0.75)) { stop(); setNotice('A gravação foi encerrada ao atingir o tempo de prática.'); }
    }, 100);
    return () => window.clearInterval(timer);
  }, [phase, options, stop]);
  useEffect(() => {
    if (phase === 'idle' || (!file && phase !== 'recording' && phase !== 'uploading')) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [phase, file]);

  async function activateDevices(nextAudio = audioId, nextVideo = videoId) {
    if (!captureSupported) { setError('Este navegador não oferece captura. Selecione um arquivo para continuar.'); return; }
    const token = ++attempt.current; releaseDevices(); setError(null); setNotice(null); setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: nextAudio ? { deviceId: { exact: nextAudio } } : true,
        video: mode === 'video' ? { ...(nextVideo ? { deviceId: { exact: nextVideo } } : { facingMode: 'user' }), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 25, max: 30 } } : false,
      });
      if (!alive.current || token !== attempt.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream; setLiveStream(stream); setPhase('ready');
      try { setDevices(await navigator.mediaDevices.enumerateDevices()); } catch { setDevices([]); }
      try { localStorage.setItem(preferenceKey, JSON.stringify({ audio: nextAudio, video: nextVideo })); } catch { /* Capture works without storing preferences. */ }
    } catch (problem) { if (alive.current && token === attempt.current) { setError(deviceError(problem)); setPhase('idle'); } }
  }
  function start() {
    if (!options || !streamRef.current) return;
    const mimeType = supportedMime(mode);
    if (!mimeType) { setError('Não encontramos um formato de captura compatível neste navegador. Selecione um arquivo MP4, WebM, WAV ou MP3.'); return; }
    setError(null); setNotice(null); setFile(null); setPreviewSeconds(null); setElapsed(0);
    try {
      const recorder = new MediaRecorder(streamRef.current, { mimeType, audioBitsPerSecond: 96_000, ...(mode === 'video' ? { videoBitsPerSecond: 1_500_000 } : {}) });
      const chunks: Blob[] = []; let bytes = 0, failed = false; recorderRef.current = recorder;
      recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); bytes += event.data.size; } if (bytes > options.constraints.maximumBytes - 1024 * 1024 && recorder.state === 'recording') { setNotice('A gravação chegou ao limite de tamanho. Confira a prévia antes de enviar.'); stop(); } };
      recorder.onerror = () => { failed = true; setError('A gravação foi interrompida pelo dispositivo. Tente novamente ou selecione um arquivo.'); if (recorder.state !== 'inactive') recorder.stop(); };
      recorder.onstop = () => {
        if (!alive.current) return;
        const seconds = (performance.now() - startedAt.current) / 1000;
        releaseDevices(); recorderRef.current = null;
        if (failed || !bytes) { setPhase('idle'); if (!failed) setError('Não foi possível captar conteúdo. Confira o microfone e tente novamente.'); return; }
        const type = recorder.mimeType || mimeType, extension = type.includes('mp4') ? 'mp4' : 'webm';
        setFile(new File(chunks, `minha-pratica-${Date.now()}.${extension}`, { type })); setSource('capture'); setPreviewSeconds(seconds); setPhase('preview');
      };
      startedAt.current = performance.now(); recorder.start(250); setPhase('recording');
    } catch (problem) { setError(deviceError(problem)); releaseDevices(); setPhase('idle'); }
  }
  function pickFile(value: File | undefined) {
    if (!value || !options) return;
    reset();
    if (!value.size) { setError('O arquivo selecionado está vazio.'); return; }
    if (value.size > options.constraints.maximumBytes) { setError('Selecione um arquivo de até 200 MB.'); return; }
    if (!/\.(mp4|m4a|webm|wav|mp3)$/i.test(value.name) && !/^(audio|video)\/(mp4|webm|wav|x-wav|mpeg)$/.test(value.type)) { setError('Selecione uma gravação MP4, WebM, WAV ou MP3.'); return; }
    setFile(value); setSource('upload'); setPhase('preview');
  }
  async function upload() {
    if (!file || !options || busy || requestRef.current || tooLong || purpose === 'free' && !objective.trim()) return;
    setPhase('uploading'); setError(null); setNotice(null); setUploadProgress(0);
    const body = new FormData();
    body.append('metadata', JSON.stringify({ purpose, source, scenario: selectedScenario, ...(objective.trim() ? { objective: objective.trim() } : {}), ...(purpose === 'course' ? { enrollmentId, unitId } : {}) }));
    body.append('file', file, file.name);
    const xhr = new XMLHttpRequest(); requestRef.current = xhr;
    try {
      const saved = await new Promise<RecordingView>((resolve, reject) => {
        xhr.open('POST', '/api/recordings'); xhr.setRequestHeader('x-matraca-request', '1'); xhr.timeout = 600_000;
        xhr.upload.onprogress = event => { if (alive.current && event.lengthComputable) setUploadProgress(Math.round(event.loaded / event.total * 100)); };
        xhr.onload = () => { let data: { error?: string; recording?: RecordingView }; try { data = JSON.parse(xhr.responseText); } catch { reject(new Error('Não foi possível confirmar o envio. Atualize o histórico antes de tentar novamente.')); return; }
          if (xhr.status === 201 && data.recording?.id) resolve(data.recording); else reject(new ApiError(xhr.status, typeof data.error === 'string' && data.error.length <= 500 ? data.error : 'Não foi possível salvar a gravação. Tente novamente.')); };
        xhr.onerror = () => reject(new Error('A conexão foi interrompida. Confira seu histórico antes de tentar enviar novamente.'));
        xhr.ontimeout = () => reject(new Error('O envio demorou além do esperado. Confira seu histórico antes de tentar novamente.'));
        xhr.onabort = () => reject(new DOMException('Envio cancelado', 'AbortError'));
        xhr.send(body);
      });
      if (alive.current) { reset(); setSelected(saved); setNotice('Gravação salva. Você já pode ouvir ou assistir à sua prática.'); setPage(1); setListRevision(value => value + 1); }
    } catch (problem) {
      if (alive.current) { setPhase('preview'); if (problem instanceof DOMException && problem.name === 'AbortError') setNotice('Envio cancelado. Sua prévia continua neste dispositivo.'); else { setError(message(problem)); setListRevision(value => value + 1); } }
    } finally { if (requestRef.current === xhr) requestRef.current = null; }
  }
  function updateDuration(value: number) { if (Number.isFinite(value) && value > 0) setPreviewSeconds(value); }

  return <section className="recordings-page container">
    <div className="member-breadcrumb"><Link to="/app">Meu espaço</Link><ChevronRight size={14} aria-hidden="true" /><span>Estúdio de prática</span></div>
    <header className="studio-heading"><div><span className="eyebrow">UM PASSO DE CADA VEZ</span><h1>{purpose === 'diagnostic' ? 'Toda jornada começa com a sua voz.' : 'Um espaço para ensaiar.'}</h1><p>{options?.unit ? options.unit.title : 'Escolha um cenário, organize sua ideia e experimente dizê-la em voz alta.'}</p></div><Link to="/app/wallet" className="button button-secondary">Minha carteira <ArrowRight size={16} aria-hidden="true" /></Link></header>
    <div className="studio-purpose-links"><Link aria-current={purpose === 'free' ? 'page' : undefined} to="/app/recordings">Prática livre</Link>{org?.settings.diagnosticEnabled !== false && <Link aria-current={purpose === 'diagnostic' ? 'page' : undefined} to="/app/recordings?purpose=diagnostic">Primeiro diagnóstico</Link>}{purpose === 'course' && <span>Atividade do curso</span>}</div>
    {optionsError && <div className="form-error studio-load-error" role="alert"><span>{optionsError}</span><button type="button" className="button button-secondary" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></div>}
    {!options && !optionsError && <p className="studio-loading" role="status"><RefreshCw className="spinning" size={16} aria-hidden="true" />Preparando sua atividade…</p>}
    {options && <div className="studio-layout">
      <aside className="studio-settings">
        <span className="eyebrow">01 · PREPARE SUA FALA</span><h2>Qual é a sua intenção?</h2>
        <label className="studio-field" htmlFor="recording-objective">Objetivo {purpose !== 'free' && <small>(opcional)</small>}<textarea id="recording-objective" value={objective} maxLength={2000} disabled={busy} onChange={event => setObjective(event.target.value)} placeholder={purpose === 'free' ? 'Ex.: apresentar uma proposta de forma clara e objetiva.' : 'Você pode acrescentar um objetivo pessoal para esta prática.'} rows={4} required={purpose === 'free'} /></label>
        <fieldset className="studio-scenario-picker" disabled={busy || purpose === 'course'}><legend>Imagine seu público</legend>{(Object.keys(scenarios) as Scenario[]).map(value => <label key={value} className={selectedScenario === value ? 'selected' : ''}><input type="radio" name="scenario" value={value} checked={selectedScenario === value} onChange={() => setScenario(value)} /><span><strong>{scenarios[value].title}</strong><small>{scenarios[value].description}</small></span><Check size={15} aria-hidden="true" /></label>)}</fieldset>
        <div className="studio-limits"><Clock3 size={18} aria-hidden="true" /><div><strong>Até {durationLabel(options.constraints.maximumSeconds)}</strong><p>Áudio ou vídeo conforme a atividade.<br />Arquivo de até 200 MB.</p></div></div>
        <p className="studio-private"><ShieldCheck size={16} aria-hidden="true" />Sua gravação pertence ao seu espaço e ao acompanhamento autorizado.</p>
      </aside>
      <div className="studio-main">
        <div className="studio-main-top"><span className="eyebrow">02 · PRATIQUE NO SEU RITMO</span><div className="studio-mode" role="group" aria-label="Formato de captura">{allowed.includes('video') && <button type="button" aria-pressed={mode === 'video'} disabled={busy} onClick={() => { reset(); setMode('video'); }}><Video size={15} aria-hidden="true" />Vídeo</button>}{allowed.includes('audio') && <button type="button" aria-pressed={mode === 'audio'} disabled={busy} onClick={() => { reset(); setMode('audio'); }}><Mic size={15} aria-hidden="true" />Áudio</button>}</div></div>
        <div className={`studio-stage ${file ? 'has-preview' : ''}`}>
          {file && previewUrl ? <div className="studio-local-preview">{previewAudio ? <div className="studio-local-audio"><AudioLines size={52} aria-hidden="true" /><audio src={previewUrl} controls onLoadedMetadata={event => updateDuration(event.currentTarget.duration)} onDurationChange={event => updateDuration(event.currentTarget.duration)} aria-label="Prévia do áudio" /></div> : <video src={previewUrl} controls playsInline onLoadedMetadata={event => updateDuration(event.currentTarget.duration)} onDurationChange={event => updateDuration(event.currentTarget.duration)} aria-label="Prévia da gravação" />}</div>
            : <><Scene scenario={selectedScenario} /><div className="studio-scene-caption"><span>Cenário de prática</span><h3>{scenarios[selectedScenario].title}</h3><p>{scenarios[selectedScenario].prompt}</p></div><div className="studio-scene-note">Ambientação ilustrativa</div></>}
          {!file && liveStream && <div className={`studio-self-preview ${mode === 'audio' ? 'audio-only' : ''}`}>{mode === 'video' ? <video ref={videoRef} autoPlay muted playsInline aria-label="Prévia ao vivo da câmera" /> : <><Mic size={28} aria-hidden="true" /><span>Microfone conectado</span></>}</div>}
          {!file && <div className={`studio-timer ${phase === 'recording' ? 'is-recording' : ''}`}><span />{clock(elapsed)} <small>/ {clock(options.constraints.maximumSeconds)}</small></div>}
        </div>
        {liveStream && <div className="studio-meter"><Mic size={14} aria-hidden="true" /><span>Entrada do microfone</span><meter min={0} max={1} value={level} aria-label="Nível do microfone" /><span>Confira o som na prévia</span></div>}
        {!file && <div className="studio-device-row"><label>Microfone<select value={audioId} disabled={busy} onChange={event => { setAudioId(event.target.value); if (phase === 'ready') void activateDevices(event.target.value, videoId); }}><option value="">Padrão do dispositivo</option>{devices.filter(device => device.kind === 'audioinput').map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Microfone ${index + 1}`}</option>)}</select></label>{mode === 'video' && <label>Câmera<select value={videoId} disabled={busy} onChange={event => { setVideoId(event.target.value); if (phase === 'ready') void activateDevices(audioId, event.target.value); }}><option value="">Padrão do dispositivo</option>{devices.filter(device => device.kind === 'videoinput').map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Câmera ${index + 1}`}</option>)}</select></label>}</div>}
        {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="studio-notice" role="status"><Check size={16} aria-hidden="true" />{notice}</p>}
        {tooLong && <p className="form-error" role="alert">A prévia indica uma duração acima do limite de {durationLabel(options.constraints.maximumSeconds)}. Escolha um trecho menor ou grave novamente.</p>}
        {phase === 'uploading' ? <div className="studio-upload-progress" role="status"><div><strong>{uploadProgress < 100 ? `Enviando sua gravação · ${uploadProgress}%` : 'Conferindo o arquivo e a duração…'}</strong><button type="button" className="button button-text" disabled={uploadProgress >= 100} onClick={() => requestRef.current?.abort()}><X size={15} aria-hidden="true" />Cancelar envio</button></div><progress max={100} value={uploadProgress} /></div>
          : file ? <><div className="studio-file-summary"><span><Check size={16} aria-hidden="true" />Prévia pronta</span><strong>{file.name}</strong><small>{previewSeconds === null ? 'Duração confirmada após o envio' : `${durationLabel(previewSeconds)} · estimativa de ${Math.ceil(previewSeconds / 60)} ${Math.ceil(previewSeconds / 60) === 1 ? singular : plural}`}</small></div><div className="studio-actions"><button type="button" className="button button-secondary" onClick={reset}><Trash2 size={16} aria-hidden="true" />Descartar e regravar</button><button type="button" className="button button-primary" disabled={tooLong || purpose === 'free' && !objective.trim()} onClick={() => void upload()}><Upload size={16} aria-hidden="true" />Salvar gravação</button></div><p className="studio-footnote">Salvar a gravação não usa {plural}. O consumo ocorre no pedido de avaliação.</p></>
          : <><div className="studio-actions">{phase === 'recording' ? <button type="button" className="button studio-stop" onClick={stop}><Square size={15} fill="currentColor" aria-hidden="true" />Encerrar gravação</button> : phase === 'stopping' ? <span role="status">Preparando sua prévia…</span> : phase === 'requesting' ? <button type="button" className="button button-secondary" onClick={reset}>Cancelar ativação</button> : phase === 'ready' ? <><button type="button" className="button button-secondary" onClick={reset}>Desligar dispositivos</button><button type="button" className="button button-primary" onClick={start}><span className="studio-record-dot" />Começar gravação</button></> : <button type="button" className="button button-primary" disabled={!captureSupported} onClick={() => void activateDevices()}>{mode === 'video' ? <Camera size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}Ativar {mode === 'video' ? 'câmera e microfone' : 'microfone'}</button>}{!busy && <button type="button" className="button button-secondary" onClick={() => fileRef.current?.click()}><Upload size={16} aria-hidden="true" />Selecionar arquivo</button>}</div>{!captureSupported && <p className="form-notice">Este navegador não oferece captura. Você pode enviar um arquivo já gravado.</p>}<p className="studio-footnote">Você poderá assistir ou ouvir antes de enviar. Use um local iluminado e confira o som.</p></>}
        <input ref={fileRef} type="file" className="studio-file-input" accept=".mp4,.m4a,.webm,.wav,.mp3,audio/mp4,audio/webm,audio/wav,audio/mpeg,video/mp4,video/webm" aria-label="Selecionar gravação" onChange={event => pickFile(event.target.files?.[0])} disabled={busy} />
      </div>
    </div>}
    {selected && <section ref={selectedRef} className="studio-saved"><div className="studio-section-heading"><div><span className="eyebrow">SUA PRÁTICA, GUARDADA</span><h2>{selected.objective}</h2><p>{scenarios[selected.scenario].title} · {new Date(selected.createdAt).toLocaleString('pt-BR')}</p></div><button type="button" className="button button-text" onClick={() => setSelected(null)} aria-label="Fechar reprodução"><X size={19} aria-hidden="true" /></button></div><RecordingPlayer recording={selected} /><div className="studio-saved-footer"><span><ShieldCheck size={16} aria-hidden="true" />Duração verificada · {selected.estimatedCredits} {selected.estimatedCredits === 1 ? singular : plural} para avaliar</span>{renderActions?.(selected)}</div></section>}
    <section className="studio-history"><div className="studio-section-heading"><div><span className="eyebrow">CADA TENTATIVA CONTA</span><h2>Suas gravações</h2><p>Volte a uma prática e perceba como a sua fala está mudando.</p></div><button type="button" className="button button-secondary" onClick={() => setListRevision(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />Atualizar</button></div>
      {listError && <p className="form-error" role="alert">{listError}</p>}{!list && !listError && <p className="studio-loading" role="status">Carregando suas gravações…</p>}
      {list?.items.length === 0 && <div className="studio-empty"><Headphones size={31} aria-hidden="true" /><h3>Sua próxima prática começa aqui.</h3><p>As gravações que você salvar aparecerão neste espaço.</p></div>}
      <div className="studio-recording-grid">{list?.items.map(recording => <button key={recording.id} type="button" className={`studio-recording-card ${selected?.id === recording.id ? 'selected' : ''}`} onClick={() => setSelected(recording)}><span className="studio-recording-icon">{recording.hasVideo ? <MonitorPlay size={24} aria-hidden="true" /> : <FileAudio size={24} aria-hidden="true" />}</span><span className="studio-recording-type">{recording.purpose === 'course' ? 'Atividade do curso' : recording.purpose === 'diagnostic' ? 'Diagnóstico' : 'Prática livre'}</span><strong>{recording.objective}</strong><span className="studio-recording-date">{new Date(recording.createdAt).toLocaleDateString('pt-BR')} · {durationLabel(recording.durationMicroseconds / 1_000_000)}</span><span className="studio-recording-open">Reproduzir <ArrowRight size={15} aria-hidden="true" /></span></button>)}</div>
      {list && list.total > list.pageSize && <div className="studio-pagination"><button type="button" className="button button-secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ArrowLeft size={15} aria-hidden="true" />Anterior</button><span>Página {page} de {Math.ceil(list.total / list.pageSize)}</span><button type="button" className="button button-secondary" disabled={page * list.pageSize >= list.total} onClick={() => setPage(value => value + 1)}>Próxima<ArrowRight size={15} aria-hidden="true" /></button></div>}
    </section>
  </section>;
}
