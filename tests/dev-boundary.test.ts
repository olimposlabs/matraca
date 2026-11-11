import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

it('Vite não publica dados privados por caminho relativo nem /@fs', async () => {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const privateRoot = join(projectRoot, '.data');
  await mkdir(privateRoot, { recursive: true });
  // This directory and its contents belong exclusively to this test.
  const ownedDirectory = await mkdtemp(join(privateRoot, 'boundary-test-'));
  const markerPath = join(ownedDirectory, 'synthetic-marker.txt');
  const marker = 'synthetic-private-boundary-fixture';
  await writeFile(markerPath, marker, { mode: 0o600 });
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    vite = await createServer({
      configFile: join(projectRoot, 'vite.config.ts'),
      envDir: false,
      cacheDir: join(ownedDirectory, 'vite-cache'),
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Servidor de teste não abriu porta local.');
    const base = `http://127.0.0.1:${address.port}`;
    const publicResponse = await fetch(`${base}/client/styles.css`);
    expect(publicResponse.status).toBe(200);
    const relative = markerPath.slice(projectRoot.length).replaceAll('\\', '/');
    for (const path of [`/${relative}`, `/@fs/${markerPath}`, `/${relative}?raw`, `/@fs/${markerPath}?raw`]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(403);
      expect((await response.text()).includes(marker)).toBe(false);
    }
  } finally {
    await vite?.close();
    await rm(ownedDirectory, { recursive: true, force: true });
  }
});
