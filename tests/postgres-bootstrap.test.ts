import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { startPostgresCluster } from '../scripts/db-start.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn(),
}));
vi.mock('../server/local-database-config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/local-database-config.js')>(),
  clusterSecret: '/fixture/bootstrap.password', localDatabaseConnection: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('baixa a referência exata do Compose quando ainda não há imagem local', () => {
  const image = 'postgres:17-alpine@sha256:' + 'a'.repeat(64);
  const endpoint = 'unix:///fixture/docker.sock';
  const host = '--host=' + endpoint;
  vi.stubEnv('DOCKER_HOST', endpoint);
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (Array.isArray(args) && args.includes('--images')) return image + '\n';
    if (Array.isArray(args) && args.includes('inspect')) throw new Error('Imagem ausente na instalação sintética.');
    return '';
  });
  expect(startPostgresCluster()).toBe(host);
  expect(execFileSync).toHaveBeenCalledWith(
    'docker', [host, 'image', 'inspect', image], expect.anything(),
  );
  expect(execFileSync).toHaveBeenCalledWith(
    'docker', ['--config', expect.any(String), host, 'pull', image], expect.anything(),
  );
  expect(execFileSync).toHaveBeenLastCalledWith(
    'docker', [host, 'compose', 'up', '-d', '--wait', '--pull', 'never'], expect.anything(),
  );
});
