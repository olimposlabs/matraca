/** Pure monetary calculations. All external monetary values are integer BRL cents. */
export class PricingError extends Error {
  constructor(message: string) { super(message); this.name = 'PricingError'; }
}

export interface PriceTier {
  from: number;
  to: number | null;
  unitPriceCents: number;
}
export interface PriceTable {
  mode: 'volume' | 'progressive';
  tiers: readonly PriceTier[];
}
export interface PriceLine {
  from: number;
  to: number | null;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
}
export interface CreditPrice {
  mode: PriceTable['mode'];
  quantity: number;
  totalCents: number;
  lines: PriceLine[];
}
export interface LicensePrices {
  organizationCents: number;
  schoolCents: number;
  studentCents: number;
}

export function nonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new PricingError(`${field} deve ser inteiro não negativo seguro.`);
  return value;
}

function safeMoney(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new PricingError('Valor monetário excede o limite seguro.');
  return Number(value);
}

export function sumCents(values: readonly number[]): number {
  return safeMoney(values.reduce((total, value) => total + BigInt(nonnegativeInteger(value, 'Valor em centavos')), 0n));
}

export function multiplyCents(quantity: number, unitPriceCents: number): number {
  return safeMoney(BigInt(nonnegativeInteger(quantity, 'Quantidade')) * BigInt(nonnegativeInteger(unitPriceCents, 'Preço em centavos')));
}

/** Validates the published order; it never sorts, fills gaps or invents a price. */
export function validatePriceTable(table: PriceTable): PriceTable {
  if (!table || !['volume', 'progressive'].includes(table.mode) || !Array.isArray(table.tiers) || table.tiers.length === 0) {
    throw new PricingError('Informe modo de preço e pelo menos uma faixa.');
  }
  let next = 1n;
  const tiers = table.tiers.map((tier, index) => {
    if (!tier) throw new PricingError('Faixa inválida.');
    nonnegativeInteger(tier.from, 'Início da faixa');
    nonnegativeInteger(tier.unitPriceCents, 'Preço da faixa');
    if (BigInt(tier.from) !== next) throw new PricingError('Faixas devem começar em 1 e ser contíguas, ordenadas e sem sobreposição.');
    if (tier.to === null) {
      if (index !== table.tiers.length - 1) throw new PricingError('Somente a última faixa pode ser ilimitada.');
    } else {
      nonnegativeInteger(tier.to, 'Fim da faixa');
      if (tier.to < tier.from) throw new PricingError('Fim da faixa anterior ao início.');
      if (index === table.tiers.length - 1) throw new PricingError('A última faixa precisa cobrir todas as quantidades restantes.');
      next = BigInt(tier.to) + 1n;
    }
    return { from: tier.from, to: tier.to, unitPriceCents: tier.unitPriceCents };
  });
  return { mode: table.mode, tiers };
}

export function priceCredits(quantity: number, input: PriceTable): CreditPrice {
  nonnegativeInteger(quantity, 'Quantidade de créditos');
  const table = validatePriceTable(input);
  const lines: PriceLine[] = [];
  if (quantity === 0) return { mode: table.mode, quantity, totalCents: 0, lines };
  for (const tier of table.tiers) {
    if (quantity < tier.from) break;
    if (table.mode === 'volume') {
      if (tier.to !== null && quantity > tier.to) continue;
      lines.push({ ...tier, quantity, subtotalCents: multiplyCents(quantity, tier.unitPriceCents) });
      break;
    }
    const part = Math.min(quantity, tier.to ?? quantity) - tier.from + 1;
    lines.push({ ...tier, quantity: part, subtotalCents: multiplyCents(part, tier.unitPriceCents) });
  }
  return { mode: table.mode, quantity, lines, totalCents: sumCents(lines.map(line => line.subtotalCents)) };
}

export function validateLicensePrices(prices: LicensePrices): LicensePrices {
  return {
    organizationCents: nonnegativeInteger(prices.organizationCents, 'Licença da organização'),
    schoolCents: nonnegativeInteger(prices.schoolCents, 'Licença por escola'),
    studentCents: nonnegativeInteger(prices.studentCents, 'Licença por aluno'),
  };
}

export function priceMonthlyLicenses(input: LicensePrices, counts: { schools: number; students: number }) {
  const prices = validateLicensePrices(input);
  const schools = nonnegativeInteger(counts.schools, 'Quantidade de escolas');
  const students = nonnegativeInteger(counts.students, 'Quantidade de alunos');
  const organizationTotalCents = prices.organizationCents;
  const schoolsTotalCents = multiplyCents(schools, prices.schoolCents);
  const studentsTotalCents = multiplyCents(students, prices.studentCents);
  return { prices, schools, students, organizationTotalCents, schoolsTotalCents, studentsTotalCents,
    totalCents: sumCents([organizationTotalCents, schoolsTotalCents, studentsTotalCents]) };
}
