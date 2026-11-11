import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { localDatabaseUrl } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { allocateBilledUsage, closeBillingPeriod } from '../server/billing.js';
import { nextMonth } from '../server/billing-preview.js';

interface Actor { orgId: string; userId: string; host: string; cookie: string }
const table = { mode: 'volume', tiers: [{ from: 1, to: null, unitPriceCents: 90 }] };
const prices = { organizationCents: 100_000, schoolCents: 10_000, studentCents: 100 };
const month = '2026-04', next = '2026-05';
const headers = (actor: Actor) => ({ host: actor.host, cookie: actor.cookie, 'x-matraca-request': '1', origin: `http://${actor.host}` });

describe('faturamento com histórico de corte, vigência e conciliação', () => {
  const schema = `billing_test_${randomUUID().replaceAll('-', '')}`;
  let app: FastifyInstance, db: ReturnType<typeof createDatabase>, control: ReturnType<typeof createDatabase>, root: string;
  let financialNow = new Date('2026-05-02T12:00:00Z');
  beforeAll(async () => {
    const base = process.env.DATABASE_URL ?? localDatabaseUrl; control = createDatabase(base); await control.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base); url.searchParams.set('options', `-c search_path=${schema}`); db = createDatabase(url.toString());
    const directory = new URL('../server/migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(name, directory), 'utf8'));
    root = await mkdtemp(join(tmpdir(), 'matraca-billing-'));
    app = await createApp({ databaseUrl: url.toString(), storageRoot: join(root, 'objects'), billingNow: () => financialNow });
  });
  afterAll(async () => {
    await app?.close(); await db?.close();
    if (control) { try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.close(); } }
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function actor(role = 'org_admin', orgId: string = randomUUID(), kind = 'partner'): Promise<Actor> {
    const host = `billing-${orgId}.localhost`, userId = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO orgs(id,slug,name,kind) VALUES($1,$2,'Organização sintética',$3) ON CONFLICT DO NOTHING", [orgId, `billing-${orgId}`, kind]);
    await db.query('INSERT INTO domains(hostname,org_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [host, orgId]);
    await db.query("INSERT INTO users(id,org_id,name,email,roles,status) VALUES($1,$2,'Pessoa sintética',$3,$4,'active')", [userId, orgId, `${userId}@example.test`, [role]]);
    await db.query("INSERT INTO sessions(org_id,user_id,hostname,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [orgId, userId, host, createHash('sha256').update(token).digest('hex')]);
    return { orgId, userId, host, cookie: `matraca_session=${token}` };
  }
  const central = (org: Actor) => `/api/backoffice/billing/orgs/${org.orgId}`;
  const get = (who: Actor, path: string) => app.inject({ method: 'GET', url: path, headers: headers(who) });
  const post = (who: Actor, path: string, payload: object) => app.inject({ method: 'POST', url: path, headers: headers(who), payload });
  async function fixture(schoolCount = 0, studentCount = 0) {
    financialNow = new Date('2026-05-02T12:00:00Z');
    const operator = await actor('operator', randomUUID(), 'backoffice'), admin = await actor();
    // Explicit synthetic historical fixtures, never reconstruction of the demonstration's past state.
    await db.query("UPDATE billing_observation_coverage SET tracked_since='2026-04-01T03:00:00Z' WHERE org_id=$1", [admin.orgId]);
    const schools: string[] = [], students: Actor[] = [];
    for (let index = 0; index < schoolCount; index++) {
      const id = randomUUID(); schools.push(id);
      await db.query("INSERT INTO schools(id,org_id,name) VALUES($1,$2,'Escola sintética')", [id, admin.orgId]);
      await db.query("INSERT INTO billing_school_history(org_id,school_id,observed_at,active) VALUES($1,$2,'2026-04-01T04:00:00Z',true)", [admin.orgId, id]);
    }
    for (let index = 0; index < studentCount; index++) {
      const student = await actor('student', admin.orgId); students.push(student);
      await db.query("INSERT INTO billing_student_history(org_id,user_id,observed_at,active,student,accepted) VALUES($1,$2,'2026-04-01T04:00:00Z',true,true,true)", [admin.orgId, student.userId]);
    }
    expect((await post(operator, `${central(admin)}/contracts`, { effectiveFrom: month, expectedRevision: 0, licenses: prices, credits: table })).statusCode).toBe(201);
    return { operator, admin, schools, students };
  }
  async function consume(student: Actor, amount: number, createdAt = '2026-04-15T15:00:00Z') {
    const grantId = randomUUID(), entryId = randomUUID();
    await db.query('INSERT INTO wallets(org_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [student.orgId, student.userId]);
    await db.query(`INSERT INTO wallet_entries(id,org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,reason,created_at)
      VALUES($1,$2,$3,$4,'grant','manual','fixture',$5,'synthetic','Fixture',$6)`, [grantId, student.orgId, student.userId, amount, randomUUID(), createdAt]);
    await db.query('INSERT INTO credit_lots(entry_id,org_id,user_id,quantity,remaining,created_at) VALUES($1,$2,$3,$4,0,$5)', [grantId, student.orgId, student.userId, amount, createdAt]);
    await db.query(`INSERT INTO wallet_entries(id,org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,reason,created_at)
      VALUES($1,$2,$3,$4,'consumption','evaluation','fixture',$5,'synthetic','Fixture',$6)`, [entryId, student.orgId, student.userId, -amount, randomUUID(), createdAt]);
    await db.query('INSERT INTO credit_allocations(debit_entry_id,lot_entry_id,org_id,user_id,amount) VALUES($1,$2,$3,$4,$5)', [entryId, grantId, student.orgId, student.userId, amount]);
    return { entryId, grantId, amount };
  }
  async function refund(student: Actor, consumed: Awaited<ReturnType<typeof consume>>, createdAt: string) {
    const id = randomUUID();
    await db.query(`INSERT INTO wallet_entries(id,org_id,user_id,delta,kind,source,source_ref,event_key,fingerprint,reason,reverses_entry_id,created_at)
      VALUES($1,$2,$3,$4,'refund','refund','fixture',$5,'synthetic','Estorno sintético',$6,$7)`, [id, student.orgId, student.userId, consumed.amount, randomUUID(), consumed.entryId, createdAt]);
    await db.query('UPDATE wallets SET balance=balance+$3 WHERE org_id=$1 AND user_id=$2', [student.orgId, student.userId, consumed.amount]);
    await db.query('UPDATE credit_lots SET remaining=remaining+$2 WHERE entry_id=$1', [consumed.grantId, consumed.amount]);
    return id;
  }

  it('prévia e fechamento reproduzem R$ 1.440 sem duplicar sob concorrência', async () => {
    const f = await fixture(3, 50); await consume(f.students[0], 100);
    const preview = await get(f.operator, `${central(f.admin)}/preview?month=${month}`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toMatchObject({ totalCents: 144_000, consumptionMonth: month, licenseMonth: next, provisional: false,
      licenses: { totalCents: 135_000 }, usage: { consumedCredits: 100, refundedCredits: 0, netCredits: 100 } });
    const results = await Promise.all([post(f.operator, `${central(f.admin)}/close`, { month }), post(f.operator, `${central(f.admin)}/close`, { month })]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 201]);
    expect(new Set(results.map(result => result.json().invoice.id)).size).toBe(1);
    expect((await db.query('SELECT id FROM billing_invoices WHERE org_id=$1', [f.admin.orgId])).rowCount).toBe(1);
    expect((await db.query('SELECT consumption_entry_id FROM billing_usage_allocations WHERE org_id=$1', [f.admin.orgId])).rowCount).toBe(1);
    const listing = await get(f.admin, '/api/billing/invoices');
    expect(listing.statusCode).toBe(200); expect(listing.json().items[0].totalCents).toBe(144_000);
  });

  it('corte de São Paulo usa estado histórico, exclui entradas no corte e não infere o atual', async () => {
    const f = await fixture(1, 1), lateSchool = randomUUID(), lateStudent = await actor('student', f.admin.orgId);
    await db.query("INSERT INTO schools(id,org_id,name,status) VALUES($1,$2,'Ingresso posterior','active')", [lateSchool, f.admin.orgId]);
    await db.query("INSERT INTO billing_school_history(org_id,school_id,observed_at,active) VALUES($1,$2,'2026-05-01T03:00:00Z',true),($1,$3,'2026-05-01T03:00:00Z',false)", [f.admin.orgId, lateSchool, f.schools[0]]);
    await db.query("INSERT INTO billing_student_history(org_id,user_id,observed_at,active,student,accepted) VALUES($1,$2,'2026-05-01T03:00:00Z',true,true,true),($1,$3,'2026-05-01T03:00:00Z',false,true,true)", [f.admin.orgId, lateStudent.userId, f.students[0].userId]);
    await db.query("UPDATE schools SET status='archived' WHERE id=$1", [f.schools[0]]);
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [f.students[0].userId]);
    const view = (await get(f.operator, `${central(f.admin)}/preview?month=${month}`)).json().preview;
    expect(view.cutoff).toBe('2026-05-01T03:00:00.000Z');
    expect(view.snapshot.schoolIds).toEqual(f.schools);
    expect(view.snapshot.studentIds).toEqual(f.students.map(student => student.userId));
  });

  it('baseline desconhecida recusa passado; mês aberto permite prévia mas não fechamento', async () => {
    const operator = await actor('operator', randomUUID(), 'backoffice'), admin = await actor();
    expect((await post(operator, `${central(admin)}/close`, { month })).statusCode).toBe(409);
    const f = await fixture(); financialNow = new Date('2026-04-15T12:00:00Z');
    expect((await get(f.operator, `${central(f.admin)}/preview?month=${month}`)).json().preview.provisional).toBe(true);
    expect((await post(f.operator, `${central(f.admin)}/close`, { month })).statusCode).toBe(409);
  });

  it('registra aceite por login e mudanças de elegibilidade sem depender de turmas', async () => {
    const admin = await actor(), student = await actor('student', admin.orgId);
    let history = (await db.query('SELECT * FROM billing_student_history WHERE user_id=$1 ORDER BY event_id', [student.userId])).rows;
    expect(history.at(-1)).toMatchObject({ active: true, student: true, accepted: false });
    await db.query("INSERT INTO audit_events(org_id,actor_user_id,event_type) VALUES($1,$2,'session_started')", [student.orgId, student.userId]);
    history = (await db.query('SELECT * FROM billing_student_history WHERE user_id=$1 ORDER BY event_id', [student.userId])).rows;
    expect(history.at(-1)?.accepted).toBe(true);
    const count = history.length;
    await db.query("UPDATE users SET name='Nome revisado' WHERE id=$1", [student.userId]);
    expect((await db.query('SELECT event_id FROM billing_student_history WHERE user_id=$1', [student.userId])).rowCount).toBe(count);
    await db.query("UPDATE users SET roles=ARRAY['teacher','student'],status='suspended' WHERE id=$1", [student.userId]);
    expect((await db.query('SELECT * FROM billing_student_history WHERE user_id=$1 ORDER BY event_id DESC LIMIT 1', [student.userId])).rows[0]).toMatchObject({ active: false, student: true, accepted: true });
    await expect(db.query('DELETE FROM billing_student_history WHERE user_id=$1', [student.userId])).rejects.toThrow('append-only');
  });

  it('aluno ativo sem aceite ou professor sem papel aluno não compõe licenças', async () => {
    const f = await fixture(), first = await actor('student', f.admin.orgId), teacher = await actor('teacher', f.admin.orgId), mixed = await actor('student', f.admin.orgId);
    for (const [who, student, accepted] of [[first, true, false], [teacher, false, true], [mixed, true, true]] as const) await db.query("INSERT INTO billing_student_history(org_id,user_id,observed_at,active,student,accepted) VALUES($1,$2,'2026-04-20T12:00:00Z',true,$3,$4)", [f.admin.orgId, who.userId, student, accepted]);
    const view = (await get(f.operator, `${central(f.admin)}/preview?month=${month}`)).json().preview;
    expect(view.snapshot.studentIds).toEqual([mixed.userId]); expect(view.licenses.students).toBe(1);
  });

  it('subtrai estorno da mesma competência e ignora concessão/reserva', async () => {
    const f = await fixture(0, 1), student = f.students[0];
    const first = await consume(student, 20), second = await consume(student, 80);
    await refund(student, first, '2026-04-30T23:00:00Z');
    await db.query('UPDATE wallets SET reserved=5 WHERE org_id=$1 AND user_id=$2', [student.orgId, student.userId]);
    const preview = (await get(f.operator, `${central(f.admin)}/preview?month=${month}`)).json().preview;
    expect(preview.usage).toMatchObject({ consumedCredits: 100, refundedCredits: 20, netCredits: 80, pricing: { totalCents: 7200 } });
    expect(preview.usageAllocations.find((item: { consumptionEntryId: string }) => item.consumptionEntryId === first.entryId).amountCents).toBe(0);
    expect(preview.usageAllocations.find((item: { consumptionEntryId: string }) => item.consumptionEntryId === second.entryId).amountCents).toBe(7200);
  });

  it('vigência do próximo mês não reprecifica consumo já realizado', async () => {
    const f = await fixture(0, 1); await consume(f.students[0], 100);
    expect((await post(f.operator, `${central(f.admin)}/contracts`, { effectiveFrom: next, expectedRevision: 0, licenses: { ...prices, organizationCents: 120_000 }, credits: { ...table, tiers: [{ from: 1, to: null, unitPriceCents: 200 }] } })).statusCode).toBe(201);
    const preview = (await get(f.operator, `${central(f.admin)}/preview?month=${month}`)).json().preview;
    expect(preview.usage.pricing.totalCents).toBe(9000); expect(preview.licenses.organizationTotalCents).toBe(120_000);
    expect(preview.contracts.consumption.effectiveFrom).toBe(month); expect(preview.contracts.licenses.effectiveFrom).toBe(next);
  });

  it('estorno tardio usa valor originalmente alocado e aparece uma única vez na próxima fatura', async () => {
    const f = await fixture(0, 1), student = f.students[0], consumed = await consume(student, 100);
    const first = await post(f.operator, `${central(f.admin)}/close`, { month }); expect(first.statusCode).toBe(201);
    const original = first.json().invoice;
    const refundId = await refund(student, consumed, '2026-05-04T12:00:00Z'); financialNow = new Date('2026-06-02T12:00:00Z');
    const preview = (await get(f.operator, `${central(f.admin)}/preview?month=${next}`)).json().preview;
    expect(preview.adjustmentsCents).toBe(-9000); expect(preview.adjustments[0]).toMatchObject({ sourceInvoiceId: original.id, refundEntryId: refundId, amountCents: -9000 });
    const second = await post(f.operator, `${central(f.admin)}/close`, { month: next }); expect(second.statusCode).toBe(201);
    expect(second.json().invoice.totalCents).toBe(91_100);
    expect((await post(f.operator, `${central(f.admin)}/close`, { month: next })).json().invoice.id).toBe(second.json().invoice.id);
    expect((await db.query('SELECT id FROM billing_adjustments WHERE refund_entry_id=$1', [refundId])).rowCount).toBe(1);
    expect((await get(f.operator, `${central(f.admin)}/invoices/${original.id}`)).json().invoice.snapshot).toEqual(original.snapshot);
  });

  it('alocação progressiva preserva parcelas originais para estorno por avaliação', () => {
    const progressive = { mode: 'progressive' as const, tiers: [{ from: 1, to: 9, unitPriceCents: 100 }, { from: 10, to: 99, unitPriceCents: 90 }, { from: 100, to: null, unitPriceCents: 80 }] };
    expect(allocateBilledUsage([{ id: 'first', amount: 10, refunded: false }, { id: 'second', amount: 90, refunded: false }], progressive)).toEqual([
      { consumptionEntryId: 'first', credits: 10, amountCents: 990 }, { consumptionEntryId: 'second', credits: 90, amountCents: 8090 },
    ]);
    expect(allocateBilledUsage([{ id: 'first', amount: 10, refunded: false }, { id: 'second', amount: 90, refunded: false }], { ...progressive, mode: 'volume' })).toEqual([
      { consumptionEntryId: 'first', credits: 10, amountCents: 800 }, { consumptionEntryId: 'second', credits: 90, amountCents: 7200 },
    ]);
  });

  it('prévia contratual soma centavos com segurança e rejeita overflow combinado', async () => {
    const f = await fixture();
    const path = `${central(f.admin)}/contracts/preview`;
    const input = { licenses: prices, credits: table, quantity: 100, schools: 3, students: 50 };
    const valid = await post(f.operator, path, input);
    expect(valid.statusCode).toBe(200); expect(valid.json().totalCents).toBe(144_000);
    const overflow = await post(f.operator, path, { ...input, licenses: { organizationCents: Number.MAX_SAFE_INTEGER, schoolCents: 0, studentCents: 0 }, quantity: 1 });
    expect(overflow.statusCode).toBe(400);
  });

  it('ajuste manual preserva original, aplica uma vez e permite saldo a favor explícito', async () => {
    const f = await fixture(), first = (await post(f.operator, `${central(f.admin)}/close`, { month })).json().invoice;
    const request = { clientKey: randomUUID(), amountCents: -150_000, reason: 'Correção contratual de demonstração.' };
    const path = `${central(f.admin)}/invoices/${first.id}/adjustments`;
    const adjustment = await post(f.operator, path, request); expect(adjustment.statusCode).toBe(201);
    expect((await post(f.operator, path, request)).json().adjustment.id).toBe(adjustment.json().adjustment.id);
    expect((await post(f.operator, path, { ...request, amountCents: -100_000 })).statusCode).toBe(409);
    // The adjustment exists now; the financial clock cannot backdate it into a historical month.
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    const adjustmentMonth = `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
    financialNow = new Date(`${nextMonth(adjustmentMonth)}-02T12:00:00Z`);
    const nextInvoice = await post(f.operator, `${central(f.admin)}/close`, { month: adjustmentMonth });
    expect(nextInvoice.statusCode, nextInvoice.body).toBe(201);
    expect(nextInvoice.json().invoice.totalCents).toBe(-50_000);
    expect((await get(f.operator, `${central(f.admin)}/invoices/${first.id}`)).json().invoice.totalCents).toBe(100_000);
  });

  it('liquidação simulada é única e rejeita reutilizar evento em outra fatura', async () => {
    const f = await fixture(), first = (await post(f.operator, `${central(f.admin)}/close`, { month })).json().invoice;
    financialNow = new Date('2026-06-02T12:00:00Z');
    const second = (await post(f.operator, `${central(f.admin)}/close`, { month: next })).json().invoice;
    const input = { eventId: randomUUID() }, path = `${central(f.admin)}/invoices/${first.id}/settle`;
    const results = await Promise.all([post(f.operator, path, input), post(f.operator, path, input)]);
    expect(results.every(result => result.statusCode === 200)).toBe(true);
    expect(results.every(result => result.json().invoice.state === 'settled')).toBe(true);
    expect((await post(f.operator, `${central(f.admin)}/invoices/${second.id}/settle`, input)).statusCode).toBe(409);
    expect((await db.query('SELECT id FROM billing_settlements WHERE invoice_id=$1', [first.id])).rowCount).toBe(1);
  });

  it('configuração central, leitura do administrador e IDs respeitam organização e papel', async () => {
    const f = await fixture(), foreign = await actor(), school = await actor('school', f.admin.orgId), student = await actor('student', f.admin.orgId);
    const closed = (await post(f.operator, `${central(f.admin)}/close`, { month })).json().invoice;
    expect((await post(f.admin, `${central(f.admin)}/close`, { month })).statusCode).toBe(403);
    expect((await get(foreign, `/api/billing/invoices/${closed.id}`)).statusCode).toBe(404);
    for (const who of [school, student]) expect((await get(who, '/api/billing/invoices')).statusCode).toBe(403);
    expect((await get(f.admin, `/api/billing/invoices/${closed.id}`)).statusCode).toBe(200);
  });

  it('contratos são versionados, CAS protege publicação e fatura fechada não é reprecificada', async () => {
    const f = await fixture();
    const nextVersion = { effectiveFrom: month, expectedRevision: 1, licenses: { ...prices, organizationCents: 110_000 }, credits: table };
    const responses = await Promise.all([post(f.operator, `${central(f.admin)}/contracts`, nextVersion), post(f.operator, `${central(f.admin)}/contracts`, nextVersion)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const closed = await post(f.operator, `${central(f.admin)}/close`, { month }); expect(closed.json().invoice.totalCents).toBe(110_000);
    expect((await post(f.operator, `${central(f.admin)}/contracts`, { ...nextVersion, expectedRevision: 2 })).statusCode).toBe(409);
    await expect(db.query("UPDATE billing_invoices SET total_cents=1 WHERE id=$1", [closed.json().invoice.id])).rejects.toThrow('immutable');
    await expect(db.query("DELETE FROM billing_contract_versions WHERE org_id=$1", [f.admin.orgId])).rejects.toThrow('append-only');
  });

  it('função de agendamento compartilha fechamento idempotente e valida operador ativo', async () => {
    const f = await fixture();
    const result = await closeBillingPeriod(db, { orgId: f.admin.orgId, actorId: f.operator.userId, month, now: financialNow });
    expect(result.replay).toBe(false);
    const api = await post(f.operator, `${central(f.admin)}/close`, { month });
    expect(api.json().invoice.id).toBe(result.invoice.id); expect(api.json().replay).toBe(true);
    await expect(closeBillingPeriod(db, { orgId: f.admin.orgId, actorId: f.admin.userId, month, now: financialNow })).rejects.toMatchObject({ statusCode: 403 });
  });
});
