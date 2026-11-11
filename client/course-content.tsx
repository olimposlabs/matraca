import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { BookOpen, Check, ExternalLink, FileText, Headphones, Play, Video } from 'lucide-react';
import type { CourseUnit } from '../server/course-model';

export type CourseAsset = { id: string; filename: string; mimeType: string; size: number | string };
function durationLabel(seconds: number) { const minutes = Math.floor(seconds / 60); const remainder = seconds % 60; return minutes === 0 ? `${seconds} segundos` : remainder ? `${minutes} min e ${remainder} s` : `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`; }
function safeHref(href: string): string | undefined {
  try { const url = new URL(href); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function inline(text: string): ReactNode[] {
  const expression = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  return text.split(expression).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) { const href = safeHref(link[2]); return href ? <a key={index} href={href} target="_blank" rel="noreferrer">{link[1]}<ExternalLink size={11} aria-hidden="true" /></a> : <span key={index}>{link[1]}</span>; }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

/** Text-only Markdown rendering: authored HTML is never executed. */
export function MarkdownContent({ text }: { text: string }) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const nodes: ReactNode[] = [];
  let cursor = 0;
  const startsBlock = (line: string) => /^(#{1,6}\s|[-*]\s|\d+[.)]\s|>\s?|```|\|)/.test(line);
  while (cursor < lines.length) {
    const line = lines[cursor].trim(); const key = cursor;
    if (!line) { cursor++; continue; }
    if (/^```/.test(line)) { const content: string[] = []; cursor++; while (cursor < lines.length && !/^```/.test(lines[cursor])) content.push(lines[cursor++]); cursor++; nodes.push(<pre key={key}><code>{content.join('\n')}</code></pre>); continue; }
    if (/^[-*_]{3,}$/.test(line)) { nodes.push(<hr key={key} />); cursor++; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { const content = inline(heading[2]); nodes.push(heading[1].length <= 2 ? <h2 key={key}>{content}</h2> : heading[1].length === 3 ? <h3 key={key}>{content}</h3> : <h4 key={key}>{content}</h4>); cursor++; continue; }
    if (/^\|/.test(line)) { const rows: string[][] = []; while (cursor < lines.length && /^\s*\|/.test(lines[cursor])) { const row = lines[cursor++].trim().replace(/^\||\|$/g, '').split('|').map(item => item.trim()); if (!row.every(cell => /^:?-{3,}:?$/.test(cell))) rows.push(row); } nodes.push(<div className="course-content-table" key={key}><table><thead><tr>{rows[0]?.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, index) => <tr key={index}>{row.map((cell, position) => <td key={position}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue; }
    if (/^>/.test(line)) { const quote: string[] = []; while (cursor < lines.length && /^\s*>/.test(lines[cursor])) quote.push(lines[cursor++].replace(/^\s*>\s?/, '')); nodes.push(<blockquote key={key}>{inline(quote.join(' '))}</blockquote>); continue; }
    if (/^([-*]|\d+[.)])\s/.test(line)) { const ordered = /^\d/.test(line); const items: ReactNode[] = []; while (cursor < lines.length && /^\s*([-*]|\d+[.)])\s/.test(lines[cursor])) { const content = lines[cursor++].replace(/^\s*([-*]|\d+[.)])\s/, '').replace(/^\[[ xX]\]\s?/, ''); items.push(<li key={cursor}>{inline(content)}</li>); } nodes.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>); continue; }
    const paragraph = [line]; cursor++; while (cursor < lines.length && lines[cursor].trim() && !startsBlock(lines[cursor].trim())) paragraph.push(lines[cursor++].trim()); nodes.push(<p key={key}>{inline(paragraph.join(' '))}</p>);
  }
  return <div className="course-markdown">{nodes}</div>;
}

function AssetMedia({ asset }: { asset: CourseAsset }) {
  const [failed, setFailed] = useState(false); const source = `/api/course-assets/${asset.id}`;
  return <article className="course-asset-view"><div className="course-asset-title"><FileText size={18} /><strong>{asset.filename}</strong><a href={source} target="_blank" rel="noreferrer" className="button button-text">Abrir<ExternalLink size={14} /></a></div>{failed ? <p className="form-error">O material não pôde ser carregado. Tente abrir novamente.</p> : asset.mimeType.startsWith('video/') ? <video controls preload="metadata" onError={() => setFailed(true)} src={source} /> : asset.mimeType.startsWith('audio/') ? <audio controls preload="metadata" onError={() => setFailed(true)} src={source} /> : asset.mimeType.startsWith('image/') ? <img loading="lazy" src={source} onError={() => setFailed(true)} alt={asset.filename} /> : <p>Material de apoio em PDF. Abra o arquivo para ler as páginas.</p>}</article>;
}

export function CourseUnitContent({ unit, assets, creditName, creditSingular = 'crédito', checklistContent }: { unit: CourseUnit; assets: CourseAsset[]; creditName: string; creditSingular?: string; checklistContent?: ReactNode }) {
  return <><div className="course-lesson-heading"><span className="eyebrow">{unit.kind === 'review' ? 'REVISÃO DO MÓDULO' : 'AULA'}{unit.chapter ? ` · ${unit.chapter}` : ''}</span><h2>{unit.title}</h2><div className="course-lesson-tags"><span><BookOpen size={14} />{unit.mode === 'tracking' ? 'Acompanhamento de prática' : 'Conteúdo e prática'}</span><span><Play size={14} />Até {durationLabel(unit.activity.maximumSeconds)}</span>{unit.activity.acceptedMedia.map(media => <span key={media}>{media === 'audio' ? <Headphones size={14} /> : <Video size={14} />}{media === 'audio' ? 'Áudio' : 'Vídeo'}</span>)}</div></div>
    {unit.mode === 'content' && unit.bodyMarkdown && <MarkdownContent text={unit.bodyMarkdown} />}
    {unit.assetIds.length > 0 && <section className="course-attachments"><h3>Materiais da aula</h3>{unit.assetIds.map(id => { const asset = assets.find(item => item.id === id); return asset ? <AssetMedia key={id} asset={asset} /> : <a key={id} href={`/api/course-assets/${id}`} target="_blank" rel="noreferrer" className="course-asset-fallback"><FileText size={16} />Abrir material de apoio<ExternalLink size={14} /></a>; })}</section>}
    <section className="course-practice-brief"><span className="feature-icon icon-peach"><Play size={23} /></span><h3>Sua próxima prática</h3><MarkdownContent text={unit.instructionMarkdown} /><div><span>Cenário: {unit.activity.scenario === 'executive' ? 'Reunião executiva' : unit.activity.scenario === 'audience' ? 'Apresentação para uma plateia' : 'Conversa a dois'}</span><span>{unit.studyCreditGrant} {unit.studyCreditGrant === 1 ? creditSingular : creditName} {unit.studyCreditGrant === 1 ? 'previsto' : 'previstos'} ao estudar esta unidade</span></div></section>
    {checklistContent ?? (unit.checklist.length > 0 && <section className="course-checklist"><h3>Antes de seguir</h3>{unit.checklist.map((item, index) => <div key={index}><Check size={16} /><span>{item}</span></div>)}</section>)}
    <details className="course-rubric-preview"><summary>Como esta prática será avaliada</summary>{unit.activity.criteria.filter(criterion => criterion.enabled).map(criterion => <section key={criterion.id}><h4>{criterion.title}<span>Peso {criterion.weight}</span></h4><ol>{criterion.descriptors.map((description, index) => <li key={index}><strong>Nível {index + 1}</strong><span>{description}</span></li>)}</ol></section>)}</details>
    {unit.references.length > 0 && <section className="course-references"><h3>Referências para continuar aprendendo</h3>{unit.references.map((reference, index) => <div key={index}>{safeHref(reference.href) ? <a href={safeHref(reference.href)} target="_blank" rel="noreferrer">{reference.title}<ExternalLink size={13} /></a> : <span>{reference.title}</span>}</div>)}</section>}
  </>;
}
