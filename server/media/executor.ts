import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const tag = 'matraca-media:8.1.3';
const imageId = /^sha256:[a-f0-9]{64}$/u;
const localSocket = /^unix:\/\/\/[^\r\n]+$/u;
const dockerEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, LANG: 'C' });

export interface MediaExecutor { image: string; host: string }
export class MediaExecutorError extends Error {
  constructor(readonly kind: 'temporary' | 'timeout') { super(kind); }
}
const run = [
  'run', '--pull=never', '--rm', '--init', '--network=none', '--read-only', '--log-driver=none',
  '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges',
  '--pids-limit=32', '--cpus=1', '--memory=512m', '--memory-swap=512m',
  '--tmpfs=/work:rw,noexec,nodev,nosuid,size=224m,mode=0700,uid=65534,gid=65534',
];

export async function verifiedMediaExecutor(): Promise<MediaExecutor> {
  try {
    const env = dockerEnv();
    const selected = process.env.DOCKER_HOST ?? (await execute('docker', [
      'context', 'inspect', '--format={{.Endpoints.docker.Host}}', ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []),
    ], { env, timeout: 5000 })).stdout.trim();
    if (!localSocket.test(selected)) throw new Error('Local Unix socket required');
    const host = `--host=${selected}`;
    const { stdout } = await execute('docker', [host, 'image', 'inspect', '--format={{.Id}}', tag], { env, timeout: 5000 });
    const image = stdout.trim();
    if (!imageId.test(image)) throw new Error('Invalid image');
    const verified = await execute('docker', [host, ...run, '--entrypoint=/usr/local/bin/verify-media', image, 'runtime'], { env,
      timeout: 10_000, maxBuffer: 16_384,
    });
    if (verified.stdout.trim() !== 'FFmpeg 8.1.3 verificado') throw new Error('Invalid version');
    return { image, host };
  } catch {
    throw new Error('Executor de mídia indisponível. Execute npm run media:build e confira npm run media:verify.');
  }
}

/** Copies a single private file through stdin. The decoder receives no host mounts or environment. */
export async function runMediaDecoder(executor: MediaExecutor, path: string, args: string[], signal: AbortSignal) {
  const { image, host } = executor;
  if (!imageId.test(image) || !host.startsWith('--host=') || !localSocket.test(host.slice(7))) throw new Error('Invalid media executor');
  signal.throwIfAborted();
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const data = await input.stat();
    if (!data.isFile() || data.size < 1 || data.size > 200 * 1024 * 1024) throw new Error('Invalid media input');
    const name = `matraca-media-${randomUUID()}`;
    const env = dockerEnv();
    const started = performance.now();
    const result = execute('docker', [host, ...run, '--interactive', '--name', name, image, ...args], {
      env, signal, timeout: 60_000, maxBuffer: 17 * 1024 * 1024, encoding: 'buffer', killSignal: 'SIGKILL',
    });
    try {
      const source = input.createReadStream({ autoClose: false, start: 0, end: data.size - 1 });
      const [finished, sent] = await Promise.allSettled([result, pipeline(source, result.child.stdin!, { signal })]);
      if (finished.status === 'rejected') {
        const error = finished.reason as { code?: string | number; killed?: boolean };
        // A fast SIGKILL can be the container memory limit, unlike the 55-second watchdog.
        const watchdogElapsed = error.code === 137 && performance.now() - started >= 55_000;
        if (signal.aborted || error.killed || error.code === 124 || watchdogElapsed) throw new MediaExecutorError('timeout');
        if (error.code === 125 || error.code === 126 || error.code === 127 || error.code === 'ENOENT') throw new MediaExecutorError('temporary');
        const available = await execute('docker', [host, 'info', '--format={{.ServerVersion}}'], {
          env, signal, timeout: 2500, maxBuffer: 4096,
        }).then(() => true, () => false);
        if (!available) throw new MediaExecutorError('temporary');
        throw new Error('Could not decode media');
      }
      if (sent.status === 'rejected') throw new Error('Could not read media');
      return finished.value.stdout;
    } finally {
      await execute('docker', [host, 'container', 'rm', '--force', name], { env, timeout: 5000 }).catch(() => {});
    }
  } finally { await input.close(); }
}
