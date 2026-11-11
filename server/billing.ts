import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import type { Database } from './db.js';
import { buildInvoicePreview, nextMonth, validateMonth, type ContractVersion, type LicenseSnapshot } from './billing-preview.js';
import { multiplyCents, priceCredits, priceMonthlyLicenses, sumCents, type PriceTable } from './pricing.js';
import { priceTableSchema, pricingValue } from './commerce.js';
import { CommerceError, commerceAccess, commerceAudit, commerceMutation, commerceOrg, commerceParam, pagination, parseCommerce } from './commerce-access.js';

const licensesSchema = z.object({ organizationCents: z.number().int().nonnegative(), schoolCents: z.number().int().nonnegative(), studentCents: z.number().int().nonnegative() }).strict();
const monthSchema = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/);
const contractInput = z.object({ effectiveFrom: monthSchema, expectedRevision: z.number().int().min(0), licenses: licensesSchema, credits: priceTableSchema, extraTerms: z.string().trim().max(2000).default('') }).strict();
const pricePreviewInput = z.object({ licenses: licensesSchema, credits: priceTableSchema, quantity: z.number().int().nonnegative(), schools: z.number().int().nonnegative(), students: z.number().int().nonnegative() }).strict();
const monthInput = z.object({ month: monthSchema }).strict();
const adjustmentInput = z.object({ clientKey: z.uuid(), amountCents: z.number().int().refine(value => value !== 0), reason: z.string().trim().min(1).max(1000) }).strict();
const settlementInput = z.object({ eventId: z.uuid() }).strict();
interface ContractRow extends QueryResultRow { id: string; effective_from: string; revision: number; document: { licenses: z.infer<typeof licensesSchema>; credits: PriceTable; extraTerms: string; extrasMode: string }; created_at: Date }
interface InvoiceRow extends QueryResultRow { id: string; org_id: string; consumption_month: string; snapshot: unknown; total_cents: string; state: 'open' | 'settled'; closed_at: Date; settled_at: Date | null }
interface AdjustmentView { id?: string; sourceInvoiceId: string; refundEntryId?: string; amountCents: number; reason: string }
interface ConsumptionRow { id: string; amount: number; refunded: boolean }
interface UsageAllocation { consumptionEntryId: string; credits: number; amountCents: number }
type FinancialOptions = { orgId: string; month: string; now?: Date };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invoiceView = (row: InvoiceRow) => ({ id: row.id, orgId: row.org_id, consumptionMonth: row.consumption_month.slice(0, 7), totalCents: Number(row.total_cents), state: row.state,
  snapshot: row.snapshot, closedAt: row.closed_at, settledAt: row.settled_at, simulated: true as const });
const signedSum = (numbers: readonly number[]) => {
  let total = 0n;
  for (const number of numbers) { if (!Number.isSafeInteger(number)) throw new CommerceError(409, 'Valor financeiro fora do limite seguro.'); total += BigInt(number); }
  if (total < -BigInt(Number.MAX_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new CommerceError(409, 'Total financeiro fora do limite seguro.');
  return Number(total);
};
async function financialPeriod(client: PoolClient, month: string, now = new Date()) {
  pricingValue(() => validateMonth(month)); const following = pricingValue(() => nextMonth(month));
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new CommerceError(400, 'Relógio financeiro inválido.');
  const period = (await client.query<{ start: Date; end: Date; realNow: Date }>(`SELECT ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS start,
    ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS end,clock_timestamp() AS "realNow"`, [`${month}-01`, `${following}-01`])).rows[0];
  if (now <= period.start) throw new CommerceError(409, 'A competência financeira ainda não começou.');
  return { ...period, now, asOf: now < period.end ? now : period.end, provisional: now < period.end };
}
async function contracts(client: PoolClient, orgId: string) {
  const rows = (await client.query<ContractRow>(`SELECT DISTINCT ON (effective_from) id,effective_from::text,revision,document,created_at
    FROM billing_contract_versions WHERE org_id=$1 ORDER BY effective_from,revision DESC`, [orgId])).rows;
  const versions: ContractVersion[] = rows.map(row => ({ id: row.id, orgId, effectiveFrom: row.effective_from.slice(0, 7), licenses: row.document.licenses, credits: row.document.credits }));
  return { rows, versions };
}
async function eligibleSnapshot(client: PoolClient, orgId: string, month: string, asOf: Date): Promise<LicenseSnapshot> {
  const coverage = (await client.query<{ tracked_since: Date }>('SELECT tracked_since FROM billing_observation_coverage WHERE org_id=$1', [orgId])).rows[0];
  if (!coverage || coverage.tracked_since >= asOf) throw new CommerceError(409, 'Não há histórico de elegibilidade conhecido para este corte. Não é possível inferir o estado passado.');
  const schools = await client.query<{ school_id: string; active: boolean }>(`SELECT DISTINCT ON (school_id) school_id,active FROM billing_school_history
    WHERE org_id=$1 AND observed_at<$2 ORDER BY school_id,observed_at DESC,event_id DESC`, [orgId, asOf]);
  const students = await client.query<{ user_id: string; active: boolean; student: boolean; accepted: boolean }>(`SELECT DISTINCT ON (user_id) user_id,active,student,accepted FROM billing_student_history
    WHERE org_id=$1 AND observed_at<$2 ORDER BY user_id,observed_at DESC,event_id DESC`, [orgId, asOf]);
  return { orgId, closingMonth: month, licenseMonth: nextMonth(month), timezone: 'America/Sao_Paulo',
    schoolIds: schools.rows.filter(row => row.active).map(row => row.school_id).sort(),
    studentIds: students.rows.filter(row => row.active && row.student && row.accepted).map(row => row.user_id).sort() };
}
export function allocateBilledUsage(consumptions: readonly ConsumptionRow[], table: PriceTable): UsageAllocation[] {
  const net = sumCents(consumptions.filter(item => !item.refunded).map(item => item.amount));
  const quote = priceCredits(net, table); let offset = 0;
  const allocations = consumptions.map(item => {
    if (!Number.isSafeInteger(item.amount) || item.amount < 1) throw new CommerceError(409, 'Consumo financeiro inválido.');
    if (item.refunded) return { consumptionEntryId: item.id, credits: item.amount, amountCents: 0 };
    let amountCents: number;
    if (table.mode === 'volume') amountCents = multiplyCents(item.amount, quote.lines[0].unitPriceCents);
    else {
      const end = offset + item.amount;
      amountCents = sumCents(table.tiers.map(tier => {
        const overlap = Math.max(0, Math.min(end, tier.to ?? end) - Math.max(offset + 1, tier.from) + 1);
        return multiplyCents(overlap, tier.unitPriceCents);
      }));
    }
    offset += item.amount;
    return { consumptionEntryId: item.id, credits: item.amount, amountCents };
  });
  if (sumCents(allocations.map(item => item.amountCents)) !== quote.totalCents) throw new CommerceError(409, 'A apuração precisa ser conciliada.');
  return allocations;
}

/** Trusted financial clock only. This reads persisted events; it does not invent past or future eligibility. */
export async function previewBillingInTransaction(client: PoolClient, input: FinancialOptions) {
  await commerceOrg(client, input.orgId, 'partner');
  const period = await financialPeriod(client, input.month, input.now);
  const snapshot = await eligibleSnapshot(client, input.orgId, input.month, period.asOf);
  const contractData = await contracts(client, input.orgId);
  const consumption = (await client.query<ConsumptionRow>(`SELECT e.id,(-e.delta)::integer AS amount,
    EXISTS(SELECT 1 FROM wallet_entries refund WHERE refund.org_id=e.org_id AND refund.user_id=e.user_id AND refund.reverses_entry_id=e.id
      AND refund.kind='refund' AND refund.created_at<$4) AS refunded
    FROM wallet_entries e WHERE e.org_id=$1 AND e.kind='consumption' AND e.source='evaluation' AND e.created_at>=$2 AND e.created_at<$3
    ORDER BY e.created_at,e.id`, [input.orgId, period.start, period.asOf, period.asOf])).rows;
  const consumedCredits = pricingValue(() => sumCents(consumption.map(item => item.amount)));
  const refundedCredits = pricingValue(() => sumCents(consumption.filter(item => item.refunded).map(item => item.amount)));
  const base = pricingValue(() => buildInvoicePreview({ orgId: input.orgId, consumptionMonth: input.month, snapshot,
    usage: { consumedCredits, refundedCredits }, contracts: contractData.versions }));
  const usageAllocations = pricingValue(() => allocateBilledUsage(consumption, base.contracts.consumption.credits));
  const manual = (await client.query<{ id: string; source_invoice_id: string; amount_cents: string; reason: string }>(`SELECT a.id,a.source_invoice_id,a.amount_cents,a.reason
    FROM billing_adjustments a JOIN billing_invoices source ON source.id=a.source_invoice_id AND source.org_id=a.org_id
    WHERE a.org_id=$1 AND a.applied_invoice_id IS NULL AND a.created_at<$2 AND source.consumption_month<$3::date ORDER BY a.created_at,a.id`, [input.orgId, period.asOf, `${input.month}-01`])).rows;
  const refunds = (await client.query<{ refund_id: string; invoice_id: string; amount_cents: string }>(`SELECT refund.id AS refund_id,allocation.invoice_id,allocation.amount_cents
    FROM wallet_entries refund JOIN billing_usage_allocations allocation ON allocation.consumption_entry_id=refund.reverses_entry_id AND allocation.org_id=refund.org_id
    JOIN billing_invoices source ON source.id=allocation.invoice_id AND source.org_id=allocation.org_id
    WHERE refund.org_id=$1 AND refund.kind='refund' AND refund.created_at<$2 AND source.consumption_month<$3::date AND allocation.amount_cents>0
      AND NOT EXISTS(SELECT 1 FROM billing_adjustments handled WHERE handled.refund_entry_id=refund.id)
    ORDER BY refund.created_at,refund.id`, [input.orgId, period.asOf, `${input.month}-01`])).rows;
  const adjustments: AdjustmentView[] = [
    ...manual.map(row => ({ id: row.id, sourceInvoiceId: row.source_invoice_id, amountCents: Number(row.amount_cents), reason: row.reason })),
    ...refunds.map(row => ({ sourceInvoiceId: row.invoice_id, refundEntryId: row.refund_id, amountCents: -Number(row.amount_cents), reason: 'Estorno de consumo de competência já faturada.' })),
  ];
  const adjustmentsCents = signedSum(adjustments.map(item => item.amountCents));
  return { ...base, totalBeforeAdjustmentsCents: base.totalCents, adjustmentsCents, totalCents: signedSum([base.totalCents, adjustmentsCents]), adjustments,
    usageAllocations, contractDocuments: { consumption: contractData.rows.find(row => row.id === base.contracts.consumption.id), licenses: contractData.rows.find(row => row.id === base.contracts.licenses.id) },
    cutoff: period.end.toISOString(), observedUntil: period.asOf.toISOString(), financialNow: period.now.toISOString(),
    clockAdvancedBeyondRealTime: period.now.getTime() > period.realNow.getTime() + 1000,
    provisional: period.provisional, simulated: true as const };
}
async function invoice(client: PoolClient, orgId: string, id: string) {
  const row = (await client.query<InvoiceRow>('SELECT *,consumption_month::text FROM billing_invoices WHERE org_id=$1 AND id=$2', [orgId, id])).rows[0];
  if (!row) throw new CommerceError(404, 'Fatura não encontrada.'); return row;
}
async function closeInTransaction(client: PoolClient, input: FinancialOptions & { actorId: string }) {
  pricingValue(() => validateMonth(input.month));
  const previous = (await client.query<InvoiceRow>('SELECT *,consumption_month::text FROM billing_invoices WHERE org_id=$1 AND consumption_month=$2::date', [input.orgId, `${input.month}-01`])).rows[0];
  if (previous) return { invoice: invoiceView(previous), replay: true };
  const period = await financialPeriod(client, input.month, input.now);
  if (period.provisional) throw new CommerceError(409, 'A competência ainda está aberta. Consulte a prévia ou avance explicitamente o relógio financeiro simulado.');
  // Old transactions could still commit ledger rows dated before the month-end cut.
  if (period.end <= period.realNow && (await client.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
    AND pid<>pg_backend_pid() AND xact_start<$1 AND state<>'idle' LIMIT 1`, [period.end])).rowCount) throw new CommerceError(409, 'Há transação anterior ao corte ainda em andamento. Aguarde antes do fechamento.');
  const preview = await previewBillingInTransaction(client, input);
  const row = (await client.query<InvoiceRow>(`INSERT INTO billing_invoices(org_id,consumption_month,snapshot,total_cents,closed_by)
    VALUES($1,$2,$3,$4,$5) RETURNING *,consumption_month::text`, [input.orgId, `${input.month}-01`, preview, preview.totalCents, input.actorId])).rows[0];
  for (const allocation of preview.usageAllocations) await client.query('INSERT INTO billing_usage_allocations(org_id,invoice_id,consumption_entry_id,credits,amount_cents) VALUES($1,$2,$3,$4,$5)', [input.orgId, row.id, allocation.consumptionEntryId, allocation.credits, allocation.amountCents]);
  for (const adjustment of preview.adjustments) {
    if (adjustment.id) await client.query('UPDATE billing_adjustments SET applied_invoice_id=$3 WHERE org_id=$1 AND id=$2 AND applied_invoice_id IS NULL', [input.orgId, adjustment.id, row.id]);
    else await client.query('INSERT INTO billing_adjustments(org_id,source_invoice_id,refund_entry_id,amount_cents,reason,applied_invoice_id) VALUES($1,$2,$3,$4,$5,$6)', [input.orgId, adjustment.sourceInvoiceId, adjustment.refundEntryId, adjustment.amountCents, adjustment.reason, row.id]);
  }
  const actorOrg = (await client.query<{ org_id: string }>('SELECT org_id FROM users WHERE id=$1', [input.actorId])).rows[0];
  await client.query('INSERT INTO audit_events(org_id,actor_user_id,event_type,metadata) VALUES($1,$2,$3,$4)', [actorOrg.org_id, input.actorId, 'billing_period_closed', { targetOrgId: input.orgId, invoiceId: row.id, month: input.month }]);
  return { invoice: invoiceView(row), replay: false };
}

/** Shared manual/scheduled close. Scheduler must supply a live backoffice operator and a trusted financial clock. */
export async function closeBillingPeriod(db: Database, input: FinancialOptions & { actorId: string }) {
  return db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [input.orgId]);
    const authorized = await client.query(`SELECT u.id FROM users u JOIN orgs o ON o.id=u.org_id WHERE u.id=$1 AND u.status='active' AND u.archived_at IS NULL
      AND u.roles=ARRAY['operator']::text[] AND o.kind='backoffice' AND o.status='active' FOR SHARE OF u,o`, [input.actorId]);
    if (!authorized.rowCount) throw new CommerceError(403, 'Fechamento exige operador ativo do backoffice.');
    await commerceOrg(client, input.orgId, 'partner', true);
    return closeInTransaction(client, input);
  });
}

export async function registerBilling(app: FastifyInstance, options: { now?: (orgId: string) => Promise<Date> | Date } = {}) {
  const central = '/api/backoffice/billing/orgs/:orgId';
  app.post(`${central}/contracts/preview`, async request => {
    await commerceAccess(request, true, 'partner'); const input = parseCommerce(pricePreviewInput, request.body);
    return pricingValue(() => {
      const consumption = priceCredits(input.quantity, input.credits), licenses = priceMonthlyLicenses(input.licenses, { schools: input.schools, students: input.students });
      return { consumption, licenses, totalCents: sumCents([consumption.totalCents, licenses.totalCents]) };
    });
  });
  app.post(`${central}/contracts`, async (request, reply) => {
    const access = await commerceAccess(request, true, 'partner'), input = parseCommerce(contractInput, request.body);
    pricingValue(() => { priceCredits(0, input.credits); priceMonthlyLicenses(input.licenses, { schools: 0, students: 0 }); });
    const contract = await commerceMutation(request, access, async (client, current) => {
      const previous = (await client.query<{ revision: number }>('SELECT COALESCE(max(revision),0)::integer AS revision FROM billing_contract_versions WHERE org_id=$1 AND effective_from=$2::date', [current.org.id, `${input.effectiveFrom}-01`])).rows[0].revision;
      if (input.expectedRevision !== previous) throw new CommerceError(409, 'A versão contratual mudou. Recarregue antes de publicar.');
      if ((await client.query("SELECT id FROM billing_invoices WHERE org_id=$1 AND consumption_month>=($2::date-interval '1 month') LIMIT 1", [current.org.id, `${input.effectiveFrom}-01`])).rowCount) throw new CommerceError(409, 'A vigência já alcança período faturado. Registre ajuste rastreável ou escolha uma competência futura.');
      const document = { licenses: input.licenses, credits: input.credits, extraTerms: input.extraTerms, extrasMode: 'postpaid_consumption' };
      const row = (await client.query<ContractRow>(`INSERT INTO billing_contract_versions(org_id,effective_from,revision,document,created_by)
        VALUES($1,$2,$3,$4,$5) RETURNING id,effective_from::text,revision,document,created_at`, [current.org.id, `${input.effectiveFrom}-01`, previous + 1, document, current.actor.user.id])).rows[0];
      await commerceAudit(client, current, 'billing_contract_published', { contractId: row.id, effectiveFrom: input.effectiveFrom }); return row;
    }); return reply.code(201).send({ contract: { id: contract.id, effectiveFrom: contract.effective_from.slice(0, 7), revision: contract.revision, ...contract.document, createdAt: contract.created_at } });
  });
  app.post(`${central}/close`, async (request, reply) => {
    const access = await commerceAccess(request, true, 'partner'), input = parseCommerce(monthInput, request.body), now = await options.now?.(access.org.id) ?? new Date();
    const result = await commerceMutation(request, access, (client, current) => closeInTransaction(client, { orgId: current.org.id, actorId: current.actor.user.id, month: input.month, now }));
    return reply.code(result.replay ? 200 : 201).send(result);
  });
  app.post(`${central}/invoices/:id/adjustments`, async (request, reply) => {
    const access = await commerceAccess(request, true, 'partner'), id = commerceParam(request, 'id'), input = parseCommerce(adjustmentInput, request.body);
    const adjustment = await commerceMutation(request, access, async (client, current) => {
      await invoice(client, current.org.id, id); const signature = hash([id, input]);
      const old = (await client.query('SELECT id,amount_cents::text,reason,applied_invoice_id,fingerprint FROM billing_adjustments WHERE org_id=$1 AND client_key=$2', [current.org.id, input.clientKey])).rows[0];
      if (old) { if (old.fingerprint !== signature) throw new CommerceError(409, 'Chave de ajuste reutilizada com dados diferentes.'); return old; }
      const row = (await client.query(`INSERT INTO billing_adjustments(org_id,source_invoice_id,client_key,fingerprint,amount_cents,reason,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,amount_cents::text,reason,applied_invoice_id`, [current.org.id, id, input.clientKey, signature, input.amountCents, input.reason, current.actor.user.id])).rows[0];
      await commerceAudit(client, current, 'billing_adjustment_created', { adjustmentId: row.id, sourceInvoiceId: id }); return row;
    }); return reply.code(201).send({ adjustment: { id: adjustment.id, amountCents: Number(adjustment.amount_cents), reason: adjustment.reason, appliedInvoiceId: adjustment.applied_invoice_id } });
  });
  app.post(`${central}/invoices/:id/settle`, async request => {
    const access = await commerceAccess(request, true, 'partner'), id = commerceParam(request, 'id'), input = parseCommerce(settlementInput, request.body);
    return commerceMutation(request, access, async (client, current) => {
      const target = await invoice(client, current.org.id, id);
      const reused = (await client.query<{ invoice_id: string }>('SELECT invoice_id FROM billing_settlements WHERE org_id=$1 AND event_id=$2', [current.org.id, input.eventId])).rows[0];
      if (reused && reused.invoice_id !== id) throw new CommerceError(409, 'Evento de liquidação já utilizado em outra fatura.');
      if (target.state === 'settled') return { invoice: invoiceView(target), replay: true, simulated: true };
      await client.query('INSERT INTO billing_settlements(org_id,invoice_id,event_id,amount_cents,actor_id) VALUES($1,$2,$3,$4,$5)', [current.org.id, id, input.eventId, target.total_cents, current.actor.user.id]);
      const settled = (await client.query<InvoiceRow>("UPDATE billing_invoices SET state='settled',settled_at=clock_timestamp() WHERE org_id=$1 AND id=$2 RETURNING *,consumption_month::text", [current.org.id, id])).rows[0];
      await commerceAudit(client, current, 'billing_settled_simulated', { invoiceId: id }); return { invoice: invoiceView(settled), replay: false, simulated: true };
    });
  });
  for (const isCentral of [false, true]) {
    const prefix = isCentral ? central : '/api/billing';
    app.get(`${prefix}/contracts`, async request => {
      const access = await commerceAccess(request, isCentral, 'partner');
      const rows = await app.db.query<ContractRow>('SELECT id,effective_from::text,revision,document,created_at FROM billing_contract_versions WHERE org_id=$1 ORDER BY effective_from DESC,revision DESC', [access.org.id]);
      const coverage = (await app.db.query('SELECT tracked_since AS "trackedSince" FROM billing_observation_coverage WHERE org_id=$1', [access.org.id])).rows[0];
      return { items: rows.rows.map(row => ({ id: row.id, effectiveFrom: row.effective_from.slice(0, 7), revision: row.revision, ...row.document, createdAt: row.created_at })), coverage };
    });
    app.get(`${prefix}/preview`, async request => {
      const access = await commerceAccess(request, isCentral, 'partner'), input = parseCommerce(monthInput, request.query), now = await options.now?.(access.org.id) ?? new Date();
      return commerceMutation(request, access, async (client, current) => {
        const existing = (await client.query<InvoiceRow>('SELECT *,consumption_month::text FROM billing_invoices WHERE org_id=$1 AND consumption_month=$2::date', [current.org.id, `${input.month}-01`])).rows[0];
        return existing ? { preview: existing.snapshot, closedInvoiceId: existing.id } : { preview: await previewBillingInTransaction(client, { orgId: current.org.id, month: input.month, now }), closedInvoiceId: null };
      });
    });
    app.get(`${prefix}/invoices`, async request => {
      const access = await commerceAccess(request, isCentral, 'partner'), page = parseCommerce(pagination, request.query);
      const total = (await app.db.query<{ total: number }>('SELECT count(*)::integer AS total FROM billing_invoices WHERE org_id=$1', [access.org.id])).rows[0].total;
      const rows = await app.db.query<InvoiceRow>('SELECT i.*,i.consumption_month::text FROM billing_invoices i WHERE i.org_id=$1 ORDER BY i.consumption_month DESC LIMIT $2 OFFSET $3', [access.org.id, page.pageSize, (page.page - 1) * page.pageSize]);
      return { items: rows.rows.map(invoiceView), total, ...page };
    });
    app.get(`${prefix}/invoices/:id`, async request => {
      const access = await commerceAccess(request, isCentral, 'partner'), id = commerceParam(request, 'id');
      return app.db.transaction(async client => {
        const row = await invoice(client, access.org.id, id);
        const adjustments = await client.query('SELECT id,source_invoice_id AS "sourceInvoiceId",applied_invoice_id AS "appliedInvoiceId",refund_entry_id AS "refundEntryId",amount_cents::text,reason,created_at AS "createdAt" FROM billing_adjustments WHERE org_id=$1 AND (source_invoice_id=$2 OR applied_invoice_id=$2) ORDER BY created_at,id', [access.org.id, id]);
        const settlement = (await client.query('SELECT id,event_id AS "eventId",amount_cents::text,created_at AS "createdAt" FROM billing_settlements WHERE org_id=$1 AND invoice_id=$2', [access.org.id, id])).rows[0] ?? null;
        return { invoice: invoiceView(row), adjustments: adjustments.rows.map(({ amount_cents, ...rest }) => ({ ...rest, amountCents: Number(amount_cents) })), settlement: settlement ? { id: settlement.id, eventId: settlement.eventId, amountCents: Number(settlement.amount_cents), createdAt: settlement.createdAt } : null };
      });
    });
  }
}
