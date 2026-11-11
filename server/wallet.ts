import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './db.js';

export type CreditSource = 'initial' | 'lesson' | 'module' | 'course' | 'purchase' | 'manual' | 'leaderboard' | 'evaluation' | 'refund' | 'adjustment';
export type CreditTarget = { orgId: string; userId: string };
export interface WalletState { balance: number; reserved: number; available: number }
export interface WalletEntry {
  id: string; org_id: string; user_id: string; delta: number; kind: string;
  source: CreditSource; source_ref: string; event_key: string; fingerprint: string;
  actor_user_id: string | null; reason: string; reverses_entry_id: string | null; created_at: Date;
}
export interface CreditReservation {
  id: string; org_id: string; user_id: string; request_id: string; duration_us: string;
  amount: number; status: 'reserved' | 'consumed' | 'released'; consumption_entry_id: string | null;
  release_reason: string | null; created_at: Date; settled_at: Date | null;
}
export class CreditError extends Error {
  constructor(public readonly statusCode: 400 | 402 | 404 | 409, message: string) { super(message); this.name = 'CreditError'; }
}
const MAX_BALANCE = 1_000_000_000;
const MINUTE_US = 60_000_000;

/** Call only with the server-verified presentation duration, never browser metadata. */
export function creditsForDuration(durationMicroseconds: number): number {
  if (!Number.isSafeInteger(durationMicroseconds) || durationMicroseconds <= 0) throw new CreditError(400, 'Duração de mídia inválida.');
  const credits = Math.ceil(durationMicroseconds / MINUTE_US);
  if (credits > 1_000_000) throw new CreditError(400, 'Duração excede a capacidade permitida.');
  return credits;
}
function text(value: string, maximum: number, field: string) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) throw new CreditError(400, `${field} inválido.`);
  return value;
}
function quantity(value: number, allowNegative = false) {
  if (!Number.isSafeInteger(value) || value === 0 || Math.abs(value) > 1_000_000 || (!allowNegative && value < 0)) {
    throw new CreditError(400, 'Quantidade de créditos inválida.');
  }
  return value;
}
function fingerprint(parts: unknown[]) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function state(row: { balance: number; reserved: number }): WalletState { return { ...row, available: row.balance - row.reserved }; }
async function lockWallet(client: PoolClient, target: CreditTarget): Promise<WalletState> {
  // Login locks the user before granting its initial credit. Match that ordering
  // before inserting a wallet, whose foreign key can otherwise form a lock cycle.
  const owner=await client.query('SELECT id FROM users WHERE id=$1 AND org_id=$2 FOR KEY SHARE',[target.userId,target.orgId]);
  if(!owner.rowCount)throw new CreditError(404,'Titular da carteira não encontrado.');
  await client.query('INSERT INTO wallets (org_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [target.orgId,target.userId]);
  const result = await client.query<{balance:number;reserved:number}>('SELECT balance,reserved FROM wallets WHERE org_id=$1 AND user_id=$2 FOR UPDATE', [target.orgId,target.userId]);
  return state(result.rows[0]);
}
async function allocateDebit(client: PoolClient,target: CreditTarget,entryId: string,amount: number) {
  const lots = await client.query<{entry_id:string;remaining:number}>(
    'SELECT entry_id,remaining FROM credit_lots WHERE org_id=$1 AND user_id=$2 AND remaining>0 ORDER BY created_at,entry_id FOR UPDATE',
    [target.orgId,target.userId]);
  let needed = amount;
  for (const lot of lots.rows) {
    if (!needed) break;
    const used = Math.min(needed,lot.remaining);
    await client.query('UPDATE credit_lots SET remaining=remaining-$2 WHERE entry_id=$1',[lot.entry_id,used]);
    await client.query('INSERT INTO credit_allocations (debit_entry_id,lot_entry_id,amount,org_id,user_id) VALUES ($1,$2,$3,$4,$5)',[entryId,lot.entry_id,used,target.orgId,target.userId]);
    needed -= used;
  }
  if (needed) throw new CreditError(409,'A carteira precisa de conciliação antes deste consumo.');
}
export async function getWallet(db: Database, target: CreditTarget): Promise<WalletState> {
  const found = await db.query<{balance:number;reserved:number}>('SELECT balance,reserved FROM wallets WHERE org_id=$1 AND user_id=$2', [target.orgId,target.userId]);
  return state(found.rows[0] ?? { balance:0,reserved:0 });
}
type Movement = CreditTarget & {
  delta: number; kind: 'grant' | 'adjustment'; source: CreditSource; sourceRef: string;
  eventKey: string; reason: string; actorUserId?: string;
};
async function applyMovement(db: Database, input: Movement): Promise<WalletEntry> {
  try { return await db.transaction(client=>applyMovementInTransaction(client,input)); }
  catch(error) {
    if ((error as {code?:string}).code === '23505') throw new CreditError(409,'Este evento já foi usado com outra movimentação.');
    throw error;
  }
}
async function applyMovementInTransaction(client:PoolClient,input:Movement):Promise<WalletEntry> {
  quantity(input.delta,input.kind==='adjustment');
  text(input.eventKey,200,'Identificador do evento'); text(input.sourceRef,160,'Origem'); text(input.reason,500,'Motivo');
  const signature = fingerprint([input.userId,input.delta,input.kind,input.source,input.sourceRef,input.reason,input.actorUserId??null]);
      const wallet = await lockWallet(client,input);
      const duplicate = await client.query<WalletEntry>('SELECT * FROM wallet_entries WHERE org_id=$1 AND event_key=$2',[input.orgId,input.eventKey]);
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].fingerprint !== signature) throw new CreditError(409,'Este evento já foi usado com outra movimentação.');
        return duplicate.rows[0];
      }
      const next = wallet.balance + input.delta;
      if (next < wallet.reserved) throw new CreditError(402,'Saldo disponível insuficiente para este ajuste.');
      if (next > MAX_BALANCE) throw new CreditError(400,'Limite de saldo da carteira excedido.');
      const result = await client.query<WalletEntry>(
        `INSERT INTO wallet_entries (org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,actor_user_id,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [input.orgId,input.userId,input.delta,input.kind,input.source,input.sourceRef,input.eventKey,signature,input.actorUserId??null,input.reason]);
      if (input.delta>0) await client.query('INSERT INTO credit_lots (entry_id,org_id,user_id,quantity,remaining) VALUES ($1,$2,$3,$4,$4)',[result.rows[0].id,input.orgId,input.userId,input.delta]);
      else await allocateDebit(client,input,result.rows[0].id,-input.delta);
      await client.query('UPDATE wallets SET balance=$3,updated_at=now() WHERE org_id=$1 AND user_id=$2',[input.orgId,input.userId,next]);
      return result.rows[0];
}
type GrantInput = CreditTarget & { amount: number; source: CreditSource; sourceRef: string; eventKey: string; reason: string; actorUserId?: string };
type AdjustmentInput = CreditTarget & { delta: number; eventKey: string; reason: string; actorUserId: string };
function grantMovement(input:GrantInput):Movement {
  if (!['initial','lesson','module','course','purchase','manual','leaderboard'].includes(input.source)) throw new CreditError(400,'Origem de concessão inválida.');
  text(input.eventKey,160,'Identificador do evento');
  return {...input,eventKey:`grant:${input.source}:${input.eventKey}`,delta:input.amount,kind:'grant'};
}
function adjustmentMovement(input:AdjustmentInput):Movement {
  text(input.eventKey,160,'Identificador do evento');
  return {...input,eventKey:`adjustment:${input.eventKey}`,kind:'adjustment',source:'adjustment',sourceRef:input.eventKey};
}
export function grantCredits(db:Database,input:GrantInput) { return applyMovement(db,grantMovement(input)); }
export function grantCreditsInTransaction(client:PoolClient,input:GrantInput) { return applyMovementInTransaction(client,grantMovement(input)); }
export function adjustCredits(db:Database,input:AdjustmentInput) { return applyMovement(db,adjustmentMovement(input)); }
export function adjustCreditsInTransaction(client:PoolClient,input:AdjustmentInput) { return applyMovementInTransaction(client,adjustmentMovement(input)); }
export function grantInitialCreditInTransaction(client:PoolClient,target:CreditTarget) {
  return grantCreditsInTransaction(client,{...target,amount:1,source:'initial',sourceRef:target.userId,eventKey:`initial:${target.userId}`,reason:'Crédito inicial para diagnóstico'});
}
export function grantInitialCredit(db: Database,target: CreditTarget) {
  return grantCredits(db,{...target,amount:1,source:'initial',sourceRef:target.userId,eventKey:`initial:${target.userId}`,reason:'Crédito inicial para diagnóstico'});
}
type ReserveCreditInput = CreditTarget & { requestId: string; durationMicroseconds: number };

export async function reserveCredits(db: Database, input: ReserveCreditInput): Promise<CreditReservation> {
  try {
    return await db.transaction(client => reserveCreditsInTransaction(client, input));
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new CreditError(409, 'Pedido já associado a outra reserva.');
    }
    throw error;
  }
}

export async function reserveCreditsInTransaction(client: PoolClient, input: ReserveCreditInput): Promise<CreditReservation> {
  const amount = creditsForDuration(input.durationMicroseconds);
  text(input.requestId, 160, 'Pedido');
  const wallet = await lockWallet(client, input);
  const found = await client.query<CreditReservation>(
    'SELECT * FROM credit_reservations WHERE org_id=$1 AND request_id=$2', [input.orgId, input.requestId],
  );
  const existing = found.rows[0];
  if (existing) {
    if (existing.user_id !== input.userId || Number(existing.duration_us) !== input.durationMicroseconds) {
      throw new CreditError(409, 'Pedido já associado a outra reserva.');
    }
    return existing;
  }
  if (wallet.available < amount) throw new CreditError(402, 'Créditos disponíveis insuficientes para avaliar esta gravação.');
  const inserted = await client.query<CreditReservation>(
    'INSERT INTO credit_reservations (org_id,user_id,request_id,duration_us,amount) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [input.orgId, input.userId, input.requestId, input.durationMicroseconds, amount],
  );
  await client.query('UPDATE wallets SET reserved=reserved+$3,updated_at=now() WHERE org_id=$1 AND user_id=$2', [input.orgId, input.userId, amount]);
  return inserted.rows[0];
}
async function reservation(client: PoolClient,target: CreditTarget,requestId: string) {
  const found = await client.query<CreditReservation>('SELECT * FROM credit_reservations WHERE org_id=$1 AND user_id=$2 AND request_id=$3 FOR UPDATE',[target.orgId,target.userId,requestId]);
  if (!found.rows[0]) throw new CreditError(404,'Reserva não encontrada.');
  return found.rows[0];
}
export async function consumeReservation(db: Database,input: CreditTarget & {requestId:string}): Promise<CreditReservation> {
  return db.transaction(client => consumeReservationInTransaction(client,input));
}
/** Shares the evaluation-result transaction so a crash cannot charge without a result. */
export async function consumeReservationInTransaction(client: PoolClient,input: CreditTarget & {requestId:string}): Promise<CreditReservation> {
    await lockWallet(client,input);
    const item = await reservation(client,input,input.requestId);
    if (item.status==='consumed') return item;
    if (item.status==='released') throw new CreditError(409,'A reserva já foi liberada.');
    const eventKey = `evaluation:${item.id}`;
    const entry = await client.query<WalletEntry>(
      `INSERT INTO wallet_entries (org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,reason)
       VALUES ($1,$2,$3,'consumption','evaluation',$4,$5,$6,$7) RETURNING *`,
      [input.orgId,input.userId,-item.amount,item.request_id,eventKey,fingerprint([item.id,item.amount]),'Avaliação concluída']);
    await allocateDebit(client,input,entry.rows[0].id,item.amount);
    await client.query('UPDATE wallets SET balance=balance-$3,reserved=reserved-$3,updated_at=now() WHERE org_id=$1 AND user_id=$2',[input.orgId,input.userId,item.amount]);
    const result = await client.query<CreditReservation>("UPDATE credit_reservations SET status='consumed',consumption_entry_id=$2,settled_at=now() WHERE id=$1 RETURNING *",[item.id,entry.rows[0].id]);
    return result.rows[0];
}
type ReleaseCreditInput = CreditTarget & { requestId: string; reason: string };

export async function releaseReservation(db: Database, input: ReleaseCreditInput): Promise<CreditReservation> {
  return db.transaction(client => releaseReservationInTransaction(client, input));
}

export async function releaseReservationInTransaction(client: PoolClient, input: ReleaseCreditInput): Promise<CreditReservation> {
  text(input.reason, 500, 'Motivo');
  await lockWallet(client, input);
  const item = await reservation(client, input, input.requestId);
  if (item.status === 'released') return item;
  if (item.status === 'consumed') throw new CreditError(409, 'Uma avaliação consumida exige estorno registrado.');
  await client.query('UPDATE wallets SET reserved=reserved-$3,updated_at=now() WHERE org_id=$1 AND user_id=$2', [input.orgId, input.userId, item.amount]);
  const result = await client.query<CreditReservation>(
    "UPDATE credit_reservations SET status='released',release_reason=$2,settled_at=now() WHERE id=$1 RETURNING *", [item.id, input.reason],
  );
  return result.rows[0];
}
export async function refundConsumption(db: Database,input: CreditTarget & {entryId:string;reason:string;actorUserId?:string}): Promise<WalletEntry> {
  return db.transaction(client => refundConsumptionInTransaction(client,input));
}
export async function refundConsumptionInTransaction(client:PoolClient,input:CreditTarget & {entryId:string;reason:string;actorUserId?:string}):Promise<WalletEntry> {
  text(input.reason,500,'Motivo');
    const wallet = await lockWallet(client,input);
    const found = await client.query<WalletEntry>("SELECT * FROM wallet_entries WHERE id=$1 AND org_id=$2 AND user_id=$3 AND kind='consumption'",[input.entryId,input.orgId,input.userId]);
    const original = found.rows[0]; if (!original) throw new CreditError(404,'Consumo não encontrado.');
    const existing = await client.query<WalletEntry>('SELECT * FROM wallet_entries WHERE reverses_entry_id=$1',[original.id]);
    if (existing.rows[0]) return existing.rows[0];
    const amount = -original.delta;
    if (wallet.balance+amount>MAX_BALANCE) throw new CreditError(409,'Saldo excederia o limite após o estorno.');
    const inserted = await client.query<WalletEntry>(
      `INSERT INTO wallet_entries (org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,actor_user_id,reason,reverses_entry_id)
       VALUES ($1,$2,$3,'refund','refund',$4::text,$5,$6,$7,$8,$4::uuid) RETURNING *`,
      [input.orgId,input.userId,amount,original.id,`refund:${original.id}`,fingerprint([original.id,amount]),input.actorUserId??null,input.reason]);
    const allocations = await client.query<{lot_entry_id:string;amount:number}>('SELECT lot_entry_id,amount FROM credit_allocations WHERE debit_entry_id=$1',[original.id]);
    if (allocations.rows.reduce((sum,row)=>sum+row.amount,0)!==amount) throw new CreditError(409,'Origem do consumo precisa de conciliação.');
    for (const allocation of allocations.rows) await client.query('UPDATE credit_lots SET remaining=remaining+$2 WHERE entry_id=$1',[allocation.lot_entry_id,allocation.amount]);
    await client.query('UPDATE wallets SET balance=balance+$3,updated_at=now() WHERE org_id=$1 AND user_id=$2',[input.orgId,input.userId,amount]);
    return inserted.rows[0];
}
export async function walletStatement(db: Database,target: CreditTarget,page=1,limit=25) {
  if (!Number.isInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100) throw new CreditError(400,'Paginação inválida.');
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const balance = await client.query<{balance:number;reserved:number}>('SELECT balance,reserved FROM wallets WHERE org_id=$1 AND user_id=$2',[target.orgId,target.userId]);
    const entries = await client.query<WalletEntry>('SELECT * FROM wallet_entries WHERE org_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4',[target.orgId,target.userId,limit,(page-1)*limit]);
    const reservations = await client.query<CreditReservation>('SELECT * FROM credit_reservations WHERE org_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',[target.orgId,target.userId]);
    const total = await client.query<{count:number}>('SELECT count(*)::int AS count FROM wallet_entries WHERE org_id=$1 AND user_id=$2',[target.orgId,target.userId]);
    const origins = await client.query('SELECT l.entry_id,e.source,e.source_ref,l.quantity,l.remaining FROM credit_lots l JOIN wallet_entries e ON e.id=l.entry_id WHERE l.org_id=$1 AND l.user_id=$2 AND l.remaining>0 ORDER BY l.created_at,l.entry_id',[target.orgId,target.userId]);
    return {wallet:state(balance.rows[0]??{balance:0,reserved:0}),entries:entries.rows.map(({fingerprint:_fingerprint,...entry})=>entry),reservations:reservations.rows,origins:origins.rows,page,limit,total:total.rows[0].count};
  });
}
