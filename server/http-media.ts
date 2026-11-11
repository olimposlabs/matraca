import type { FastifyReply,FastifyRequest } from 'fastify';
import type { LocalStorage } from './storage.js';
/** Single-range streaming for authenticated private files. */
export function streamPrivateFile(request:FastifyRequest,reply:FastifyReply,storage:LocalStorage,file:{key:string;size:number;mimeType:string;filename?:string}){
 reply.type(file.mimeType).header('Accept-Ranges','bytes').header('Content-Security-Policy',"default-src 'none'; sandbox");
 if(file.filename)reply.header('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
 const requested=request.headers.range;
 let start=0;let end=file.size-1;
 if(requested){
  const match=/^bytes=(\d*)-(\d*)$/.exec(requested);
  if(!match||(!match[1]&&!match[2]))return reply.code(416).header('Content-Range',`bytes */${file.size}`).send();
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return reply.code(416).header('Content-Range',`bytes */${file.size}`).send();start=Math.max(0,file.size-suffix);}
  else {start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),file.size-1):file.size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=file.size||end<start)return reply.code(416).header('Content-Range',`bytes */${file.size}`).send();
  reply.code(206).header('Content-Range',`bytes ${start}-${end}/${file.size}`);
 }
 reply.header('Content-Length',end-start+1);
 return request.method==='HEAD'?reply.send():reply.send(storage.read(file.key,{start,end}));
}
