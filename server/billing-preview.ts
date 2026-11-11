import { PricingError, nonnegativeInteger, priceCredits, priceMonthlyLicenses, sumCents,
  validateLicensePrices, validatePriceTable, type LicensePrices, type PriceTable } from './pricing.js';

export interface ContractVersion {
  id: string;
  orgId: string;
  effectiveFrom: string;
  licenses: LicensePrices;
  credits: PriceTable;
}
export interface SchoolLicenseCandidate { id: string; orgId: string; status: 'active' | 'archived' }
export interface StudentLicenseCandidate {
  id: string;
  orgId: string;
  status: 'invited' | 'active' | 'suspended' | 'archived';
  roles: readonly string[];
  accepted: boolean;
}
export interface LicenseSnapshot {
  orgId: string;
  closingMonth: string;
  licenseMonth: string;
  timezone: 'America/Sao_Paulo';
  schoolIds: string[];
  studentIds: string[];
}

function identifier(value: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 160) throw new PricingError('Identificador inválido.');
  return value;
}

export function validateMonth(month: string): string {
  if (typeof month !== 'string' || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new PricingError('Competência deve usar YYYY-MM válido.');
  return month;
}

export function nextMonth(month: string): string {
  validateMonth(month);
  const [year, number] = month.split('-').map(Number);
  if (number < 12) return `${year.toString().padStart(4, '0')}-${(number + 1).toString().padStart(2, '0')}`;
  if (year === 9999) throw new PricingError('Competência seguinte excede o intervalo suportado.');
  return `${(year + 1).toString().padStart(4, '0')}-01`;
}

/** Candidates must already represent persisted state at the São Paulo month-end cut. */
export function snapshotLicenses(input: {
  orgId: string;
  closingMonth: string;
  schools: readonly SchoolLicenseCandidate[];
  students: readonly StudentLicenseCandidate[];
}): LicenseSnapshot {
  const orgId = identifier(input.orgId), closingMonth = validateMonth(input.closingMonth);
  const schools = new Map<string, string>(), students = new Map<string, string>();
  const eligibleSchools = new Set<string>(), eligibleStudents = new Set<string>();
  for (const school of input.schools) {
    identifier(school.id);
    if (school.orgId !== orgId || !['active', 'archived'].includes(school.status)) throw new PricingError('Escola de outra organização ou estado inválido.');
    if (schools.has(school.id) && schools.get(school.id) !== school.status) throw new PricingError('Snapshot contém estados conflitantes para a mesma escola.');
    schools.set(school.id, school.status);
    if (school.status === 'active') eligibleSchools.add(school.id);
  }
  for (const student of input.students) {
    identifier(student.id);
    if (student.orgId !== orgId || !['invited', 'active', 'suspended', 'archived'].includes(student.status)
      || typeof student.accepted !== 'boolean' || !Array.isArray(student.roles) || student.roles.some(role => typeof role !== 'string')) {
      throw new PricingError('Aluno de outra organização ou estado inválido.');
    }
    const eligible = student.status === 'active' && student.accepted && student.roles.includes('student');
    const signature = JSON.stringify([student.status, student.accepted, [...new Set(student.roles)].sort()]);
    if (students.has(student.id) && students.get(student.id) !== signature) throw new PricingError('Snapshot contém estados conflitantes para o mesmo aluno.');
    students.set(student.id, signature);
    if (eligible) eligibleStudents.add(student.id);
  }
  return { orgId, closingMonth, licenseMonth: nextMonth(closingMonth), timezone: 'America/Sao_Paulo',
    schoolIds: [...eligibleSchools].sort(), studentIds: [...eligibleStudents].sort() };
}

function copyContracts(versions: readonly ContractVersion[], orgId: string): ContractVersion[] {
  const ids = new Set<string>(), months = new Set<string>();
  return versions.map(version => {
    identifier(version.id);
    validateMonth(version.effectiveFrom);
    if (version.orgId !== orgId) throw new PricingError('Contrato de outra organização.');
    if (ids.has(version.id) || months.has(version.effectiveFrom)) throw new PricingError('Versão ou vigência contratual duplicada.');
    ids.add(version.id); months.add(version.effectiveFrom);
    return { id: version.id, orgId, effectiveFrom: version.effectiveFrom,
      licenses: validateLicensePrices(version.licenses), credits: validatePriceTable(version.credits) };
  }).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

export function resolveContract(versions: readonly ContractVersion[], orgId: string, month: string): ContractVersion {
  identifier(orgId); validateMonth(month);
  const contract = copyContracts(versions, orgId).findLast(version => version.effectiveFrom <= month);
  if (!contract) throw new PricingError('Não há contrato vigente para a competência.');
  return contract;
}

function cloneSnapshot(snapshot: LicenseSnapshot, orgId: string, closingMonth: string): LicenseSnapshot {
  if (snapshot.orgId !== orgId || snapshot.closingMonth !== closingMonth || snapshot.licenseMonth !== nextMonth(closingMonth)
    || snapshot.timezone !== 'America/Sao_Paulo') throw new PricingError('Snapshot não corresponde à organização ou ao fechamento.');
  const cloneIds = (ids: readonly string[]) => {
    ids.forEach(identifier);
    if (new Set(ids).size !== ids.length) throw new PricingError('Snapshot consolidado contém IDs duplicados.');
    return [...ids].sort();
  };
  return { orgId, closingMonth, licenseMonth: snapshot.licenseMonth, timezone: snapshot.timezone,
    schoolIds: cloneIds(snapshot.schoolIds), studentIds: cloneIds(snapshot.studentIds) };
}

/** Preview only: persistence, closing idempotency, payment and historical adjustments are caller responsibilities. */
export function buildInvoicePreview(input: {
  orgId: string;
  consumptionMonth: string;
  snapshot: LicenseSnapshot;
  usage: { consumedCredits: number; refundedCredits: number };
  contracts: readonly ContractVersion[];
}) {
  const orgId = identifier(input.orgId), consumptionMonth = validateMonth(input.consumptionMonth);
  const snapshot = cloneSnapshot(input.snapshot, orgId, consumptionMonth);
  const consumptionContract = resolveContract(input.contracts, orgId, consumptionMonth);
  const licenseContract = resolveContract(input.contracts, orgId, snapshot.licenseMonth);
  const consumedCredits = nonnegativeInteger(input.usage.consumedCredits, 'Consumo concluído');
  const refundedCredits = nonnegativeInteger(input.usage.refundedCredits, 'Créditos estornados da competência');
  if (refundedCredits > consumedCredits) throw new PricingError('Estorno excede consumo da competência; ajuste histórico deve ser tratado separadamente.');
  const netCredits = consumedCredits - refundedCredits;
  const usagePrice = priceCredits(netCredits, consumptionContract.credits);
  const licensePrice = priceMonthlyLicenses(licenseContract.licenses, { schools: snapshot.schoolIds.length, students: snapshot.studentIds.length });
  const lines = [
    { kind: 'organization_license' as const, month: snapshot.licenseMonth, contractId: licenseContract.id, quantity: 1,
      unitPriceCents: licensePrice.prices.organizationCents, subtotalCents: licensePrice.organizationTotalCents },
    { kind: 'school_license' as const, month: snapshot.licenseMonth, contractId: licenseContract.id, quantity: licensePrice.schools,
      unitPriceCents: licensePrice.prices.schoolCents, subtotalCents: licensePrice.schoolsTotalCents },
    { kind: 'student_license' as const, month: snapshot.licenseMonth, contractId: licenseContract.id, quantity: licensePrice.students,
      unitPriceCents: licensePrice.prices.studentCents, subtotalCents: licensePrice.studentsTotalCents },
    ...usagePrice.lines.map(line => ({ kind: 'credit_usage' as const, month: consumptionMonth, contractId: consumptionContract.id, ...line })),
  ];
  return { orgId, currency: 'BRL' as const, consumptionMonth, licenseMonth: snapshot.licenseMonth, snapshot,
    contracts: { consumption: consumptionContract, licenses: licenseContract },
    usage: { consumedCredits, refundedCredits, netCredits, pricing: usagePrice },
    licenses: licensePrice, lines, totalCents: sumCents(lines.map(line => line.subtotalCents)) };
}
