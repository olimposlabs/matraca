import { describe, expect, it } from 'vitest';
import { PricingError, multiplyCents, priceCredits, priceMonthlyLicenses, sumCents,
  validatePriceTable, type PriceTable } from '../server/pricing.js';
import { buildInvoicePreview, nextMonth, resolveContract, snapshotLicenses, validateMonth,
  type ContractVersion, type StudentLicenseCandidate } from '../server/billing-preview.js';

const tiers = [
  { from: 1, to: 9, unitPriceCents: 100 },
  { from: 10, to: 99, unitPriceCents: 90 },
  { from: 100, to: null, unitPriceCents: 80 },
];
const constant: PriceTable = { mode: 'volume', tiers: [{ from: 1, to: null, unitPriceCents: 90 }] };
const licenses = { organizationCents: 100_000, schoolCents: 10_000, studentCents: 100 };
const contract = (id = 'contract-1', effectiveFrom = '2026-01'): ContractVersion => ({
  id, orgId: 'org', effectiveFrom, licenses: { ...licenses }, credits: structuredClone(constant),
});
const student = (id: string, changes: Partial<StudentLicenseCandidate> = {}): StudentLicenseCandidate => ({
  id, orgId: 'org', status: 'active', roles: ['student'], accepted: true, ...changes,
});
const snapshot = (closingMonth = '2026-11') => snapshotLicenses({
  orgId: 'org', closingMonth,
  schools: Array.from({ length: 3 }, (_, index) => ({ id: `school-${index}`, orgId: 'org', status: 'active' as const })),
  students: Array.from({ length: 50 }, (_, index) => student(`student-${index}`)),
});

describe('tabelas de preço e centavos inteiros', () => {
  it.each([
    [0, 0, 0], [1, 100, 100], [9, 900, 900], [10, 900, 990],
    [11, 990, 1080], [99, 8910, 9000], [100, 8000, 9080], [101, 8080, 9160],
  ])('calcula %i créditos nos limites por volume e progressivamente', (quantity, volume, progressive) => {
    expect(priceCredits(quantity, { mode: 'volume', tiers }).totalCents).toBe(volume);
    expect(priceCredits(quantity, { mode: 'progressive', tiers }).totalCents).toBe(progressive);
  });

  it('discrimina parcelas progressivas e conserva quantidade e total', () => {
    const priced = priceCredits(101, { mode: 'progressive', tiers });
    expect(priced.lines).toEqual([
      { from: 1, to: 9, unitPriceCents: 100, quantity: 9, subtotalCents: 900 },
      { from: 10, to: 99, unitPriceCents: 90, quantity: 90, subtotalCents: 8100 },
      { from: 100, to: null, unitPriceCents: 80, quantity: 2, subtotalCents: 160 },
    ]);
    expect(priced.lines.reduce((total, line) => total + line.quantity, 0)).toBe(101);
    expect(priced.lines.reduce((total, line) => total + line.subtotalCents, 0)).toBe(priced.totalCents);
    expect(priceCredits(100, { mode: 'volume', tiers }).lines).toEqual([
      { from: 100, to: null, unitPriceCents: 80, quantity: 100, subtotalCents: 8000 },
    ]);
  });

  it('faixa única funciona nos dois modos e zero não cria parcela', () => {
    expect(priceCredits(100, constant).totalCents).toBe(9000);
    expect(priceCredits(100, { ...constant, mode: 'progressive' }).totalCents).toBe(9000);
    expect(priceCredits(0, constant).lines).toEqual([]);
    expect(priceCredits(500, { mode: 'progressive', tiers: [{ from: 1, to: null, unitPriceCents: 0 }] }).totalCents).toBe(0);
  });

  it.each([
    [],
    [{ from: 0, to: null, unitPriceCents: 1 }],
    [{ from: 2, to: null, unitPriceCents: 1 }],
    [{ from: 1, to: 10, unitPriceCents: 1 }],
    [{ from: 1, to: 10, unitPriceCents: 1 }, { from: 12, to: null, unitPriceCents: 1 }],
    [{ from: 1, to: 10, unitPriceCents: 1 }, { from: 10, to: null, unitPriceCents: 1 }],
    [{ from: 1, to: null, unitPriceCents: 1 }, { from: 2, to: null, unitPriceCents: 1 }],
    [{ from: 1, to: 0, unitPriceCents: 1 }, { from: 1, to: null, unitPriceCents: 1 }],
    [{ from: 1, to: 9.5, unitPriceCents: 1 }, { from: 10.5, to: null, unitPriceCents: 1 }],
    [{ from: 1, to: null, unitPriceCents: -1 }],
    [{ from: 1, to: null, unitPriceCents: 0.9 }],
    [{ from: 1, to: Number.MAX_SAFE_INTEGER, unitPriceCents: 1 }, { from: Number.MAX_SAFE_INTEGER + 1, to: null, unitPriceCents: 1 }],
  ])('rejeita tabela incompleta, sobreposta, descontínua ou não inteira: %j', (...invalidTiers) => {
    // it.each treats each array as the arguments for this case.
    expect(() => validatePriceTable({ mode: 'volume', tiers: invalidTiers })).toThrow(PricingError);
  });

  it('rejeita modo desconhecido mesmo com quantidade zero', () => {
    expect(() => priceCredits(0, { ...constant, mode: 'other' } as unknown as PriceTable)).toThrow(PricingError);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejeita quantidade inválida %s', quantity => {
    expect(() => priceCredits(quantity, constant)).toThrow(PricingError);
  });

  it('mantém precisão no limite seguro e rejeita produto ou soma que o exceda', () => {
    expect(multiplyCents(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(sumCents([Number.MAX_SAFE_INTEGER - 1, 1])).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => multiplyCents(Number.MAX_SAFE_INTEGER, 2)).toThrow(PricingError);
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow(PricingError);
    expect(() => priceCredits(Number.MAX_SAFE_INTEGER, constant)).toThrow(PricingError);
    expect(() => priceCredits(2, { mode: 'progressive', tiers: [
      { from: 1, to: 1, unitPriceCents: Number.MAX_SAFE_INTEGER },
      { from: 2, to: null, unitPriceCents: 1 },
    ] })).toThrow(PricingError);
  });

  it('licenças mensais cobram organização, escolas e alunos sem componente de professor', () => {
    expect(priceMonthlyLicenses(licenses, { schools: 3, students: 50 })).toMatchObject({
      organizationTotalCents: 100_000, schoolsTotalCents: 30_000, studentsTotalCents: 5000, totalCents: 135_000,
    });
    expect(priceMonthlyLicenses(licenses, { schools: 0, students: 0 }).totalCents).toBe(100_000);
    expect(() => priceMonthlyLicenses(licenses, { schools: -1, students: 1 })).toThrow(PricingError);
    expect(() => priceMonthlyLicenses({ ...licenses, schoolCents: 0.5 }, { schools: 1, students: 1 })).toThrow(PricingError);
    expect(() => priceMonthlyLicenses({ organizationCents: 1, schoolCents: 1, studentCents: 0 }, { schools: Number.MAX_SAFE_INTEGER, students: 0 })).toThrow(PricingError);
  });
});

describe('snapshot e demonstrativo de fechamento mensal', () => {
  it('reproduz R$ 1.440 com licenças de dezembro e consumo líquido de novembro', () => {
    const invoice = buildInvoicePreview({ orgId: 'org', consumptionMonth: '2026-11', snapshot: snapshot(),
      usage: { consumedCredits: 105, refundedCredits: 5 }, contracts: [contract()] });
    expect(invoice).toMatchObject({ currency: 'BRL', consumptionMonth: '2026-11', licenseMonth: '2026-12', totalCents: 144_000,
      usage: { consumedCredits: 105, refundedCredits: 5, netCredits: 100, pricing: { totalCents: 9000 } }, licenses: { totalCents: 135_000 } });
    expect(invoice.lines.map(line => [line.kind, line.month, line.subtotalCents])).toEqual([
      ['organization_license', '2026-12', 100_000], ['school_license', '2026-12', 30_000],
      ['student_license', '2026-12', 5000], ['credit_usage', '2026-11', 9000],
    ]);
    expect(invoice.snapshot.schoolIds).toHaveLength(3);
    expect(invoice.snapshot.studentIds).toHaveLength(50);
  });

  it('agrega o consumo líquido antes de escolher a faixa mensal', () => {
    const progressive = { ...contract(), credits: { mode: 'progressive' as const, tiers } };
    const preview = buildInvoicePreview({ orgId: 'org', consumptionMonth: '2026-11', snapshot: snapshot(),
      usage: { consumedCredits: 12, refundedCredits: 2 }, contracts: [progressive] });
    expect(preview.usage.pricing.totalCents).toBe(990);
    expect(preview.usage.netCredits).toBe(10);
    expect(preview.totalCents).toBe(135_990);
  });

  it('conta aluno ativo aceito uma vez por organização, independentemente de papéis ou turmas', () => {
    const mixed = student('mixed', { roles: ['teacher', 'student', 'school'] });
    const result = snapshotLicenses({ orgId: 'org', closingMonth: '2026-12', schools: [
      { id: 'active', orgId: 'org', status: 'active' }, { id: 'active', orgId: 'org', status: 'active' },
      { id: 'archived', orgId: 'org', status: 'archived' },
    ], students: [mixed, mixed, student('plain'), student('not-accepted', { accepted: false }),
      student('invited', { status: 'invited' }), student('suspended', { status: 'suspended' }),
      student('archived', { status: 'archived' }), student('teacher', { roles: ['teacher'] })] });
    expect(result).toEqual({ orgId: 'org', closingMonth: '2026-12', licenseMonth: '2027-01', timezone: 'America/Sao_Paulo',
      schoolIds: ['active'], studentIds: ['mixed', 'plain'] });
  });

  it('rejeita candidatos estrangeiros ou versões contraditórias de um mesmo aluno', () => {
    expect(() => snapshotLicenses({ orgId: 'org', closingMonth: '2026-11', schools: [], students: [student('foreign', { orgId: 'other' })] })).toThrow(PricingError);
    expect(() => snapshotLicenses({ orgId: 'org', closingMonth: '2026-11', schools: [{ id: 'school', orgId: 'other', status: 'active' }], students: [] })).toThrow(PricingError);
    expect(() => snapshotLicenses({ orgId: 'org', closingMonth: '2026-11', schools: [], students: [student('same'), student('same', { status: 'suspended' })] })).toThrow(PricingError);
  });

  it('seleciona vigência separada para consumo anterior e licenças seguintes', () => {
    const first = contract('original'), second = contract('new', '2026-12');
    second.licenses.organizationCents = 120_000;
    second.credits.tiers = [{ from: 1, to: null, unitPriceCents: 200 }];
    const invoice = buildInvoicePreview({ orgId: 'org', consumptionMonth: '2026-11', snapshot: snapshot(),
      usage: { consumedCredits: 100, refundedCredits: 0 }, contracts: [second, first] });
    expect(invoice.contracts.consumption.id).toBe('original');
    expect(invoice.contracts.licenses.id).toBe('new');
    expect(invoice.usage.pricing.totalCents).toBe(9000);
    expect(invoice.licenses.totalCents).toBe(155_000);
    expect(invoice.totalCents).toBe(164_000);
    expect(resolveContract([first, second], 'org', '2026-12').id).toBe('new');
  });

  it('retorna cópias independentes dos contratos, faixas e IDs do snapshot', () => {
    const original = contract(), census = snapshot();
    const invoice = buildInvoicePreview({ orgId: 'org', consumptionMonth: '2026-11', snapshot: census,
      usage: { consumedCredits: 100, refundedCredits: 0 }, contracts: [original] });
    original.licenses.organizationCents = 1;
    original.credits.tiers[0].unitPriceCents = 1;
    census.studentIds.push('new-user-after-cut');
    expect(invoice.contracts.licenses.licenses.organizationCents).toBe(100_000);
    expect(invoice.contracts.consumption.credits.tiers[0].unitPriceCents).toBe(90);
    expect(invoice.snapshot.studentIds).toHaveLength(50);
    expect(invoice.totalCents).toBe(144_000);
  });

  it('não inventa vigência nem aceita versões ambíguas ou contrato de outro tenant', () => {
    expect(() => resolveContract([], 'org', '2026-11')).toThrow(PricingError);
    expect(() => resolveContract([contract('future', '2027-01')], 'org', '2026-11')).toThrow(PricingError);
    expect(() => resolveContract([contract('a'), contract('b')], 'org', '2026-11')).toThrow(PricingError);
    expect(() => resolveContract([contract('same'), contract('same', '2026-12')], 'org', '2026-11')).toThrow(PricingError);
    expect(() => resolveContract([contract()], 'foreign-org', '2026-11')).toThrow(PricingError);
  });

  it('rejeita snapshot de outro mês, outro tenant ou IDs já consolidados duplicados', () => {
    const input = { orgId: 'org', consumptionMonth: '2026-11', snapshot: snapshot(), usage: { consumedCredits: 1, refundedCredits: 0 }, contracts: [contract()] };
    expect(() => buildInvoicePreview({ ...input, snapshot: snapshot('2026-10') })).toThrow(PricingError);
    expect(() => buildInvoicePreview({ ...input, snapshot: { ...input.snapshot, orgId: 'other' } })).toThrow(PricingError);
    expect(() => buildInvoicePreview({ ...input, snapshot: { ...input.snapshot, studentIds: ['same', 'same'] } })).toThrow(PricingError);
  });

  it('estorno integral zera consumo; estorno histórico não gera consumo negativo silencioso', () => {
    const input = { orgId: 'org', consumptionMonth: '2026-11', snapshot: snapshot(), usage: { consumedCredits: 5, refundedCredits: 5 }, contracts: [contract()] };
    expect(buildInvoicePreview(input).totalCents).toBe(135_000);
    expect(buildInvoicePreview(input).usage.pricing.lines).toEqual([]);
    expect(() => buildInvoicePreview({ ...input, usage: { consumedCredits: 5, refundedCredits: 6 } })).toThrow(PricingError);
    expect(() => buildInvoicePreview({ ...input, usage: { consumedCredits: -1, refundedCredits: 0 } })).toThrow(PricingError);
  });

  it('rejeita overflow do total mesmo quando cada parcela é válida', () => {
    const expensive = contract();
    expensive.licenses = { organizationCents: Number.MAX_SAFE_INTEGER, schoolCents: 0, studentCents: 0 };
    expect(() => buildInvoicePreview({ orgId: 'org', consumptionMonth: '2026-11', snapshot: snapshot(),
      usage: { consumedCredits: 1, refundedCredits: 0 }, contracts: [expensive] })).toThrow(PricingError);
  });

  it('valida competências e avança corretamente na virada de ano', () => {
    expect(nextMonth('2026-11')).toBe('2026-12');
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('0001-01')).toBe('0001-02');
    for (const invalid of ['2026-1', '2026-00', '2026-13', '0000-12', '2026-11-01', ' 2026-11', 'no-month']) {
      expect(() => validateMonth(invalid)).toThrow(PricingError);
    }
    expect(() => nextMonth('9999-12')).toThrow(PricingError);
  });
});
