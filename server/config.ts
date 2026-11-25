import { resolve } from 'node:path';
import { assertLocalAppMode, localDatabaseConnection } from './local-database-config.js';
export function configuration(overrides: { databaseUrl?: string; storageRoot?: string } = {}) {
  assertLocalAppMode();
  return {
    get databaseUrl() { return overrides.databaseUrl ?? process.env.DATABASE_URL ?? localDatabaseConnection('runtime'); },
    storageRoot: resolve(overrides.storageRoot ?? process.env.STORAGE_ROOT ?? '.data/local/objects'),
    port: Number(process.env.PORT ?? 3001),
  };
}
export function localHostname(host: string | undefined): string | null {
  if (!host || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) return null;
  const hostname = host.split(':')[0].toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost') ? hostname : null;
}

export function localPartnerDomainSuffix(): string {
  const suffix = process.env.APP_PARTNER_DOMAIN_SUFFIX ?? 'matraca.localhost';
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?matraca\.localhost$/.test(suffix)) {
    throw new Error('APP_PARTNER_DOMAIN_SUFFIX inválido.');
  }
  return suffix;
}
