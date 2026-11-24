import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractEvaluationMedia } from '../server/evaluation/openai-media.js';

const execute = promisify(execFile);
describe('derivados de mídia para OpenAI', () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'matraca-media-test-')); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
  it('divide cinco minutos de áudio em cinco blocos limitados, sem imagens', async () => {
    const path = join(directory, 'long.wav');
    await execute(ffmpeg.path, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '300', path]);
    const media = await extractEvaluationMedia(path, 'wav', { id: 'test', durationMicroseconds: 300_000_000, hasAudio: true, hasVideo: false }, new AbortController().signal);
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
      const media = await extractEvaluationMedia(path, 'mp4', { id: 'test', durationMicroseconds: 2_000_000, hasAudio: false, hasVideo: true }, new AbortController().signal);
      expect(media.audio).toEqual([]);
      expect(media.frames).toHaveLength(expected);
    }
  });

  it('recusa limite excedido e caminho sem mídia antes de enviar qualquer dado', async () => {
    const recording = { id: 'test', durationMicroseconds: 300_000_001, hasAudio: true, hasVideo: false };
    await expect(extractEvaluationMedia('/missing', 'wav', recording, new AbortController().signal)).rejects.toMatchObject({ code: 'media', retryable: false });
    await expect(extractEvaluationMedia('/missing', 'wav', { ...recording, durationMicroseconds: 1000 }, new AbortController().signal)).rejects.toMatchObject({ code: 'media', retryable: false });
  });
});
