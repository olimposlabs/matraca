import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import sharp from 'sharp';
import type { Database } from '../db.js';
import type { LocalStorage } from '../storage.js';
import { EvaluationProviderError, type EvaluationContext } from './provider.js';
import { liveEvaluationMaximumSeconds } from './openai-config.js';

const execute = promisify(execFile);
export interface MediaSegment { startUs: number; endUs: number; data: Buffer }
export interface EvaluationMedia { audio: MediaSegment[]; frames: MediaSegment[] }

/** Resolve only a persisted request and its tenant/student-owned recording. */
export function privateEvaluationMedia(db: Database, storage: LocalStorage) {
  return async (context: EvaluationContext, signal: AbortSignal): Promise<EvaluationMedia> => {
    const found = await db.query<{
      object_key: string; duration_us: string; has_audio: boolean; has_video: boolean; container: string;
    }>(
      `SELECT m.object_key,m.duration_us,m.has_audio,m.has_video,m.container
       FROM evaluation_requests r JOIN recordings m
         ON m.id=r.recording_id AND m.org_id=r.org_id AND m.student_id=r.student_id
       WHERE r.id=$1 AND m.id=$2 AND r.provider='openai' AND r.status='processing'`,
      [context.requestId, context.recording.id],
    );
    const row = found.rows[0];
    if (!row || Number(row.duration_us) !== context.recording.durationMicroseconds
      || row.has_audio !== context.recording.hasAudio || row.has_video !== context.recording.hasVideo) {
      throw new EvaluationProviderError('media', false);
    }
    return extractEvaluationMedia(storage.path(row.object_key), row.container, context.recording, signal);
  };
}

export async function extractEvaluationMedia(
  path: string, container: string, recording: EvaluationContext['recording'], signal: AbortSignal,
): Promise<EvaluationMedia> {
  const duration = recording.durationMicroseconds;
  const demuxer = { mp4: 'mov', webm: 'matroska', wav: 'wav', mp3: 'mp3' }[container];
  if (!demuxer || duration <= 0 || duration > liveEvaluationMaximumSeconds * 1_000_000) {
    throw new EvaluationProviderError('media', false);
  }
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'matraca-openai-'));
  const media: EvaluationMedia = { audio: [], frames: [] };
  const input = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1',
    '-protocol_whitelist', 'file,pipe', '-f', demuxer];
  const run = async (args: string[]) => {
    // No shell, remote protocols, subtitles, data tracks or unbounded child lifetime.
    await execute(process.env.FFMPEG_PATH ?? ffmpeg.path, args, {
      signal, timeout: 30_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL',
    });
  };
  try {
    if (recording.hasAudio) {
      for (let startUs = 0; startUs < duration; startUs += 60_000_000) {
        const endUs = Math.min(duration, startUs + 60_000_000);
        const output = join(directory, `audio-${startUs}.wav`);
        await run([...input, '-ss', String(startUs / 1_000_000), '-i', path,
          '-t', String((endUs - startUs) / 1_000_000), '-map', '0:a:0', '-vn', '-sn', '-dn',
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-threads', '1', output]);
        const data = await readFile(output);
        if (data.length > 2_000_000) throw new Error('Audio limit');
        if (data.length > 100) media.audio.push({ startUs, endUs, data });
      }
      if (!media.audio.length) throw new Error('No audio');
    }
    if (recording.hasVideo) {
      let decodedFrames = 0;
      const count = Math.min(12, Math.max(1, Math.ceil(duration / 5_000_000)));
      for (let index = 0; index < count; index++) {
        const startUs = Math.floor(duration * (index + 0.5) / count);
        const output = join(directory, `frame-${index}.jpg`);
        await run([...input, '-ss', String(startUs / 1_000_000), '-i', path, '-map', '0:v:0',
          '-an', '-sn', '-dn', '-frames:v', '1', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease',
          '-q:v', '4', '-threads', '1', output]);
        // A video track can finish before its audio track.
        const data = await readFile(output).catch(() => null);
        if (data && data.length > 512_000) throw new Error('Image limit');
        if (data?.length) {
          decodedFrames++;
          const stats = await sharp(data, { limitInputPixels: 512 * 512 }).stats();
          // Uniform/blank frames provide no evidence of posture or gesture.
          if (stats.channels.slice(0, 3).some(channel => channel.stdev >= 2)) {
            media.frames.push({ startUs, endUs: Math.min(duration, startUs + 1_000_000), data });
          }
        }
      }
      if (!decodedFrames) throw new Error('No video');
    }
    return media;
  } catch {
    if (signal.aborted) throw new EvaluationProviderError('timeout', true);
    throw new EvaluationProviderError('media', false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
