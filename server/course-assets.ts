import {randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';
import type {FastifyInstance} from 'fastify';
import sharp from 'sharp';
import {z} from 'zod';
import {requireIdentity} from './auth.js';
import {CourseError,courseEditorTarget,courseMutation} from './courses.js';
import {probeMedia,MediaProbeError} from './media/probe.js';
import {streamPrivateFile} from './http-media.js';
import type {CourseDocument} from './course-model.js';
const maxBytes=200*1024*1024;
export async function registerCourseAssets(app:FastifyInstance){
 for(const central of [false,true]){
  const base=central?'/api/backoffice/courses/:orgId/:id/assets':'/api/courses/manage/:id/assets';
  app.post(base,async(request,reply)=>{
   const {orgId}=await courseEditorTarget(request,central);const parsed=z.object({id:z.uuid()}).passthrough().safeParse(request.params);if(!parsed.success)throw new CourseError(400,'Curso inválido.');const courseId=parsed.data.id;
   if(!(await app.db.query('SELECT id FROM courses WHERE id=$1 AND org_id=$2',[courseId,orgId])).rowCount)throw new CourseError(404,'Curso não encontrado.');
   const id=randomUUID();const key=`course-assets/${orgId}/${id}`;let filename='';let uploaded=false;let size=0;
   try{
    for await(const part of request.parts({limits:{fileSize:maxBytes,files:1,fields:0,parts:1}})){
     if(part.type!=='file')throw new CourseError(400,'Envie apenas um arquivo.');filename=[...part.filename].map(character=>character.charCodeAt(0)<32||'/\\'.includes(character)?'_':character).join('').slice(0,180)||'material';
     const info=await app.storage.put(key,part.file);uploaded=true;size=info.size;if(part.file.truncated||!size)throw new CourseError(400,'Arquivo vazio ou maior que 200 MB.');
    }
    if(!uploaded)throw new CourseError(400,'Selecione um arquivo.');
    const file=await open(app.storage.path(key),'r');const signature=Buffer.alloc(16);try{await file.read(signature,0,16,0);}finally{await file.close();}
    let mimeType:string;
    if(signature.subarray(0,5).toString()==='%PDF-'){
     if(size>20*1024*1024)throw new CourseError(400,'PDFs devem ter até 20 MB.');
     const pdf=await open(app.storage.path(key),'r');const trailer=Buffer.alloc(Math.min(size,1024));try{await pdf.read(trailer,0,trailer.length,size-trailer.length);}finally{await pdf.close();}
     if(size<20||!trailer.includes('%%EOF'))throw new CourseError(400,'PDF incompleto.');mimeType='application/pdf';
    }
    else if(signature[0]===137||signature.subarray(0,2).equals(Buffer.from([255,216]))||signature.subarray(0,4).toString()==='RIFF'&&signature.subarray(8,12).toString()==='WEBP'){
     try{const decoder=sharp(app.storage.path(key),{limitInputPixels:16_000_000,failOn:'error'});const info=await decoder.metadata();if(!['jpeg','png','webp'].includes(info.format??'')||(info.pages??1)!==1)throw new Error('Formato');await decoder.stats();mimeType=`image/${info.format}`;}catch{throw new CourseError(400,'Imagem inválida ou fora dos limites.');}
    }else{const media=await probeMedia(app.storage.path(key),{maxBytes,maxDurationSeconds:3600,maxPackets:1_000_000});mimeType=media.mimeType;}
    const asset=await courseMutation(request,central,async(client,targetOrg,actor)=>{const result=await client.query('INSERT INTO course_assets(id,org_id,course_id,object_key,filename,mime_type,byte_length,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,filename,mime_type AS "mimeType",byte_length AS size',[id,targetOrg,courseId,key,filename,mimeType,size,actor.user.id]);return result.rows[0];});
    return reply.code(201).send({asset});
   }catch(error){if(uploaded)await app.storage.remove(key).catch(()=>{});if(error instanceof MediaProbeError)throw new CourseError(400,'Mídia inválida ou fora dos limites.');throw error;}
  });
 }
 app.get('/api/course-assets/:id',async(request,reply)=>{
  const actor=await requireIdentity(request);const parsed=z.object({id:z.uuid()}).safeParse(request.params);if(!parsed.success)throw new CourseError(404,'Material não encontrado.');
  const asset=(await app.db.query<{id:string;org_id:string;course_id:string;object_key:string;byte_length:string;mime_type:string;filename:string}>('SELECT * FROM course_assets WHERE id=$1',[parsed.data.id])).rows[0];
  if(!asset)throw new CourseError(404,'Material não encontrado.');
  const operator=actor.org.kind==='backoffice'&&actor.user.roles.includes('operator');
  if(!operator&&asset.org_id!==actor.org.id)throw new CourseError(404,'Material não encontrado.');
  if(!operator&&!actor.user.roles.includes('org_admin')){
   if(actor.org.settings.coursesEnabled===false)throw new CourseError(403,'Cursos desativados.');
   const versions=await app.db.query<{document:CourseDocument}>('SELECT v.document FROM course_versions v JOIN course_enrollments e ON e.version_id=v.id AND e.org_id=v.org_id WHERE e.org_id=$1 AND e.student_id=$2 AND e.course_id=$3 AND e.status<>\'cancelled\'',[actor.org.id,actor.user.id,asset.course_id]);
   if(!versions.rows.some(row=>row.document.modules.some(module=>module.units.some(unit=>unit.assetIds.includes(asset.id)))))throw new CourseError(403,'Este material não está disponível na sua versão do curso.');
  }
  return streamPrivateFile(request,reply,app.storage,{key:asset.object_key,size:Number(asset.byte_length),mimeType:asset.mime_type,filename:asset.filename});
 });
}
