import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { QueryResultRow, PoolClient } from 'pg';
import { z } from 'zod';
import { commerceAccess, commerceAudit, commerceMutation, commerceParam, CommerceError, pagination, parseCommerce, type CommerceAccess } from './commerce-access.js';
import { priceCredits, PricingError, validatePriceTable, type PriceTable } from './pricing.js';
import { grantCreditsInTransaction } from './wallet.js';
import type { CourseDocument } from './course-model.js';

export const priceTableSchema = z.object({ mode: z.enum(['volume', 'progressive']), tiers: z.array(z.object({ from: z.number().int().min(1), to: z.number().int().min(1).nullable(), unitPriceCents: z.number().int().nonnegative() }).strict()).min(1).max(1000) }).strict();
const offerShape = { title: z.string().trim().min(1).max(180), kind: z.enum(['credits', 'course']), creditAmount: z.number().int().min(0).max(1_000_000).optional(),
  priceTable: priceTableSchema.optional(), courseVersionId: z.uuid().optional(), coursePriceCents: z.number().int().nonnegative().optional() };
const offerInput = z.object(offerShape).strict();
const offerUpdate = z.object({ ...offerShape, expectedRevision: z.number().int().min(1) }).strict();
const revisionInput = z.object({ expectedRevision: z.number().int().min(1) }).strict();
const orderInput = z.object({ offerId: z.uuid(), clientKey: z.uuid() }).strict();
const paymentStatuses = ['pending', 'approved', 'declined', 'cancelled'] as const;
export type SimulatedPaymentStatus = typeof paymentStatuses[number];
const paymentInput = z.object({ eventId: z.uuid(), status: z.enum(paymentStatuses).optional() }).strict();
type OfferInput = Omit<z.infer<typeof offerInput>, 'priceTable'> & { priceTable?: PriceTable };
interface OfferRow extends QueryResultRow { id: string; title: string; kind: 'credits' | 'course'; status: string; revision: number; data: { creditAmount: number; priceTable?: PriceTable; coursePriceCents?: number }; course_id: string | null; course_version_id: string | null }
interface OrderRow extends QueryResultRow { id: string; org_id: string; student_id: string; studentName?: string; offer_id: string; client_key: string; fingerprint: string; status: 'pending' | 'paid' | 'declined' | 'cancelled'; amount_cents: string; credit_amount: number; course_id: string | null; course_version_id: string | null; snapshot: unknown; created_at: Date; completed_at: Date | null }
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function pricingValue<T>(work: () => T): T { try { return work(); } catch (error) { if (error instanceof PricingError) throw new CommerceError(400, error.message); throw error; } }
const offerView = (row: OfferRow) => ({ id: row.id, title: row.title, kind: row.kind, status: row.status, revision: row.revision,
  creditAmount: row.data.creditAmount, priceTable: row.data.priceTable, coursePriceCents: row.data.coursePriceCents,
  courseId: row.course_id, courseVersionId: row.course_version_id,
  amountCents: row.kind === 'credits' ? pricingValue(() => priceCredits(row.data.creditAmount, row.data.priceTable!).totalCents) : row.data.coursePriceCents! });
const orderView = (row: OrderRow) => ({ id: row.id, studentId: row.student_id, studentName: row.studentName, offerId: row.offer_id, status: row.status, amountCents: Number(row.amount_cents),
  creditAmount: row.credit_amount, courseId: row.course_id, courseVersionId: row.course_version_id, snapshot: row.snapshot,
  createdAt: row.created_at, completedAt: row.completed_at, simulated: true as const });
async function validateOffer(client: PoolClient, access: CommerceAccess, input: OfferInput) {
  if (input.kind === 'credits') {
    if (!input.priceTable || input.creditAmount === undefined || input.creditAmount < 1 || input.courseVersionId || input.coursePriceCents !== undefined) throw new CommerceError(400, 'Pacote exige créditos e tabela de preço, sem curso.');
    const priceTable = pricingValue(() => validatePriceTable(input.priceTable!));
    const creditAmount = input.creditAmount;
    const quote = pricingValue(() => priceCredits(creditAmount, priceTable));
    return { data: { creditAmount: input.creditAmount, priceTable }, courseId: null, courseVersionId: null, amountCents: quote.totalCents, pricing: quote };
  }
  if (!input.courseVersionId || input.coursePriceCents === undefined || input.priceTable) throw new CommerceError(400, 'Curso exige versão publicada e preço em centavos.');
  const version = (await client.query<{ course_id: string; document: CourseDocument }>(`SELECT v.course_id,v.document FROM course_versions v JOIN courses c ON c.id=v.course_id AND c.org_id=v.org_id
    WHERE v.id=$1 AND v.org_id=$2 AND c.status='published'`, [input.courseVersionId, access.org.id])).rows[0];
  if (!version) throw new CommerceError(404, 'Versão publicada de curso não encontrada nesta organização.');
  const creditAmount = version.document.creditMode === 'acquisition' ? version.document.acquisitionCredits : 0;
  if (input.creditAmount !== undefined && input.creditAmount !== creditAmount) throw new CommerceError(400, 'Os créditos de aquisição são definidos pela versão publicada do curso.');
  return { data: { creditAmount, coursePriceCents: input.coursePriceCents }, courseId: version.course_id, courseVersionId: input.courseVersionId, amountCents: input.coursePriceCents, pricing: null };
}
async function findOffer(client: PoolClient, access: CommerceAccess, id: string) {
  const row = (await client.query<OfferRow>('SELECT * FROM commerce_offers WHERE org_id=$1 AND id=$2', [access.org.id, id])).rows[0];
  if (!row) throw new CommerceError(404, 'Oferta não encontrada.'); return row;
}
async function findOrder(client: PoolClient, access: CommerceAccess, id: string) {
  const row = (await client.query<OrderRow>('SELECT o.*,u.name AS "studentName" FROM commerce_orders o JOIN users u ON u.id=o.student_id AND u.org_id=o.org_id WHERE o.org_id=$1 AND o.id=$2', [access.org.id, id])).rows[0];
  if (!row || (!access.central && row.student_id !== access.actor.user.id)) throw new CommerceError(404, 'Pedido não encontrado.'); return row;
}
async function fulfill(client: PoolClient, access: CommerceAccess, order: OrderRow) {
  const target = (await client.query(`SELECT id FROM users WHERE id=$1 AND org_id=$2 AND status='active' AND archived_at IS NULL AND 'student'=ANY(roles) FOR KEY SHARE`, [order.student_id, access.org.id])).rowCount;
  if (!target || access.org.status !== 'active') throw new CommerceError(409, 'O aluno ou a organização não está disponível para esta compra.');
  let enrollmentId: string | null = null, creditEntryId: string | null = null;
  if (order.course_id) {
    if (access.org.settings.coursesEnabled === false) throw new CommerceError(409, 'O módulo de cursos está desativado.');
    if ((await client.query('SELECT id FROM course_enrollments WHERE org_id=$1 AND course_id=$2 AND student_id=$3', [access.org.id, order.course_id, order.student_id])).rowCount) throw new CommerceError(409, 'O aluno já recebeu este curso. Cancele este pedido pendente.');
    enrollmentId = (await client.query<{ id: string }>(`INSERT INTO course_enrollments(org_id,course_id,version_id,student_id,source,source_ref)
      VALUES($1,$2,$3,$4,'purchase',$5) RETURNING id`, [access.org.id, order.course_id, order.course_version_id, order.student_id, order.id])).rows[0].id;
  }
  if (order.credit_amount > 0) creditEntryId = (await grantCreditsInTransaction(client, { orgId: access.org.id, userId: order.student_id,
    amount: order.credit_amount, eventKey: `order:${order.id}`, source: 'purchase', sourceRef: `order:${order.id}`, reason: 'Compra simulada confirmada.', actorUserId: access.actor.user.id })).id;
  await client.query('INSERT INTO commerce_entitlements(order_id,org_id,student_id,credit_entry_id,course_enrollment_id) VALUES($1,$2,$3,$4,$5)', [order.id, access.org.id, order.student_id, creditEntryId, enrollmentId]);
}

export async function registerCommerce(app: FastifyInstance, options: { defaultPaymentScenario?: (orgId: string) => Promise<SimulatedPaymentStatus> | SimulatedPaymentStatus } = {}) {
  const central = '/api/backoffice/commerce/orgs/:orgId';
  app.get(`${central}/courses`, async request => {
    const access = await commerceAccess(request, true, 'matraca');
    const rows = await app.db.query<{ id: string; title: string; versionId: string; version: number; creditMode: string; acquisitionCredits: number }>(`SELECT c.id,c.title,v.id AS "versionId",v.version,
      v.document->>'creditMode' AS "creditMode",(v.document->>'acquisitionCredits')::integer AS "acquisitionCredits"
      FROM courses c JOIN course_versions v ON v.course_id=c.id AND v.org_id=c.org_id WHERE c.org_id=$1 AND c.status='published' ORDER BY c.title,v.version DESC`, [access.org.id]);
    return { items: rows.rows };
  });
  app.post(`${central}/catalog/preview`, async request => {
    const access = await commerceAccess(request, true, 'matraca'), input = parseCommerce(offerInput, request.body);
    return commerceMutation(request, access, async (client, current) => ({ quote: await validateOffer(client, current, input), simulated: true }));
  });
  app.post(`${central}/catalog`, async (request, reply) => {
    const access = await commerceAccess(request, true, 'matraca'), input = parseCommerce(offerInput, request.body);
    const offer = await commerceMutation(request, access, async (client, current) => {
      const valid = await validateOffer(client, current, input);
      const row = (await client.query<OfferRow>(`INSERT INTO commerce_offers(org_id,title,kind,data,course_id,course_version_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [current.org.id, input.title, input.kind, valid.data, valid.courseId, valid.courseVersionId, current.actor.user.id])).rows[0];
      await commerceAudit(client, current, 'commerce_offer_created', { offerId: row.id }); return offerView(row);
    }); return reply.code(201).send({ offer });
  });
  app.put(`${central}/catalog/:id`, async request => {
    const access = await commerceAccess(request, true, 'matraca'), input = parseCommerce(offerUpdate, request.body), id = commerceParam(request, 'id');
    return commerceMutation(request, access, async (client, current) => {
      const previous = await findOffer(client, current, id);
      if (previous.revision !== input.expectedRevision) throw new CommerceError(409, 'A oferta mudou. Recarregue antes de salvar.');
      const valid = await validateOffer(client, current, input);
      const row = (await client.query<OfferRow>(`UPDATE commerce_offers SET title=$3,kind=$4,data=$5,course_id=$6,course_version_id=$7,status='draft',revision=revision+1,updated_at=clock_timestamp()
        WHERE org_id=$1 AND id=$2 RETURNING *`, [current.org.id, id, input.title, input.kind, valid.data, valid.courseId, valid.courseVersionId])).rows[0];
      await commerceAudit(client, current, 'commerce_offer_updated', { offerId: id }); return { offer: offerView(row) };
    });
  });
  for (const action of ['publish', 'archive'] as const) app.post(`${central}/catalog/:id/${action}`, async request => {
    const access = await commerceAccess(request, true, 'matraca'), id = commerceParam(request, 'id'), input = parseCommerce(revisionInput, request.body);
    return commerceMutation(request, access, async (client, current) => {
      const previous = await findOffer(client, current, id);
      if (previous.revision !== input.expectedRevision) throw new CommerceError(409, 'A oferta mudou. Recarregue antes de publicar.');
      if (action === 'publish') await validateOffer(client, current, { title: previous.title, kind: previous.kind, ...previous.data, ...(previous.course_version_id ? { courseVersionId: previous.course_version_id } : {}) });
      const row = (await client.query<OfferRow>(`UPDATE commerce_offers SET status=$3,revision=revision+1,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2 RETURNING *`, [current.org.id, id, action === 'publish' ? 'published' : 'archived'])).rows[0];
      await commerceAudit(client, current, `commerce_offer_${action}`, { offerId: id }); return { offer: offerView(row) };
    });
  });

  for (const isCentral of [false, true]) {
    const prefix = isCentral ? central : '/api/commerce';
    app.get(`${prefix}/catalog`, async request => {
      const access = await commerceAccess(request, isCentral, 'matraca'), page = parseCommerce(pagination, request.query);
      const predicate = `org_id=$1 AND ($2::boolean OR (status='published' AND (kind='credits' OR $3::boolean)))`;
      const values = [access.org.id, isCentral, access.org.settings.coursesEnabled !== false];
      const total = (await app.db.query<{ total: number }>(`SELECT count(*)::integer AS total FROM commerce_offers WHERE ${predicate}`, values)).rows[0].total;
      const rows = await app.db.query<OfferRow>(`SELECT * FROM commerce_offers WHERE ${predicate} ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`, [...values, page.pageSize, (page.page - 1) * page.pageSize]);
      return { items: rows.rows.map(offerView), total, ...page, simulated: true };
    });
    app.get(`${prefix}/orders`, async request => {
      const access = await commerceAccess(request, isCentral, 'matraca'), page = parseCommerce(pagination, request.query);
      const values = [access.org.id, isCentral, access.actor.user.id];
      const predicate = 'org_id=$1 AND ($2::boolean OR student_id=$3)';
      const total = (await app.db.query<{ total: number }>(`SELECT count(*)::integer AS total FROM commerce_orders WHERE ${predicate}`, values)).rows[0].total;
      const rows = await app.db.query<OrderRow>(`SELECT o.*,(SELECT u.name FROM users u WHERE u.id=o.student_id AND u.org_id=o.org_id) AS "studentName" FROM commerce_orders o WHERE ${predicate} ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`, [...values, page.pageSize, (page.page - 1) * page.pageSize]);
      return { items: rows.rows.map(orderView), total, ...page };
    });
    app.get(`${prefix}/orders/:id`, async request => {
      const access = await commerceAccess(request, isCentral, 'matraca'), id = commerceParam(request, 'id');
      return app.db.transaction(async client => {
        const order = await findOrder(client, access, id);
        const events = await client.query('SELECT event_id AS "eventId",requested_status AS "requestedStatus",applied,result_status AS "resultStatus",created_at AS "createdAt" FROM commerce_payment_events WHERE org_id=$1 AND order_id=$2 ORDER BY created_at,event_id', [access.org.id, id]);
        const entitlement = (await client.query('SELECT credit_entry_id AS "creditEntryId",course_enrollment_id AS "courseEnrollmentId" FROM commerce_entitlements WHERE org_id=$1 AND order_id=$2', [access.org.id, id])).rows[0] ?? null;
        return { order: orderView(order), events: events.rows, entitlement };
      });
    });
    app.post(`${prefix}/orders/:id/simulate`, async request => {
      const access = await commerceAccess(request, isCentral, 'matraca'), id = commerceParam(request, 'id'), input = parseCommerce(paymentInput, request.body);
      const configuredStatus = input.status ?? await options.defaultPaymentScenario?.(access.org.id) ?? 'approved';
      if (!paymentStatuses.includes(configuredStatus)) throw new CommerceError(409, 'Cenário de pagamento simulado inválido.');
      return commerceMutation(request, access, async (client, current) => {
        const order = await findOrder(client, current, id), signature = hash([id, input.status ?? null]);
        const prior = (await client.query<{ fingerprint: string; applied: boolean }>('SELECT fingerprint,applied FROM commerce_payment_events WHERE org_id=$1 AND event_id=$2', [current.org.id, input.eventId])).rows[0];
        if (prior) { if (prior.fingerprint !== signature) throw new CommerceError(409, 'Evento de pagamento reutilizado com outros dados.'); return { order: orderView(order), applied: prior.applied, replay: true, simulated: true }; }
        const status = configuredStatus;
        let result = order;
        const applied = order.status === 'pending' && status !== 'pending';
        if (applied) {
          if (status === 'approved') await fulfill(client, current, order);
          result = (await client.query<OrderRow>('UPDATE commerce_orders SET status=$3,completed_at=clock_timestamp() WHERE org_id=$1 AND id=$2 RETURNING *', [current.org.id, id, status === 'approved' ? 'paid' : status])).rows[0];
        }
        await client.query(`INSERT INTO commerce_payment_events(org_id,event_id,order_id,requested_status,fingerprint,applied,result_status,actor_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [current.org.id, input.eventId, id, status, signature, applied, result.status, current.actor.user.id]);
        await commerceAudit(client, current, applied ? 'commerce_payment_applied' : 'commerce_payment_ignored', { orderId: id, eventId: input.eventId, status });
        return { order: orderView(result), applied, replay: false, simulated: true };
      });
    });
  }
  app.post('/api/commerce/orders', async (request, reply) => {
    const access = await commerceAccess(request, false, 'matraca'), input = parseCommerce(orderInput, request.body);
    const order = await commerceMutation(request, access, async (client, current) => {
      const signature = hash(input), old = (await client.query<OrderRow>('SELECT * FROM commerce_orders WHERE org_id=$1 AND student_id=$2 AND client_key=$3', [current.org.id, current.actor.user.id, input.clientKey])).rows[0];
      if (old) { if (old.fingerprint !== signature) throw new CommerceError(409, 'Pedido reutilizado com outra oferta.'); return old; }
      const offer = await findOffer(client, current, input.offerId);
      if (offer.status !== 'published' || current.org.status !== 'active') throw new CommerceError(409, 'A oferta não está disponível.');
      if (offer.kind === 'course') {
        if (current.org.settings.coursesEnabled === false) throw new CommerceError(409, 'O módulo de cursos está desativado.');
        if ((await client.query('SELECT id FROM course_enrollments WHERE org_id=$1 AND course_id=$2 AND student_id=$3', [current.org.id, offer.course_id, current.actor.user.id])).rowCount) throw new CommerceError(409, 'Você já possui registro neste curso. Verifique seu acesso com a organização.');
        const available = (await client.query("SELECT id FROM courses WHERE org_id=$1 AND id=$2 AND status='published'", [current.org.id, offer.course_id])).rowCount;
        if (!available) throw new CommerceError(409, 'O curso não está disponível para novas compras.');
      }
      const snapshot = offerView(offer);
      const created = (await client.query<OrderRow>(`INSERT INTO commerce_orders(org_id,student_id,offer_id,client_key,fingerprint,amount_cents,credit_amount,course_id,course_version_id,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [current.org.id, current.actor.user.id, offer.id, input.clientKey, signature, snapshot.amountCents,
        offer.data.creditAmount, offer.course_id, offer.course_version_id, { ...snapshot, currency: 'BRL', simulated: true }])).rows[0];
      await commerceAudit(client, current, 'commerce_order_created', { orderId: created.id }); return created;
    }); return reply.code(201).send({ order: orderView(order) });
  });
}
