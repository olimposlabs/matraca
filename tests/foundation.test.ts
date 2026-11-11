import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';

describe('fundação local do Matraca', () => {
  let app: FastifyInstance;
  let storageRoot: string;

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'matraca-foundation-'));
    app = await createApp({
      ...(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {}),
      storageRoot,
    });
  });

  afterAll(async () => {
    await app?.close();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it('informa saúde somente quando consegue consultar o PostgreSQL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', database: 'ok', mode: 'local' });
  });

  it.each([
    'localhost',
    'localhost:3000',
    'matraca.localhost',
    'escola.matraca.localhost:3000',
    '127.0.0.1',
    '127.0.0.1:3000',
  ])('aceita o host local permitido %s', async (host) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host },
    });

    expect(response.statusCode).toBe(200);
  });

  it.each(['evil.example', 'localhost.evil.example', 'evillocalhost'])(
    'rejeita o host fora da allowlist %s', async (host) => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host },
      });

      expect(response.statusCode).toBe(400);
    },
  );

  it('não usa X-Forwarded-Host para contornar a allowlist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example', 'x-forwarded-host': 'localhost' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('trata falha de conexão ociosa sem exceção não capturada nem credenciais no log', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sensitiveError = new Error('postgresql://healthcheck:private-idle-password@localhost/database');

    try {
      expect(() => app.db.pool.emit('error', sensitiveError)).not.toThrow();
      expect(stderr).toHaveBeenCalled();
      const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).not.toContain('private-idle-password');
      expect(output).not.toContain('postgresql://');
    } finally {
      stderr.mockRestore();
    }
  });

  it('retorna 503 sem expor credenciais quando o PostgreSQL está indisponível', async () => {
    const unavailableApp = await createApp({
      databaseUrl: 'postgresql://healthcheck:private-test-password@127.0.0.1:1/unavailable',
      storageRoot,
    });

    try {
      const response = await unavailableApp.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host: 'localhost' },
      });

      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('private-test-password');
      expect(response.body).not.toContain('postgresql://');
    } finally {
      await unavailableApp.close();
    }
  });
});
