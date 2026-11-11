import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireIdentity, type AuthIdentity, type IdentityOrg, type IdentityRole } from './auth.js';
import { localHostname } from './config.js';
import { assertSchoolScope, isOrgAdmin, managedSchoolIds, scopeValues, type EducationQuery } from './permissions.js';
import { grantCreditsInTransaction, adjustCreditsInTransaction, refundConsumptionInTransaction,
  type WalletEntry, type WalletState, type CreditSource } from './wallet.js';

class CreditsAccessError extends Error {
  constructor(public readonly statusCode:400|401|403|404|409,message:string){super(message);this.name='CreditsAccessError';}
}
const id=z.uuid();
const amount=z.number().int().min(1).max(1_000_000);
const reason=z.string().trim().min(1).max(500);
const eventBase={eventId:id,reason};
const grantInput=z.object({...eventBase,amount:amount.optional(),packageId:id.optional()}).strict()
  .refine(data=>(data.amount!==undefined)!==(data.packageId!==undefined));
const adjustInput=z.object({...eventBase,delta:z.number().int().min(-1_000_000).max(1_000_000).refine(n=>n!==0)}).strict();
const refundInput=z.object({...eventBase,entryId:id}).strict();
const policyInput=z.object({schoolExtrasEnabled:z.boolean().optional(),defaultSchoolMonthlyLimit:z.number().int().min(0).max(1_000_000_000).optional()}).strict().refine(data=>Object.keys(data).length>0);
const packageInput=z.object({name:z.string().trim().min(1).max(120),amount,description:z.string().trim().max(500).default('')}).strict();
const packagePatch=z.object({name:z.string().trim().min(1).max(120).optional(),amount:amount.optional(),description:z.string().trim().max(500).optional(),status:z.enum(['active','archived']).optional()}).strict().refine(data=>Object.keys(data).length>0);
const sources=['initial','lesson','module','course','purchase','manual','leaderboard','evaluation','refund','adjustment'] as const;
const statementQuery=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),limit:z.coerce.number().int().min(1).max(100).default(25),source:z.enum(sources).optional(),from:z.iso.date().optional(),to:z.iso.date().optional(),actorSearch:z.string().trim().max(120).optional()}).strict().refine(data=>!data.from||!data.to||data.to>=data.from);
const studentsQuery=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20),search:z.string().trim().max(120).default(''),schoolId:id.optional()}).strict();
interface TargetOrg extends IdentityOrg{status:string}
interface Access{actor:AuthIdentity;org:TargetOrg;central:boolean}
interface Student{id:string;name:string;email:string;status:string;roles:IdentityRole[];archivedAt:Date|null;schoolId:string|null;schoolName:string|null}
interface GrantPackage{id:string;name:string;amount:number;description:string;status:'active'|'archived'}
interface CreditPolicy{schoolExtrasEnabled:boolean;defaultSchoolMonthlyLimit:number}
type Operation='grant'|'adjust'|'refund';
type MovementInput=z.infer<typeof grantInput>|z.infer<typeof adjustInput>|z.infer<typeof refundInput>;

export async function registerCredits(app:FastifyInstance):Promise<void>{
  app.get('/api/wallet',async(request)=>{
    const actor=await requireIdentity(request,['student']);
    const org=await targetOrg(app.db,actor.org.id);
    return statement(app,request,{actor,org,central:false},actor.user.id,parse(statementQuery,request.query),true);
  });
  for(const central of [false,true]){
    const prefix=central?'/api/backoffice/credits/orgs/:orgId':'/api/credits';
    app.get(`${prefix}/students`,async(request)=>{
      const access=await context(app,request,central),query=parse(studentsQuery,request.query);
      const values:unknown[]=[...scopeValues({...access.actor,org:access.org}),query.search?`%${escapeLike(query.search)}%`:null];
      let where=`u.org_id=$1 AND ('student'=ANY(u.roles) OR EXISTS(SELECT 1 FROM wallets w WHERE w.org_id=u.org_id AND w.user_id=u.id))
        AND ($4::text IS NULL OR u.name ILIKE $4 OR u.email ILIKE $4)`;
      if(!access.central&&!isOrgAdmin(access.actor))where+=` AND ${SCHOOL_CREDIT_SCOPE_SQL}`;
      else where+=' AND $2::uuid IS NOT NULL AND $3::text[] IS NOT NULL';
      if(query.schoolId){values.push(query.schoolId);where+=` AND ss.school_id=$${values.length}`;}
      const count=await app.db.query<{total:number}>(`SELECT count(*)::integer AS total ${studentsFrom} WHERE ${where}`,values);
      values.push(query.pageSize,(query.page-1)*query.pageSize);
      const items=await app.db.query(`${studentsSelect} ${studentsFrom} WHERE ${where} ORDER BY u.name,u.id LIMIT $${values.length-1} OFFSET $${values.length}`,values);
      return {items:items.rows,total:count.rows[0].total,page:query.page,pageSize:query.pageSize,org:publicOrg(access.org)};
    });
    app.get(`${prefix}/students/:id`,async(request)=>{
      const access=await context(app,request,central);return statement(app,request,access,param(request,'id'),parse(statementQuery,request.query));
    });
    for(const operation of ['grant','adjust','refund'] as const){
      app.post(`${prefix}/students/:id/${operation}`,async(request)=>{
        const access=await context(app,request,central);
        const input:MovementInput=operation==='grant'?parse(grantInput,request.body):operation==='adjust'?parse(adjustInput,request.body):parse(refundInput,request.body);
        return mutate(app,request,access,async(client,current)=>move(client,current,param(request,'id'),operation,input));
      });
    }
    app.get(`${prefix}/schools`,async(request)=>{
      const access=await context(app,request,central),managed=access.central?[]:await managedSchoolIds(app.db,access.actor);
      const items=await app.db.query('SELECT id,name,status FROM schools WHERE org_id=$1 AND ($2::boolean OR id=ANY($3::uuid[])) ORDER BY name,id',[access.org.id,access.central||isOrgAdmin(access.actor),managed]);return {items:items.rows};
    });
    app.get(`${prefix}/policy`,async(request)=>({policy:await policy(app.db,(await context(app,request,central)).org.id)}));
    app.patch(`${prefix}/policy`,async(request)=>{
      const access=await context(app,request,central),data=parse(policyInput,request.body);
      return mutate(app,request,access,async(client,current)=>{
        administrator(current);const previous=await policy(client,current.org.id);
        const next={...previous,...data};await client.query(`INSERT INTO org_credit_policies(org_id,school_extras_enabled,default_school_monthly_limit) VALUES($1,$2,$3)
          ON CONFLICT(org_id) DO UPDATE SET school_extras_enabled=EXCLUDED.school_extras_enabled,default_school_monthly_limit=EXCLUDED.default_school_monthly_limit,updated_at=clock_timestamp()`,[current.org.id,next.schoolExtrasEnabled,next.defaultSchoolMonthlyLimit]);
        await audit(client,current,'credit_policy_updated');return {policy:next};
      });
    });
    app.get(`${prefix}/schools/:schoolId/limit`,async(request)=>{
      const access=await context(app,request,central),schoolId=param(request,'schoolId');await schoolScope(app.db,access,schoolId);return {limit:await schoolLimit(app.db,access.org.id,schoolId)};
    });
    app.patch(`${prefix}/schools/:schoolId/limit`,async(request)=>{
      const access=await context(app,request,central),schoolId=param(request,'schoolId'),data=parse(z.object({monthlyLimit:z.number().int().min(0).max(1_000_000_000)}).strict(),request.body);
      return mutate(app,request,access,async(client,current)=>{
        administrator(current);await schoolScope(client,current,schoolId);
        await client.query(`INSERT INTO school_credit_limits(org_id,school_id,monthly_limit) VALUES($1,$2,$3)
          ON CONFLICT(org_id,school_id) DO UPDATE SET monthly_limit=EXCLUDED.monthly_limit,updated_at=clock_timestamp()`,[current.org.id,schoolId,data.monthlyLimit]);
        await audit(client,current,'school_credit_limit_updated',{schoolId});return {limit:await schoolLimit(client,current.org.id,schoolId)};
      });
    });
    app.get(`${prefix}/packages`,async(request)=>{
      const access=await context(app,request,central);
      const items=await app.db.query<GrantPackage>(`SELECT id,name,amount,description,status FROM credit_grant_packages WHERE org_id=$1 AND ($2::boolean OR status='active') ORDER BY name,id`,[access.org.id,access.central||isOrgAdmin(access.actor)]);return {items:items.rows};
    });
    app.post(`${prefix}/packages`,async(request,reply)=>{
      const access=await context(app,request,central),data=parse(packageInput,request.body);
      const result=await mutate(app,request,access,async(client,current)=>{
        administrator(current);const item=(await client.query<GrantPackage>('INSERT INTO credit_grant_packages(org_id,name,amount,description) VALUES($1,$2,$3,$4) RETURNING id,name,amount,description,status',[current.org.id,data.name,data.amount,data.description])).rows[0];
        await audit(client,current,'credit_package_created',{packageId:item.id});return {package:item};
      });return reply.code(201).send(result);
    });
    app.patch(`${prefix}/packages/:id`,async(request)=>{
      const access=await context(app,request,central),packageId=param(request,'id'),data=parse(packagePatch,request.body);
      return mutate(app,request,access,async(client,current)=>{
        administrator(current);const previous=await grantPackage(client,current.org.id,packageId);
        const item=(await client.query<GrantPackage>('UPDATE credit_grant_packages SET name=$3,amount=$4,description=$5,status=$6,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2 RETURNING id,name,amount,description,status',[current.org.id,packageId,data.name??previous.name,data.amount??previous.amount,data.description??previous.description,data.status??previous.status])).rows[0];
        await audit(client,current,'credit_package_updated',{packageId});return {package:item};
      });
    });
  }
}

const studentsFrom=`FROM users u LEFT JOIN student_schools ss ON ss.student_id=u.id AND ss.org_id=u.org_id AND ss.ended_at IS NULL
  LEFT JOIN schools sc ON sc.id=ss.school_id AND sc.org_id=ss.org_id LEFT JOIN wallets w ON w.user_id=u.id AND w.org_id=u.org_id`;
const studentsSelect=`SELECT u.id,u.name,u.email,u.status,u.roles,u.archived_at AS "archivedAt",ss.school_id AS "schoolId",sc.name AS "schoolName",
  COALESCE(w.balance,0) AS balance,COALESCE(w.reserved,0) AS reserved,COALESCE(w.balance-w.reserved,0) AS available`;
// Financial delegation requires school management. A cumulative student/teacher role
// does not grant management of its own wallet or of a teacher's class wallets.
const SCHOOL_CREDIT_SCOPE_SQL=`('school'=ANY($3::text[]) AND 'student'=ANY(u.roles) AND EXISTS (
  SELECT 1 FROM student_schools current_school JOIN schools managed_school
    ON managed_school.id=current_school.school_id AND managed_school.org_id=current_school.org_id
  JOIN school_staff manager ON manager.school_id=current_school.school_id AND manager.org_id=current_school.org_id
  WHERE current_school.org_id=$1 AND current_school.student_id=u.id AND current_school.ended_at IS NULL
    AND managed_school.status='active' AND manager.user_id=$2 AND manager.role='school' AND manager.ended_at IS NULL
))`;
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new CreditsAccessError(400,'Dados ou filtros de crédito inválidos.');return result.data;}
function param(request:FastifyRequest,key:'id'|'orgId'|'schoolId'):string{return parse(id,(request.params as Record<string,unknown>)[key]);}
function administrator(access:Access):void{if(!access.central&&!isOrgAdmin(access.actor))throw new CreditsAccessError(403,'Ação exclusiva do administrador.');}
function publicOrg(org:TargetOrg){return {id:org.id,name:org.name,branding:org.branding};}
function escapeLike(value:string){return value.replace(/[\\%_]/g,'\\$&');}
async function targetOrg(client:EducationQuery,orgId:string,lock=false):Promise<TargetOrg>{
  const org=(await client.query<TargetOrg>(`SELECT id,slug,name,kind,status,settings,branding FROM orgs WHERE id=$1 ${lock?'FOR SHARE':''}`,[orgId])).rows[0];
  if(!org||org.kind==='backoffice')throw new CreditsAccessError(404,'Organização de alunos não encontrada.');return org;
}
async function context(app:FastifyInstance,request:FastifyRequest,central:boolean):Promise<Access>{
  const actor=await requireIdentity(request,central?['operator']:['org_admin','school']);
  if(central&&actor.org.kind!=='backoffice')throw new CreditsAccessError(403,'Acesso exclusivo do backoffice.');
  return {actor,central,org:await targetOrg(app.db,central?param(request,'orgId'):actor.org.id)};
}
async function refresh(client:PoolClient,request:FastifyRequest,access:Access,lock:boolean,self=false):Promise<Access>{
  const found=await client.query<{name:string;email:string;roles:IdentityRole[];kind:string}>(
    `SELECT u.name,u.email,u.roles,o.kind FROM sessions s JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id
     JOIN orgs o ON o.id=s.org_id JOIN domains d ON d.hostname=s.hostname AND d.org_id=s.org_id
     WHERE s.token_hash=$1 AND s.org_id=$2 AND s.user_id=$3 AND s.hostname=$4 AND s.revoked_at IS NULL
       AND s.expires_at>clock_timestamp() AND u.status='active' AND u.archived_at IS NULL AND o.status='active' ${lock?'FOR SHARE OF u,o':''}`,
    [createHash('sha256').update(request.cookies.matraca_session??'').digest('hex'),access.actor.org.id,access.actor.user.id,localHostname(request.headers.host)],
  );
  const user=found.rows[0];if(!user)throw new CreditsAccessError(401,'A sessão foi revogada ou suspensa.');
  const allowed=self?user.roles.includes('student'):access.central?user.kind==='backoffice'&&user.roles.length===1&&user.roles[0]==='operator':user.roles.some(role=>role==='org_admin'||role==='school')&&!user.roles.includes('operator');
  if(!allowed)throw new CreditsAccessError(403,'Você não tem permissão para esta ação.');
  const org=await targetOrg(client,access.org.id,lock);
  return {...access,org,actor:{...access.actor,user:{...access.actor.user,name:user.name,email:user.email,roles:user.roles}}};
}
async function mutate<T>(app:FastifyInstance,request:FastifyRequest,access:Access,fn:(client:PoolClient,current:Access)=>Promise<T>):Promise<T>{
  try{return await app.db.transaction(async(client)=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))',[access.org.id]);
    return fn(client,await refresh(client,request,access,true));
  });}catch(error){if((error as{code?:string}).code==='23505')throw new CreditsAccessError(409,'Evento já utilizado em outra operação.');throw error;}
}
async function studentScope(client:EducationQuery,access:Access,userId:string,self=false):Promise<Student>{
  const student=(await client.query<Student>(`${studentsSelect} ${studentsFrom} WHERE u.org_id=$1 AND u.id=$2
    AND ('student'=ANY(u.roles) OR w.user_id IS NOT NULL)`,[access.org.id,userId])).rows[0];
  if(!student)throw new CreditsAccessError(404,'Aluno não encontrado.');
  if(self){if(access.actor.user.id!==userId||access.actor.org.id!==access.org.id)throw new CreditsAccessError(403,'Carteira de outro usuário.');}
  else if(!access.central&&!isOrgAdmin(access.actor)){
    const allowed=await client.query(`SELECT u.id FROM users u WHERE u.org_id=$1 AND u.id=$4 AND ${SCHOOL_CREDIT_SCOPE_SQL}`,[...scopeValues(access.actor),userId]);
    if(!allowed.rowCount)throw new CreditsAccessError(403,'Você não tem acesso à carteira deste aluno.');
  }
  return student;
}
async function schoolScope(client:EducationQuery,access:Access,schoolId:string):Promise<void>{
  if(access.central){if(!(await client.query('SELECT id FROM schools WHERE org_id=$1 AND id=$2',[access.org.id,schoolId])).rowCount)throw new CreditsAccessError(404,'Escola não encontrada.');}
  else await assertSchoolScope(client,access.actor,schoolId,false);
}
async function policy(client:EducationQuery,orgId:string):Promise<CreditPolicy>{
  return (await client.query<CreditPolicy>('SELECT school_extras_enabled AS "schoolExtrasEnabled",default_school_monthly_limit AS "defaultSchoolMonthlyLimit" FROM org_credit_policies WHERE org_id=$1',[orgId])).rows[0]??{schoolExtrasEnabled:false,defaultSchoolMonthlyLimit:0};
}
async function schoolLimit(client:EducationQuery,orgId:string,schoolId:string){
  const configuration=await policy(client,orgId);
  const override=(await client.query<{monthly_limit:number}>('SELECT monthly_limit FROM school_credit_limits WHERE org_id=$1 AND school_id=$2',[orgId,schoolId])).rows[0];
  const month=(await client.query<{month:string}>("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS month")).rows[0].month;
  const used=Number((await client.query<{used:string}>(`SELECT COALESCE(sum(e.delta),0)::text AS used FROM credit_admin_events a
    JOIN wallet_entries e ON e.id=a.entry_id AND e.org_id=a.org_id AND e.user_id=a.user_id
    WHERE a.org_id=$1 AND a.school_id=$2 AND a.budget_month=$3::date`,[orgId,schoolId,`${month}-01`])).rows[0].used);
  const monthlyLimit=override?.monthly_limit??configuration.defaultSchoolMonthlyLimit;
  return {schoolId,monthlyLimit,used,remaining:Math.max(0,monthlyLimit-used),month,schoolExtrasEnabled:configuration.schoolExtrasEnabled};
}
async function grantPackage(client:EducationQuery,orgId:string,packageId:string):Promise<GrantPackage>{
  const item=(await client.query<GrantPackage>('SELECT id,name,amount,description,status FROM credit_grant_packages WHERE org_id=$1 AND id=$2',[orgId,packageId])).rows[0];
  if(!item)throw new CreditsAccessError(404,'Pacote não encontrado.');return item;
}
async function wallet(client:EducationQuery,orgId:string,userId:string):Promise<WalletState>{
  const state=(await client.query<{balance:number;reserved:number}>('SELECT balance,reserved FROM wallets WHERE org_id=$1 AND user_id=$2',[orgId,userId])).rows[0]??{balance:0,reserved:0};
  return {...state,available:state.balance-state.reserved};
}
const actorNameSQL=`CASE WHEN a.org_id=e.org_id THEN a.name WHEN a.id IS NOT NULL THEN 'Equipe Matraca' ELSE 'Sistema' END`;
function publicEntry({fingerprint:_fingerprint,...value}:WalletEntry&{actorName:string}){return value;}
async function entry(client:EducationQuery,orgId:string,userId:string,entryId:string){
  const row=(await client.query<WalletEntry&{actorName:string}>(`SELECT e.*,${actorNameSQL} AS "actorName" FROM wallet_entries e LEFT JOIN users a ON a.id=e.actor_user_id WHERE e.org_id=$1 AND e.user_id=$2 AND e.id=$3`,[orgId,userId,entryId])).rows[0];
  if(!row)throw new CreditsAccessError(404,'Lançamento não encontrado.');return publicEntry(row);
}
async function move(client:PoolClient,access:Access,userId:string,operation:Operation,input:MovementInput){
  const student=await studentScope(client,access,userId);
  if(operation!=='grant')administrator(access);
  if(operation==='grant'){
    if(access.org.status!=='active'||student.archivedAt||student.status==='suspended'||!student.roles.includes('student'))throw new CreditsAccessError(409,'Aluno ou organização indisponível para receber concessão.');
    if(!access.central&&!isOrgAdmin(access.actor)&&!(await policy(client,access.org.id)).schoolExtrasEnabled)throw new CreditsAccessError(403,'A organização não autorizou concessões extras por escola.');
  }
  const signature=createHash('sha256').update(JSON.stringify([operation,userId,access.actor.user.id,input])).digest('hex');
  const previous=(await client.query<{request_fingerprint:string;entry_id:string}>('SELECT request_fingerprint,entry_id FROM credit_admin_events WHERE org_id=$1 AND event_id=$2',[access.org.id,input.eventId])).rows[0];
  if(previous){if(previous.request_fingerprint!==signature)throw new CreditsAccessError(409,'Evento já utilizado com outros dados.');return {entry:await entry(client,access.org.id,userId,previous.entry_id),wallet:await wallet(client,access.org.id,userId)};}
  let result:WalletEntry,schoolId:string|null=null,budgetMonth:string|null=null;
  const target={orgId:access.org.id,userId},actorUserId=access.actor.user.id,eventKey=`administrative:${input.eventId}`;
  if(operation==='grant'){
    const grant=input as z.infer<typeof grantInput>;
    let quantity=grant.amount!,sourceRef=`manual:${input.eventId}`;
    if(grant.packageId){const item=await grantPackage(client,access.org.id,grant.packageId);if(item.status!=='active')throw new CreditsAccessError(409,'O pacote está arquivado.');quantity=item.amount;sourceRef=`package:${item.id}`;}
    if(!access.central&&!isOrgAdmin(access.actor)){
      if(!student.schoolId)throw new CreditsAccessError(403,'O aluno não pertence a uma escola sob sua gestão.');
      const limit=await schoolLimit(client,access.org.id,student.schoolId);
      if(!limit.schoolExtrasEnabled)throw new CreditsAccessError(403,'A organização não autorizou concessões extras por escola.');
      if(quantity>limit.remaining)throw new CreditsAccessError(409,'O limite mensal de concessões da escola seria excedido.');
      schoolId=student.schoolId;budgetMonth=`${limit.month}-01`;
    }
    result=await grantCreditsInTransaction(client,{...target,amount:quantity,source:'manual',sourceRef,eventKey,reason:input.reason,actorUserId});
  }else if(operation==='adjust'){
    result=await adjustCreditsInTransaction(client,{...target,delta:(input as z.infer<typeof adjustInput>).delta,eventKey,reason:input.reason,actorUserId});
  }else result=await refundConsumptionInTransaction(client,{...target,entryId:(input as z.infer<typeof refundInput>).entryId,reason:input.reason,actorUserId});
  await client.query('INSERT INTO credit_admin_events(org_id,event_id,operation,user_id,actor_user_id,school_id,budget_month,request_fingerprint,entry_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[access.org.id,input.eventId,operation,userId,actorUserId,schoolId,budgetMonth,signature,result.id]);
  await audit(client,access,`credits_${operation}`,{studentId:userId,entryId:result.id});
  return {entry:await entry(client,access.org.id,userId,result.id),wallet:await wallet(client,access.org.id,userId)};
}
async function statement(app:FastifyInstance,request:FastifyRequest,access:Access,userId:string,query:z.infer<typeof statementQuery>,self=false){
  return app.db.transaction(async(client)=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const current=await refresh(client,request,access,false,self),student=await studentScope(client,current,userId,self);
    const values:unknown[]=[current.org.id,userId];let where='e.org_id=$1 AND e.user_id=$2';
    const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
    if(query.source)where+=` AND e.source=${bind(query.source as CreditSource)}`;
    if(query.from)where+=` AND e.created_at>=(${bind(query.from)}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
    if(query.to)where+=` AND e.created_at<((${bind(query.to)}::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
    if(query.actorSearch)where+=` AND (${actorNameSQL}) ILIKE ${bind(`%${escapeLike(query.actorSearch)}%`)}`;
    const total=(await client.query<{total:number}>(`SELECT count(*)::integer AS total FROM wallet_entries e LEFT JOIN users a ON a.id=e.actor_user_id WHERE ${where}`,values)).rows[0].total;
    const limit=bind(query.limit),offset=bind((query.page-1)*query.limit);
    const entries=await client.query<WalletEntry&{actorName:string}>(`SELECT e.*,${actorNameSQL} AS "actorName" FROM wallet_entries e LEFT JOIN users a ON a.id=e.actor_user_id WHERE ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT ${limit} OFFSET ${offset}`,values);
    const reservations=await client.query('SELECT * FROM credit_reservations WHERE org_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',[current.org.id,userId]);
    const origins=await client.query('SELECT l.entry_id,e.source,e.source_ref,l.quantity,l.remaining FROM credit_lots l JOIN wallet_entries e ON e.id=l.entry_id AND e.org_id=l.org_id AND e.user_id=l.user_id WHERE l.org_id=$1 AND l.user_id=$2 AND l.remaining>0 ORDER BY l.created_at,l.entry_id',[current.org.id,userId]);
    return {org:publicOrg(current.org),student,wallet:await wallet(client,current.org.id,userId),entries:entries.rows.map(publicEntry),reservations:reservations.rows,origins:origins.rows,page:query.page,limit:query.limit,total};
  });
}
async function audit(client:PoolClient,access:Access,event:string,metadata:Record<string,unknown>={}){
  await client.query('INSERT INTO audit_events(org_id,actor_user_id,event_type,metadata) VALUES($1,$2,$3,$4)',[access.actor.org.id,access.actor.user.id,event,{targetOrgId:access.org.id,...metadata}]);
}
