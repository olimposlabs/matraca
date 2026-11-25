import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const gitleaks = 'zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
const digest = /@sha256:[a-f0-9]{64}$/u;

function pinnedReferences() {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const actions = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gmu)].map(match => match[1]);
  if (actions.length === 0 || actions.some(action => !/^[\w-]+\/[\w.-]+@[a-f0-9]{40}$/u.test(action))) {
    throw new Error('Fixe as Actions por SHA completo.');
  }
  for (const file of ['.github/workflows/ci.yml', 'compose.yaml']) {
    const images = [...readFileSync(file, 'utf8').matchAll(/^\s*image:\s*(\S+)/gmu)].map(match => match[1]);
    if (!images.some(image => image.startsWith('postgres:')) || images.some(image => !digest.test(image))) {
      throw new Error(`Fixe as imagens de ${file} por digest.`);
    }
  }
  const from = /^FROM\s+(\S+)/mu.exec(readFileSync('infra/media/Dockerfile', 'utf8'));
  if (!from || !digest.test(from[1]) || !digest.test(gitleaks)) throw new Error('Confira os digests dos executores.');
}

function advisories() {
  const audit = spawnSync('npm', ['audit', '--package-lock-only', '--json'], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  let result;
  try { result = JSON.parse(audit.stdout ?? ''); }
  catch { throw new Error('Consulta de advisories npm indisponível.'); }
  const total = result?.metadata?.vulnerabilities?.total;
  if (result?.error || !Number.isSafeInteger(total) || total < 0) throw new Error('Consulta de advisories npm indisponível.');
  if (total) throw new Error(`O lockfile apresentou ${total} alerta(s) no registro npm.`);
  if (audit.status !== 0) throw new Error('A consulta npm terminou com erro.');
  process.stdout.write('Advisories do lockfile npm: 0.\n');
}

function scanTrackedFiles() {
  const snapshot = mkdtempSync(join(tmpdir(), 'matraca-secret-check-'));
  try {
    const exportIndex = spawnSync('git', ['checkout-index', '--all', `--prefix=${snapshot}${sep}`], { stdio: 'ignore' });
    if (exportIndex.status !== 0) throw new Error('Não foi possível preparar os arquivos versionados.');
    const scan = spawnSync('docker', [
      'run', '--rm', '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--mount', `type=bind,src=${snapshot},dst=/src,readonly`,
      gitleaks, 'dir', '--no-banner', '--redact=100', '--log-level=error', '--exit-code=9', '--config=/src/.gitleaks.toml', '/src',
    ], { stdio: 'ignore', timeout: 120000 });
    if (scan.status === 9) throw new Error('O exame encontrou possível segredo em arquivo versionado. Reveja o índice do Git em ambiente privado.');
    if (scan.status !== 0) throw new Error('Varredura dos arquivos versionados indisponível.');
    process.stdout.write('Arquivos versionados examinados com Gitleaks. Nenhum alerta.\n');
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
}

try {
  pinnedReferences();
  advisories();
  scanTrackedFiles();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha na verificação de insumos.'}\n`);
  process.exitCode = 1;
}
