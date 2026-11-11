import { parseArgs } from 'node:util';
import { closeBillingPeriod } from '../server/billing.js';
import { configuration } from '../server/config.js';
import { createDatabase } from '../server/db.js';
import { financialClock, readOperationPolicy } from '../server/operation-policy.js';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    month: { type: 'string' },
    operator: { type: 'string', default: 'operador@matraca.test' },
  },
});
if (!values.org || !values.month) {
  throw new Error('Use npm run billing:close -- --org parceiro --month AAAA-MM.');
}

const db = createDatabase(configuration().databaseUrl);
try {
  const { rows: [target] } = await db.query<{ org_id: string; actor_id: string }>(`
    SELECT org.id AS org_id, operator.id AS actor_id
    FROM orgs org
    CROSS JOIN users operator
    JOIN orgs office ON office.id = operator.org_id
    WHERE org.slug = $1 AND org.kind = 'partner' AND org.status = 'active'
      AND office.kind = 'backoffice' AND office.status = 'active'
      AND operator.email = $2 AND operator.status = 'active' AND operator.archived_at IS NULL
      AND operator.roles = ARRAY['operator']::text[]
  `, [values.org, values.operator]);
  if (!target) throw new Error('Parceiro ou operador ativo não encontrado.');
  const { config } = await readOperationPolicy(db, target.org_id);
  const result = await closeBillingPeriod(db, {
    orgId: target.org_id, actorId: target.actor_id, month: values.month, now: financialClock(config),
  });
  process.stdout.write(JSON.stringify({
    invoiceId: result.invoice.id,
    consumptionMonth: result.invoice.consumptionMonth,
    totalCents: result.invoice.totalCents,
    simulated: true,
    replay: result.replay,
  }) + '\n');
} finally {
  await db.close();
}
