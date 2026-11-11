import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CurriculumImportError, loadCurriculumFromFile, parseCurriculum, reconstructCurriculumSource } from '../server/curriculum.js';
import type { CourseDraftV1 } from '../server/curriculum.js';

let source: string;
let course: CourseDraftV1;
beforeAll(async () => {
  source = await readFile(resolve('docs/PLANO_DE_ENSINO.md'), 'utf8');
  course = await loadCurriculumFromFile(resolve('docs/PLANO_DE_ENSINO.md'));
});

describe('importação integral do plano autoral', () => {
  it('reconstrói cada byte da fonte a partir das seções editáveis, sem recorrer à cópia arquivada', () => {
    const serialized = JSON.parse(JSON.stringify(course)) as CourseDraftV1;
    serialized.sourceMarkdown = '';
    expect(Buffer.from(reconstructCurriculumSource(serialized))).toEqual(Buffer.from(source));
    expect(course.provenance.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(course.provenance.sourceUtf8Bytes).toBe(Buffer.byteLength(source));
    expect(course.status).toBe('draft');
    expect(course.pedagogicalValidation).toBe('pending');
  });

  it('preserva 12 módulos, 36 aulas, 12 revisões e os limites de duração expressos', () => {
    expect(course.modules).toHaveLength(12);
    const units = course.modules.flatMap(module => module.units);
    expect(units.filter(unit => unit.kind === 'lesson')).toHaveLength(36);
    expect(units.filter(unit => unit.kind === 'review')).toHaveLength(12);
    expect(new Set(units.map(unit => unit.id)).size).toBe(48);
    for (const module of course.modules) {
      expect(module.units.map(unit => unit.kind)).toEqual(['lesson', 'lesson', 'lesson', 'review']);
      for (const unit of module.units) {
        expect(unit.checklist.length).toBeGreaterThanOrEqual(4);
        expect(unit.rubrics.length).toBeGreaterThanOrEqual(1);
        expect(unit.activities).toHaveLength(1);
        expect(unit.activities[0].duration).toMatchObject(unit.kind === 'lesson'
          ? { targetSeconds: 30, maximumSeconds: null }
          : { targetSeconds: null, maximumSeconds: 300 });
        expect(unit.activities[0].configuration.maximumUploadSeconds).toBeNull();
        expect(unit.activities[0].configuration.completionCreditGrant).toBeNull();
      }
    }
  });

  it('mantém todas as referências, suas ocorrências, atribuições e ressalvas no contexto original', () => {
    const linkCount = [...source.matchAll(/\]\((?:https?:\/\/|[^)\s]+\.md)[^)\s]*\)/g)].length;
    expect(course.references.reduce((sum, reference) => sum + reference.occurrences.length, 0)).toBe(linkCount);
    const ids = new Set(course.references.map(reference => reference.id));
    for (const reference of course.references) {
      expect(reference.occurrences.length).toBeGreaterThan(0);
      for (const occurrence of reference.occurrences) {
        expect(source.slice(occurrence.source.startOffset, occurrence.source.endOffset)).toBe(occurrence.markdown);
      }
    }
    for (const module of course.modules) for (const unit of module.units) {
      for (const id of [...unit.referenceIds, ...unit.inheritedReferenceIds]) expect(ids.has(id)).toBe(true);
      expect(source.slice(unit.source.startOffset, unit.source.endOffset)).toBe(unit.markdown);
      for (const item of unit.checklist) expect(source.slice(item.source.startOffset, item.source.endOffset)).toBe(item.markdown);
    }
    expect(course.appendicesMarkdown).toContain('Referências comentadas');
    expect(course.appendicesMarkdown).toContain('Richard Wiseman');
    expect(course.modules[7].units[2].markdown).toContain('PNL');
    expect(course.modules[7].units[2].markdown).toBe(source.slice(course.modules[7].units[2].source.startOffset, course.modules[7].units[2].source.endOffset));
    expect(course.modules[3].units[2].markdown).toContain('| Veludo |');
  });

  it('separa a escala geral de quatro níveis e as oito dimensões dos pesos ainda não definidos', () => {
    expect(course.evaluation.levels.map(level => level.value)).toEqual([1, 2, 3, 4]);
    expect(course.evaluation.dimensions).toHaveLength(8);
    expect(course.evaluation.insufficientEvidence).toContain('impede uma avaliação fundamentada');
    expect(course.evaluation.markdown).toContain('Em áudio, os critérios visuais ficam sem avaliação.');
    expect(course.evaluation.dimensions.every(dimension => dimension.weight === null)).toBe(true);
    expect(course.modules.flatMap(module => module.units.flatMap(unit => unit.rubrics)).every(rubric => rubric.weight === null && rubric.levelDescriptors === null)).toBe(true);
  });

  it('mantém IDs estáveis em novas importações sem depender da posição das referências', () => {
    const amended = parseCurriculum(source.replace('## Contexto do piloto informado pelo fundador', 'Uma nota editorial adicional.\n\n## Contexto do piloto informado pelo fundador'));
    expect(amended.modules.map(module => module.id)).toEqual(course.modules.map(module => module.id));
    expect(amended.modules.flatMap(module => module.units.map(unit => unit.id))).toEqual(course.modules.flatMap(module => module.units.map(unit => unit.id)));
    expect(amended.references.map(reference => reference.id)).toEqual(course.references.map(reference => reference.id));
    expect(amended.provenance.sourceSha256).not.toBe(course.provenance.sourceSha256);
  });

  it('preserva CRLF e falha diante de omissão de módulo, aula, atividade ou checklist', () => {
    const windows = source.replace(/\r?\n/g, '\r\n');
    expect(reconstructCurriculumSource(parseCurriculum(windows))).toBe(windows);
    expect(() => parseCurriculum(source.replace('## M12 ', '## Último módulo '))).toThrow(CurriculumImportError);
    expect(() => parseCurriculum(source.replace('### Aula 01.3 ', '### Aula 01.4 '))).toThrow(CurriculumImportError);
    expect(() => parseCurriculum(source.replace('**Entrega de 30 segundos.**', '**Prática sem duração.**'))).toThrow(CurriculumImportError);
    const first = course.modules[0].units[0];
    const withoutChecklist = source.slice(0, first.source.startOffset) + first.markdown.replace(/^- \[ \] .+\n/gm, '') + source.slice(first.source.endOffset);
    expect(() => parseCurriculum(withoutChecklist)).toThrow(CurriculumImportError);
  });
});
