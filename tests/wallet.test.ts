import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import {
  adjustCredits, consumeReservation, consumeReservationInTransaction, creditsForDuration,
  getWallet, grantCredits, grantInitialCredit, grantInitialCreditInTransaction, refundConsumption, releaseReservation,
  reserveCredits, walletStatement, type CreditTarget,
} from '../server/wallet.js';

describe('carteira transacional e origens de créditos', () => {
  const schema = `wallet_test_${randomUUID().replaceAll('-','')}`;
  let control: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    const base = process.env.DATABASE_URL ?? localDatabaseUrl;
    control = createDatabase(base);
    await control.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base); url.searchParams.set('options',`-c search_path=${schema}`);
    db = createDatabase(url.toString());
    const directory = new URL('../server/migrations/',import.meta.url);
    for (const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()) {
      await db.query(await readFile(new URL(name,directory),'utf8'));
    }
  });
  afterAll(async () => {
    await db?.close();
    if (control) { try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); } }
  });
  async function student(orgId:string=randomUUID()): Promise<CreditTarget> {
    await db.query("INSERT INTO orgs (id,slug,name,kind) VALUES ($1,$2,'Carteira sintética','partner') ON CONFLICT DO NOTHING",[orgId,`wallet-${orgId}`]);
    const userId = randomUUID();
    await db.query("INSERT INTO users (id,org_id,email,name,roles,status) VALUES ($1,$2,$3,'Aluno sintético',ARRAY['student'],'active')",[userId,orgId,`${userId}@example.test`]);
    return {orgId,userId};
  }
  function grant(target:CreditTarget,amount:number,eventKey:string=randomUUID()) {
    return grantCredits(db,{...target,amount,eventKey,source:'manual',sourceRef:'test',reason:'Concessão sintética'});
  }
  const reserve=(target:CreditTarget,requestId:string,durationMicroseconds=30_000_000)=>reserveCredits(db,{...target,requestId,durationMicroseconds});

  it.each([[30,1],[60,1],[61,2],[119,2],[300,5],[301,6]])('arredonda %is para %i créditos', (seconds,expected) => {
    expect(creditsForDuration(seconds*1_000_000)).toBe(expected);
  });
  it('preserva o limite exato até no primeiro microssegundo seguinte',()=> {
    expect(creditsForDuration(60_000_000)).toBe(1);
    expect(creditsForDuration(60_000_001)).toBe(2);
    for (const duration of [0,-1,1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER]) expect(()=>creditsForDuration(duration)).toThrow();
  });
  it('concede o diagnóstico uma única vez mesmo sob concorrência',async()=> {
    const target=await student();
    const entries=await Promise.all(Array.from({length:8},()=>grantInitialCredit(db,target)));
    expect(new Set(entries.map(entry=>entry.id)).size).toBe(1);
    expect(await getWallet(db,target)).toEqual({balance:1,reserved:0,available:1});
  });
  it('primeira concessão simultânea ao login respeita a ordem usuário antes de carteira',async()=> {
    const target=await student();
    const login=await db.pool.connect();
    let manual:Promise<string|null>|undefined;
    let loginError:string|undefined;
    try {
      await login.query('BEGIN');
      await login.query('SELECT id FROM users WHERE org_id=$1 AND id=$2 FOR UPDATE',[target.orgId,target.userId]);
      const pid=(await login.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      manual=grant(target,2).then(()=>null,error=>(error as{code?:string;message:string}).code??(error as Error).message);
      let blocked=false;
      for(let attempt=0;attempt<200&&!blocked;attempt++) {
        blocked=(await control.query<{blocked:boolean}>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked;
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,5));
      }
      expect(blocked).toBe(true);
      try {
        await grantInitialCreditInTransaction(login,target);
        await login.query('COMMIT');
      } catch(error) {
        loginError=(error as{code?:string}).code??(error as Error).message;
        await login.query('ROLLBACK');
      }
      expect(await manual).toBeNull();
      expect(loginError).toBeUndefined();
      expect(await getWallet(db,target)).toEqual({balance:3,reserved:0,available:3});
    } finally {
      await login.query('ROLLBACK');
      login.release();
      await manual;
    }
  });
  it('não reutiliza uma chave de concessão com outro valor ou aluno',async()=> {
    const target=await student(); const other=await student(target.orgId);
    const key=randomUUID(); await grant(target,3,key);
    await expect(grant(target,4,key)).rejects.toMatchObject({statusCode:409});
    await expect(grant(other,3,key)).rejects.toMatchObject({statusCode:409});
    expect((await getWallet(db,target)).balance).toBe(3);
    expect((await getWallet(db,other)).balance).toBe(0);
  });
  it('somente um pedido concorrente reserva o último crédito',async()=> {
    const target=await student(); await grant(target,1);
    const results=await Promise.allSettled([reserve(target,'first'),reserve(target,'second')]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{statusCode:402}});
    expect(await getWallet(db,target)).toEqual({balance:1,reserved:1,available:0});
  });
  it('repete reserva idempotentemente sem alterar duração ou titular',async()=> {
    const target=await student(); const other=await student(target.orgId); await grant(target,4); await grant(other,4);
    const first=await reserve(target,'same',61_000_000);
    expect((await reserve(target,'same',61_000_000)).id).toBe(first.id);
    await expect(reserve(target,'same',30_000_000)).rejects.toMatchObject({statusCode:409});
    await expect(reserve(other,'same',61_000_000)).rejects.toMatchObject({statusCode:409});
    expect((await getWallet(db,target)).reserved).toBe(2);
  });
  it('consome uma vez, mantém FIFO e estorna às origens exatas uma vez',async()=> {
    const target=await student(); const first=await grant(target,2); const second=await grant(target,4);
    await reserve(target,'evaluation',180_000_000);
    const used=await consumeReservation(db,{...target,requestId:'evaluation'});
    expect((await consumeReservation(db,{...target,requestId:'evaluation'})).id).toBe(used.id);
    const lots=await db.query('SELECT entry_id,remaining FROM credit_lots WHERE user_id=$1 ORDER BY created_at,entry_id',[target.userId]);
    expect(lots.rows).toEqual([{entry_id:first.id,remaining:0},{entry_id:second.id,remaining:3}]);
    expect(await getWallet(db,target)).toEqual({balance:3,reserved:0,available:3});
    const refunded=await refundConsumption(db,{...target,entryId:used.consumption_entry_id!,reason:'Revisão operacional'});
    expect((await refundConsumption(db,{...target,entryId:used.consumption_entry_id!,reason:'Repetição'})).id).toBe(refunded.id);
    expect(await getWallet(db,target)).toEqual({balance:6,reserved:0,available:6});
    expect((await walletStatement(db,target)).origins.map(row=>row.remaining)).toEqual([2,4]);
    await expect(releaseReservation(db,{...target,requestId:'evaluation',reason:'Tarde'})).rejects.toMatchObject({statusCode:409});
  });
  it('falha ou cancelamento libera a reserva e não permite consumo posterior',async()=> {
    const target=await student(); await grant(target,1); await reserve(target,'failure');
    await releaseReservation(db,{...target,requestId:'failure',reason:'Provedor indisponível'});
    await releaseReservation(db,{...target,requestId:'failure',reason:'Retentativa técnica'});
    expect((await reserve(target,'failure')).status).toBe('released');
    await expect(consumeReservation(db,{...target,requestId:'failure'})).rejects.toMatchObject({statusCode:409});
    expect(await getWallet(db,target)).toEqual({balance:1,reserved:0,available:1});
    expect((await walletStatement(db,target)).entries).toHaveLength(1);
  });
  it('reverte cobrança e alocações se a persistência do resultado falhar na mesma transação',async()=> {
    const target=await student(); await grant(target,2); await reserve(target,'atomic');
    await expect(db.transaction(async client=> {
      await consumeReservationInTransaction(client,{...target,requestId:'atomic'});
      throw new Error('Resultado não persistido');
    })).rejects.toThrow('Resultado não persistido');
    expect(await getWallet(db,target)).toEqual({balance:2,reserved:1,available:1});
    expect((await walletStatement(db,target)).origins[0].remaining).toBe(2);
    expect((await walletStatement(db,target)).entries).toHaveLength(1);
  });
  it('ajuste negativo não retira créditos reservados e é uma nova entrada auditável',async()=> {
    const target=await student(); await grant(target,3); await reserve(target,'held',120_000_000);
    await expect(adjustCredits(db,{...target,delta:-2,eventKey:'too-much',reason:'Correção',actorUserId:target.userId})).rejects.toMatchObject({statusCode:402});
    await adjustCredits(db,{...target,delta:-1,eventKey:'adjust',reason:'Correção',actorUserId:target.userId});
    expect(await getWallet(db,target)).toEqual({balance:2,reserved:2,available:0});
    expect((await walletStatement(db,target)).entries.map(entry=>entry.delta)).toEqual([-1,3]);
  });
  it('separa namespace externo de concessões dos consumos internos',async()=> {
    const target=await student(); await grant(target,2); const reservation=await reserve(target,'protected');
    await grant(target,1,`evaluation:${reservation.id}`);
    await consumeReservation(db,{...target,requestId:'protected'});
    expect((await getWallet(db,target)).balance).toBe(2);
    expect(()=>grantCredits(db,{...target,amount:1,source:'evaluation',sourceRef:'wrong',eventKey:'wrong',reason:'Inválido'})).toThrow();
  });
  it('isola carteiras e impede referências financeiras cruzadas no banco',async()=> {
    const target=await student(); const other=await student(); await grant(target,2); const otherEntry=await grant(other,2);
    await reserve(target,'private'); const used=await consumeReservation(db,{...target,requestId:'private'});
    await expect(refundConsumption(db,{...other,entryId:used.consumption_entry_id!,reason:'Cruzado'})).rejects.toMatchObject({statusCode:404});
    await expect(db.query('INSERT INTO credit_lots (entry_id,org_id,user_id,quantity,remaining) VALUES ($1,$2,$3,1,1)',[used.consumption_entry_id,other.orgId,other.userId])).rejects.toMatchObject({code:'23503'});
    await expect(db.query('INSERT INTO credit_allocations (debit_entry_id,lot_entry_id,org_id,user_id,amount) VALUES ($1,$2,$3,$4,1)',[used.consumption_entry_id,otherEntry.id,other.orgId,other.userId])).rejects.toMatchObject({code:'23503'});
    await expect(db.query("INSERT INTO wallet_entries (org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,reason,reverses_entry_id) VALUES ($1,$2,1,'refund','refund','synthetic',$3,'synthetic','Estorno cruzado',$4)", [other.orgId,other.userId,randomUUID(),used.consumption_entry_id])).rejects.toMatchObject({code:'23503'});
    await expect(db.query('UPDATE credit_reservations SET org_id=$1,user_id=$2 WHERE id=$3', [other.orgId,other.userId,used.id])).rejects.toMatchObject({code:'23503'});
    expect((await getWallet(db,other)).balance).toBe(2);
  });
  it('proíbe editar ou apagar lançamentos e pagina o extrato sem fingerprints',async()=> {
    const target=await student(); const entry=await grant(target,1); await grant(target,2);
    await expect(db.query('UPDATE wallet_entries SET reason=$2 WHERE id=$1',[entry.id,'Alterado'])).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM wallet_entries WHERE id=$1',[entry.id])).rejects.toThrow('append-only');
    const page=await walletStatement(db,target,2,1);
    expect(page.total).toBe(2); expect(page.entries).toHaveLength(1); expect(page.entries[0]).not.toHaveProperty('fingerprint');
    expect(page.wallet).toEqual({balance:3,reserved:0,available:3});
  });
});
