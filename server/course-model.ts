import { z } from 'zod';
import type { CourseDraftV1 } from './curriculum.js';
const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const label=(max=160)=>z.string().trim().min(1).max(max);
const credit=z.number().int().min(0).max(10000);
export const criterionSchema=z.object({id:identifier,title:label(),weight:z.number().min(0).max(1000),enabled:z.boolean(),modality:z.enum(['audio','visual','both']),descriptors:z.tuple([label(1000),label(1000),label(1000),label(1000)])}).strict();
export const unitSchema=z.object({
  id:identifier,title:label(),kind:z.enum(['lesson','review']),chapter:z.string().max(160),mode:z.enum(['content','tracking']),
  bodyMarkdown:z.string().max(100000),instructionMarkdown:label(30000),checklist:z.array(label(2000)).max(100),
  references:z.array(z.object({title:label(300),href:z.string().max(2000)}).strict()).max(100),
  assetIds:z.array(z.uuid()).max(30),prerequisites:z.array(identifier).max(100),
  activity:z.object({maximumSeconds:z.number().int().min(1).max(1800),acceptedMedia:z.array(z.enum(['audio','video'])).min(1).max(2),scenario:z.enum(['one_on_one','executive','audience']),criteria:z.array(criterionSchema).min(1).max(40)}).strict(),
  studyCreditGrant:credit,requiresEvaluation:z.boolean(),
}).strict();
export const courseDocumentSchema=z.object({
  schemaVersion:z.literal(1),title:label(),description:z.string().max(3000),journey:z.enum(['sequential','adaptive']),
  creditMode:z.enum(['progress','acquisition']),acquisitionCredits:credit,completionCreditGrant:credit,catalogVisible:z.boolean(),
  introductionMarkdown:z.string().max(100000),appendicesMarkdown:z.string().max(100000),
  provenance:z.object({sourcePath:z.string().max(500),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),sourceMarkdown:z.string().max(500000)}).strict().nullable(),
  modules:z.array(z.object({id:identifier,title:label(),introductionMarkdown:z.string().max(30000),units:z.array(unitSchema).max(100)}).strict()).max(100),
}).strict();
export type CourseDocument=z.infer<typeof courseDocumentSchema>;
export type CourseUnit=z.infer<typeof unitSchema>;
export function validatePublication(document:CourseDocument):string[] {
  const issues:string[]=[];const modules=new Set<string>();const units=new Map<string,CourseUnit>();
  if(!document.modules.length)issues.push('Adicione ao menos um módulo.');
  for(const module of document.modules){
    if(modules.has(module.id))issues.push('Identificador de módulo repetido.');modules.add(module.id);
    if(!module.units.length)issues.push(`O módulo ${module.title} precisa de uma unidade.`);
    for(const unit of module.units){
      if(units.has(unit.id))issues.push('Identificador de unidade repetido.');units.set(unit.id,unit);
      if(unit.mode==='content'&&!unit.bodyMarkdown.trim())issues.push(`A unidade ${unit.title} precisa de conteúdo.`);
      if(!unit.activity.criteria.some(criterion=>criterion.enabled&&criterion.weight>0))issues.push(`Defina ao menos um critério com peso positivo em ${unit.title}.`);
      if(new Set(unit.activity.criteria.map(c=>c.id)).size!==unit.activity.criteria.length)issues.push(`Há critérios repetidos em ${unit.title}.`);
      for(const reference of unit.references) if(!/^(https?:\/\/|[A-Za-z0-9_./-]+\.md(?:#[A-Za-z0-9_-]+)?)$/.test(reference.href)&&!/^https?:\/\//.test(reference.href))issues.push(`Referência inválida em ${unit.title}.`);
    }
  }
  const position = new Map([...units.keys()].map((id, index) => [id, index]));
  for (const unit of units.values()) {
    const ownPosition = position.get(unit.id)!;
    for (const prerequisite of unit.prerequisites) {
      const requiredPosition = position.get(prerequisite);
      if (requiredPosition !== undefined && requiredPosition >= ownPosition) {
        issues.push(`O pré-requisito de ${unit.title} deve vir antes na ordem do curso.`);
      }
    }
  }
  const visiting=new Set<string>();const visited=new Set<string>();
  function visit(id:string){if(visiting.has(id)){issues.push('Os pré-requisitos contêm um ciclo.');return;}if(visited.has(id))return;const unit=units.get(id);if(!unit){issues.push(`Pré-requisito ausente: ${id}.`);return;}visiting.add(id);for(const previous of unit.prerequisites)visit(previous);visiting.delete(id);visited.add(id);}
  for(const id of units.keys())visit(id);
  return [...new Set(issues)];
}
export function emptyCourse(title:string):CourseDocument {
  return {schemaVersion:1,title,description:'',journey:'sequential',creditMode:'progress',acquisitionCredits:0,completionCreditGrant:20,catalogVisible:false,introductionMarkdown:'',appendicesMarkdown:'',provenance:null,modules:[]};
}
export function curriculumToCourse(source:CourseDraftV1):CourseDocument {
  const references=new Map(source.references.map(reference=>[reference.id,reference]));
  const descriptors=source.evaluation.levels.map(level=>level.description) as [string,string,string,string];
  return {...emptyCourse('Oratória: da primeira fala à apresentação completa'),description:'12 módulos de prática orientada para clareza, voz, presença, estrutura e adaptação.',catalogVisible:true,journey:'adaptive',introductionMarkdown:source.introductionMarkdown,appendicesMarkdown:source.appendicesMarkdown,
    provenance:{sourcePath:source.provenance.sourcePath,sourceSha256:source.provenance.sourceSha256,sourceMarkdown:source.sourceMarkdown},
    modules:source.modules.map(module=>({id:module.id,title:module.title,introductionMarkdown:module.prefaceMarkdown,units:module.units.map(unit=>({
      id:unit.id,title:unit.title,kind:unit.kind,chapter:'',mode:'content',bodyMarkdown:unit.markdown,
      instructionMarkdown:unit.activities.map(activity=>activity.instructionMarkdown).join('\n\n'),checklist:unit.checklist.map(item=>item.text),
      references:[...new Set([...unit.referenceIds,...unit.inheritedReferenceIds])].map(id=>references.get(id)).filter((item):item is NonNullable<typeof item>=>Boolean(item)).map(reference=>({title:reference.labels.join(' · '),href:reference.href})),
      assetIds:[],prerequisites:[],studyCreditGrant:unit.kind==='review'?5:1,requiresEvaluation:true,
      activity:{maximumSeconds:unit.kind==='review'?300:30,acceptedMedia:['audio','video'],scenario:'one_on_one',criteria:source.evaluation.dimensions.map(dimension=>({id:dimension.id,title:dimension.title,enabled:true,weight:1,modality:dimension.title.includes('corporais')?'visual':'both',descriptors}))},
    }))})),
  };
}
