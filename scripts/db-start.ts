import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A imagem é pública. Um config isolado evita depender de login/Keychain do Docker Desktop.
export function startLocalDatabase() {
  try { execFileSync('docker', ['image', 'inspect', 'postgres:17-alpine'], { stdio: 'ignore', timeout: 10000 }); }
  catch {
    const directory = mkdtempSync(join(tmpdir(), 'matraca-public-docker-'));
    try {
      writeFileSync(join(directory, 'config.json'), '{}\n', { mode: 0o600 });
      const endpoint = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', timeout: 10000 }).trim();
      execFileSync('docker', ['--config', directory, '--host', endpoint, 'pull', 'postgres:17-alpine'], { stdio: 'inherit', timeout: 180000 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  execFileSync('docker', ['compose', 'up', '-d', '--wait', '--pull', 'never'], { stdio: 'inherit', timeout: 90000 });
}
if (process.argv[1]?.endsWith('db-start.ts')) startLocalDatabase();
