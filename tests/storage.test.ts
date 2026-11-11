import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { LocalStorage } from '../server/storage.js';

describe('armazenamento local privado', () => {
  it('preserva objetos entre instâncias e permite leitura por faixa', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matraca-storage-test-'));
    try {
      await new LocalStorage(root).put('org/media', Readable.from(['conteudo-real']));
      const restored = new LocalStorage(root);
      expect((await restored.info('org/media')).size).toBe(13);
      const chunks: Buffer[] = [];
      for await (const chunk of restored.read('org/media', { start: 0, end: 7 })) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('conteudo');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejeita caminhos que escapam do armazenamento', () => {
    const storage = new LocalStorage('/tmp/matraca-test');
    for (const key of ['../secret', '/etc/passwd', 'a/../../b', 'a\\b', 'a%2fb']) expect(() => storage.path(key)).toThrow();
  });
});
