import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { extractEvaluationMedia } from '../server/evaluation/openai-media.js';
import { verifiedMediaExecutor, type MediaExecutor } from '../server/media/executor.js';

const execute = promisify(execFile);
describe('derivados de mídia para OpenAI', () => {
  let directory: string;
  let executor: MediaExecutor;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'matraca-media-test-'));
    vi.stubEnv('MATRACA_MEDIA_TEST_MARKER', 'marcador-sintetico');
    try { executor = await verifiedMediaExecutor(); }
    finally { vi.unstubAllEnvs(); }
  }, 15_000);
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
  it('divide cinco minutos de áudio em cinco blocos limitados, sem imagens', async () => {
    const path = join(directory, 'long.wav');
    await execute(ffmpeg.path, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '300', path]);
    const media = await extractEvaluationMedia(executor, path, 'wav', { id: 'test', durationMicroseconds: 300_000_000, hasAudio: true, hasVideo: false }, new AbortController().signal);
    expect(media.frames).toEqual([]);
    expect(media.audio.map(({ startUs, endUs }) => [startUs, endUs])).toEqual([
      [0, 60_000_000], [60_000_000, 120_000_000], [120_000_000, 180_000_000], [180_000_000, 240_000_000], [240_000_000, 300_000_000],
    ]);
    expect(media.audio.every(item => item.data.length > 100 && item.data.length < 2_000_000)).toBe(true);
  });

  it('descarta quadros uniformes e preserva imagens com informação visual', async () => {
    for (const [name, source, expected] of [['blank', 'color=c=navy:s=320x240:r=2', 0], ['pattern', 'testsrc2=size=320x240:rate=2', 1]] as const) {
      const path = join(directory, `${name}.mp4`);
      await execute(ffmpeg.path, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-t', '2', '-c:v', 'libx264', path]);
      const media = await extractEvaluationMedia(executor, path, 'mp4', { id: 'test', durationMicroseconds: 2_000_000, hasAudio: false, hasVideo: true }, new AbortController().signal);
      expect(media.audio).toEqual([]);
      expect(media.frames).toHaveLength(expected);
    }
  });

  it('prepara áudio MP3 e cinco minutos de vídeo WebM sem saída para rede', async () => {
    const audio = join(directory, 'speech.mp3'), video = join(directory, 'long.webm');
    await Promise.all([
      execute(ffmpeg.path, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', audio]),
      execute(ffmpeg.path, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=2',
        '-t', '300', '-c:v', 'libvpx-vp9', '-threads', '1', video]),
    ]);
    const signal = AbortSignal.timeout(25_000);
    const clipped = await extractEvaluationMedia(executor, audio, 'mp3',
      { id: 'test', durationMicroseconds: 2_000_000, hasAudio: true, hasVideo: false }, signal);
    expect(clipped.audio).toHaveLength(1);
    const sample = await extractEvaluationMedia(executor, video, 'webm',
      { id: 'test', durationMicroseconds: 300_000_000, hasAudio: false, hasVideo: true }, signal);
    expect(sample.frames).toHaveLength(12);
    expect(sample.frames[11].endUs).toBeLessThanOrEqual(300_000_000);
  }, 35_000);

  it('recusa limite excedido e caminho sem mídia antes de enviar qualquer dado', async () => {
    const recording = { id: 'test', durationMicroseconds: 300_000_001, hasAudio: true, hasVideo: false };
    await expect(extractEvaluationMedia(executor, '/missing', 'wav', recording, new AbortController().signal)).rejects.toMatchObject({ code: 'media', retryable: false });
    await expect(extractEvaluationMedia(executor, '/missing', 'wav', { ...recording, durationMicroseconds: 1000 }, new AbortController().signal)).rejects.toMatchObject({ code: 'media', retryable: false });
  });
});
