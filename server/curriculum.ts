import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Offsets use JavaScript UTF-16 string positions; endOffset is exclusive. */
export interface CurriculumSourceSpan {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export interface CurriculumReference {
  id: string;
  href: string;
  kind: 'external' | 'internal';
  labels: string[];
  occurrences: { label: string; markdown: string; source: CurriculumSourceSpan }[];
}

export type PedagogicalBlockKind =
  | 'objective' | 'explanation' | 'example' | 'activity' | 'observation'
  | 'checklist' | 'recall' | 'guided_review' | 'practice' | 'conventions' | 'notes';

export interface PedagogicalBlock {
  id: string;
  kind: PedagogicalBlockKind;
  title: string;
  /** Includes the original bold heading, paragraphs, tables and whitespace. */
  markdown: string;
  source: CurriculumSourceSpan;
  referenceIds: string[];
}

export interface CurriculumChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  markdown: string;
  source: CurriculumSourceSpan;
}

export interface CurriculumActivityDraft {
  id: string;
  title: string;
  instructionMarkdown: string;
  sourceBlockId: string;
  /** A stated practice target is distinct from an explicit maximum duration. */
  duration: { targetSeconds: number | null; maximumSeconds: number | null; sourceLabel: string };
  /** Runtime configuration is intentionally unset by this content importer. */
  configuration: {
    acceptedMedia: ('audio' | 'video')[] | null;
    maximumUploadSeconds: number | null;
    completionCreditGrant: number | null;
  };
}

export interface CurriculumRubricDraft {
  id: string;
  title: string;
  kind: 'observational_guidance' | 'guided_review';
  instructionMarkdown: string;
  sourceBlockId: string;
  /** Weights and per-skill descriptors require editorial calibration. */
  weight: number | null;
  levelDescriptors: Record<string, string> | null;
}

export interface CurriculumUnitDraft {
  id: string;
  kind: 'lesson' | 'review';
  order: number;
  title: string;
  sourceLabel: string;
  source: CurriculumSourceSpan;
  markdown: string;
  preambleMarkdown: string;
  blocks: PedagogicalBlock[];
  activities: CurriculumActivityDraft[];
  rubrics: CurriculumRubricDraft[];
  checklist: CurriculumChecklistItem[];
  referenceIds: string[];
  inheritedReferenceIds: string[];
}

export interface CurriculumModuleDraft {
  id: string;
  order: number;
  title: string;
  source: CurriculumSourceSpan;
  /** Module heading and all introductory text preceding its first unit. */
  prefaceMarkdown: string;
  referenceIds: string[];
  units: CurriculumUnitDraft[];
}

export interface CurriculumEvaluationDraft {
  markdown: string;
  levels: { value: 1 | 2 | 3 | 4; description: string }[];
  insufficientEvidence: string;
  dimensions: { id: string; title: string; evidence: string; consistentPerformance: string; weight: null }[];
}

/** JSON-compatible editorial draft. Publishing and enrolment belong to later APIs. */
export interface CourseDraftV1 {
  schemaVersion: 1;
  id: 'matraca-oratoria-base';
  revision: number;
  status: 'draft';
  pedagogicalValidation: 'pending';
  title: string;
  locale: 'pt-BR';
  provenance: {
    sourcePath: string;
    sourceSha256: string;
    sourceUtf8Bytes: number;
    importer: 'matraca-curriculum-markdown-v1';
    attribution: 'Conteúdo e desenho pedagógico autoral do Matraca; contribuições externas atribuídas na fonte.';
  };
  /** Archival source: retained verbatim even after future editorial draft changes. */
  sourceMarkdown: string;
  introductionMarkdown: string;
  appendicesMarkdown: string;
  evaluation: CurriculumEvaluationDraft;
  modules: CurriculumModuleDraft[];
  references: CurriculumReference[];
}

export class CurriculumImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumImportError';
  }
}

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const stableReferenceId = (href: string) => `ref-${hash(href).slice(0, 20)}`;
const stableDimensionId = (name: string) => `dimension-${hash(name).slice(0, 16)}`;
const normalize = (label: string) => label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function sourceSpans(markdown: string) {
  const starts = [0];
  for (let position = 0; position < markdown.length; position++) {
    if (markdown[position] === '\n') starts.push(position + 1);
  }
  const lineAt = (position: number) => {
    let left = 0; let right = starts.length;
    while (left + 1 < right) {
      const middle = Math.floor((left + right) / 2);
      if (starts[middle] <= position) left = middle;
      else right = middle;
    }
    return left + 1;
  };
  return (startOffset: number, endOffset: number): CurriculumSourceSpan => ({
    startOffset, endOffset, startLine: lineAt(startOffset), endLine: lineAt(Math.max(startOffset, endOffset - 1)),
  });
}

function referencesIn(markdown: string, offset: number, span: ReturnType<typeof sourceSpans>) {
  return [...markdown.matchAll(/(?<!!)\[([^\]\r\n]+)\]\(([^\s)]+)\)/g)].map(match => ({
    id: stableReferenceId(match[2]), href: match[2], label: match[1], markdown: match[0],
    source: span(offset + match.index, offset + match.index + match[0].length),
  }));
}

function blockKind(label: string): PedagogicalBlockKind {
  const normalized = normalize(label);
  if (normalized.startsWith('objetivo')) return 'objective';
  if (/^(conteudo|desenvolvimento)/.test(normalized)) return 'explanation';
  if (normalized.startsWith('exemplo')) return 'example';
  if (/^(entrega|envio|video|desafio integrado)/.test(normalized)) return 'activity';
  if (/^(criterio|evidencias avaliadas|avaliacao observavel)/.test(normalized)) return 'observation';
  if (normalized.startsWith('checklist')) return 'checklist';
  if (normalized.startsWith('recuperacao')) return 'recall';
  if (normalized.startsWith('revisao guiada')) return 'guided_review';
  if (/^(pratica antes|alternativa autonoma)/.test(normalized)) return 'practice';
  if (normalized.startsWith('quatro convencoes')) return 'conventions';
  return 'notes';
}

function activityDuration(label: string): CurriculumActivityDraft['duration'] {
  const normalized = normalize(label);
  const match = normalized.match(/(\d+)\s+(segundos?|minutos?)/);
  if (!match) throw new CurriculumImportError(`A atividade “${label}” não declara uma duração reconhecida.`);
  const seconds = Number(match[1]) * (match[2].startsWith('minuto') ? 60 : 1);
  return normalized.includes('ate ')
    ? { targetSeconds: null, maximumSeconds: seconds, sourceLabel: label }
    : { targetSeconds: seconds, maximumSeconds: null, sourceLabel: label };
}

function parseUnit(
  markdown: string, offset: number, id: string, kind: CurriculumUnitDraft['kind'], order: number,
  title: string, sourceLabel: string, inheritedReferenceIds: string[], span: ReturnType<typeof sourceSpans>,
): CurriculumUnitDraft {
  const markers = [...markdown.matchAll(/^\*\*([^*\r\n]+)\*\*/gm)];
  const counters = new Map<PedagogicalBlockKind, number>();
  const blocks: PedagogicalBlock[] = markers.map((marker, index) => {
    const category = blockKind(marker[1]);
    const occurrence = (counters.get(category) ?? 0) + 1;
    counters.set(category, occurrence);
    const end = markers[index + 1]?.index ?? markdown.length;
    const raw = markdown.slice(marker.index, end);
    return {
      id: `${id}-${category}-${occurrence}`, kind: category, title: marker[1].replace(/\.$/, ''), markdown: raw,
      source: span(offset + marker.index, offset + end),
      referenceIds: [...new Set(referencesIn(raw, offset + marker.index, span).map(reference => reference.id))],
    };
  });
  const checklist = [...markdown.matchAll(/^- \[([ xX])\] ([^\r\n]*)/gm)].map((match, index) => ({
    id: `${id}-check-${index + 1}`, text: match[2], checked: match[1].toLowerCase() === 'x', markdown: match[0],
    source: span(offset + match.index, offset + match.index + match[0].length),
  }));
  const activities: CurriculumActivityDraft[] = blocks.filter(block => block.kind === 'activity').map((block, index) => ({
    id: `${id}-activity-${index + 1}`, title: block.title, instructionMarkdown: block.markdown,
    sourceBlockId: block.id, duration: activityDuration(block.title),
    configuration: { acceptedMedia: null, maximumUploadSeconds: null, completionCreditGrant: null },
  }));
  const rubrics: CurriculumRubricDraft[] = blocks.filter(block => block.kind === 'observation' || block.kind === 'guided_review').map((block, index) => ({
    id: `${id}-rubric-${index + 1}`, title: block.title,
    kind: block.kind === 'guided_review' ? 'guided_review' : 'observational_guidance',
    instructionMarkdown: block.markdown, sourceBlockId: block.id, weight: null, levelDescriptors: null,
  }));
  if (activities.length !== 1 || checklist.length < 4 || rubrics.length < 1) {
    throw new CurriculumImportError(`A unidade ${sourceLabel} precisa preservar atividade, critérios e checklist completos.`);
  }
  if (kind === 'lesson' && (!blocks.some(block => block.kind === 'objective') || !blocks.some(block => block.kind === 'explanation') || !blocks.some(block => block.kind === 'example'))) {
    throw new CurriculumImportError(`A aula ${sourceLabel} está sem objetivo, desenvolvimento ou exemplo reconhecível.`);
  }
  return {
    id, kind, order, title, sourceLabel, source: span(offset, offset + markdown.length), markdown,
    preambleMarkdown: markdown.slice(0, markers[0]?.index ?? markdown.length), blocks, activities, rubrics, checklist,
    referenceIds: [...new Set(referencesIn(markdown, offset, span).map(reference => reference.id))], inheritedReferenceIds,
  };
}

function sectionMarkdown(source: string, heading: string, level: number): string {
  const marker = '#'.repeat(level);
  const lines = [...source.matchAll(new RegExp(`^${marker} ([^\\r\\n]+)\\r?$`, 'gm'))];
  const index = lines.findIndex(line => line[1] === heading);
  if (index < 0) throw new CurriculumImportError(`Seção obrigatória ausente: ${heading}.`);
  const start = lines[index].index;
  const rest = source.slice(start + lines[index][0].length);
  const next = rest.match(new RegExp(`^#{1,${level}} `, 'm'));
  return source.slice(start, next?.index === undefined ? source.length : start + lines[index][0].length + next.index);
}

function tableRows(markdown: string): string[][] {
  return markdown.split(/\r?\n/).filter(line => /^\|/.test(line) && !/^\|[\s:|-]+\|$/.test(line))
    .map(line => line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(cell => cell.trim()));
}

function parseEvaluation(markdown: string): CurriculumEvaluationDraft {
  const evaluation = sectionMarkdown(markdown, 'Proposta de avaliação e relatório', 2);
  const levelRows = tableRows(evaluation).filter(row => /^[1-4]$/.test(row[0]));
  const insufficient = tableRows(evaluation).find(row => row[0] === 'Evidência insuficiente');
  const dimensions = tableRows(sectionMarkdown(markdown, 'Dimensões observáveis', 3)).slice(1);
  if (levelRows.length !== 4 || dimensions.length !== 8 || !insufficient?.[1]) {
    throw new CurriculumImportError('A escala e as oito dimensões de avaliação precisam estar completas.');
  }
  return {
    markdown: evaluation,
    levels: levelRows.map(row => ({ value: Number(row[0]) as 1 | 2 | 3 | 4, description: row[1] })),
    insufficientEvidence: insufficient[1],
    dimensions: dimensions.map(row => ({ id: stableDimensionId(row[0]), title: row[0], evidence: row[1], consistentPerformance: row[2], weight: null })),
  };
}

/** Imports the authored curriculum without summarizing, rewriting or fetching links. */
export function parseCurriculum(markdown: string, sourcePath = 'docs/PLANO_DE_ENSINO.md'): CourseDraftV1 {
  if (!markdown.trim()) throw new CurriculumImportError('O plano de ensino está vazio.');
  const title = markdown.match(/^# ([^\r\n]+)\r?$/m)?.[1];
  if (!title) throw new CurriculumImportError('O plano de ensino não possui título principal.');
  const span = sourceSpans(markdown);
  const rootHeadings = [...markdown.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  const moduleHeadings = rootHeadings.filter(heading => /^M\d{2} /.test(heading[1]));
  if (moduleHeadings.length !== 12) throw new CurriculumImportError('O plano autoral precisa conter os 12 módulos M01–M12.');
  const modules = moduleHeadings.map((heading, moduleIndex): CurriculumModuleDraft => {
    const number = String(moduleIndex + 1).padStart(2, '0');
    if (!heading[1].startsWith(`M${number} `)) throw new CurriculumImportError('A sequência de módulos deve ser M01–M12, sem repetição.');
    const end = rootHeadings[rootHeadings.indexOf(heading) + 1]?.index ?? markdown.length;
    const raw = markdown.slice(heading.index, end);
    const unitHeadings = [...raw.matchAll(/^### ([^\r\n]+)\r?$/gm)];
    if (unitHeadings.length !== 4) throw new CurriculumImportError(`M${number} precisa ter três aulas e uma revisão.`);
    const id = `matraca-m${number}`;
    const prefaceMarkdown = raw.slice(0, unitHeadings[0].index);
    const inherited = [...new Set(referencesIn(prefaceMarkdown, heading.index, span).map(reference => reference.id))];
    const units = unitHeadings.map((unit, unitIndex) => {
      const lesson = unit[1].match(new RegExp(`^Aula ${number}\\.([1-3]) (.+)$`));
      const review = unit[1] === `Revisão do módulo ${number}`;
      if (unitIndex < 3 ? !lesson || Number(lesson[1]) !== unitIndex + 1 : !review) {
        throw new CurriculumImportError(`Cabeçalho inesperado em M${number}: ${unit[1]}.`);
      }
      const unitEnd = unitHeadings[unitIndex + 1]?.index ?? raw.length;
      return parseUnit(raw.slice(unit.index, unitEnd), heading.index + unit.index,
        `${id}-${review ? 'review' : `lesson-${unitIndex + 1}`}`, review ? 'review' : 'lesson', unitIndex + 1,
        review ? unit[1] : lesson![2], unit[1], inherited, span);
    });
    return { id, order: moduleIndex + 1, title: heading[1].slice(4), source: span(heading.index, end), prefaceMarkdown, referenceIds: inherited, units };
  });
  const registry = new Map<string, CurriculumReference>();
  for (const occurrence of referencesIn(markdown, 0, span)) {
    const current = registry.get(occurrence.id) ?? { id: occurrence.id, href: occurrence.href, kind: /^https?:\/\//.test(occurrence.href) ? 'external' : 'internal', labels: [], occurrences: [] };
    if (!current.labels.includes(occurrence.label)) current.labels.push(occurrence.label);
    current.occurrences.push({ label: occurrence.label, markdown: occurrence.markdown, source: occurrence.source });
    registry.set(current.id, current);
  }
  const result: CourseDraftV1 = {
    schemaVersion: 1, id: 'matraca-oratoria-base', revision: 1, status: 'draft', pedagogicalValidation: 'pending', title, locale: 'pt-BR',
    provenance: { sourcePath, sourceSha256: hash(markdown), sourceUtf8Bytes: Buffer.byteLength(markdown, 'utf8'), importer: 'matraca-curriculum-markdown-v1', attribution: 'Conteúdo e desenho pedagógico autoral do Matraca; contribuições externas atribuídas na fonte.' },
    sourceMarkdown: markdown, introductionMarkdown: markdown.slice(0, modules[0].source.startOffset),
    appendicesMarkdown: markdown.slice(modules.at(-1)!.source.endOffset), evaluation: parseEvaluation(markdown), modules,
    references: [...registry.values()],
  };
  if (reconstructCurriculumSource(result) !== markdown) throw new CurriculumImportError('A importação não preservou integralmente o documento.');
  return result;
}

/** Reconstructs the imported editable sections; the archived source is not used. */
export function reconstructCurriculumSource(course: CourseDraftV1): string {
  return course.introductionMarkdown + course.modules.map(module => module.prefaceMarkdown + module.units.map(unit => unit.preambleMarkdown + unit.blocks.map(block => block.markdown).join('')).join('')).join('') + course.appendicesMarkdown;
}

export async function loadCurriculumFromFile(filePath: string, logicalSourcePath = 'docs/PLANO_DE_ENSINO.md'): Promise<CourseDraftV1> {
  return parseCurriculum(await readFile(filePath, 'utf8'), logicalSourcePath);
}
