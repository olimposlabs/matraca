import type { Database } from '../db.js';
import type { LocalStorage } from '../storage.js';
import { MediaExecutorError, runMediaDecoder, type MediaExecutor } from '../media/executor.js';
import { EvaluationProviderError, type EvaluationContext } from './provider.js';
import { liveEvaluationMaximumSeconds } from './openai-config.js';

export interface MediaSegment { startUs: number; endUs: number; data: Buffer }
export interface EvaluationMedia { audio: MediaSegment[]; frames: MediaSegment[] }

const sampleBytes = 32 * 32 * 3;
function hasVisualDetail(sample: Buffer) {
  for (let channel = 0; channel < 3; channel++) {
    let sum = 0, squares = 0;
    for (let index = channel; index < sample.length; index += 3) {
      const value = sample[index];
      sum += value;
      squares += value * value;
    }
    const pixels = sample.length / 3;
    if (squares / pixels - (sum / pixels) ** 2 >= 4) return true;
  }
  return false;
}

function parseMedia(output: Buffer, duration: number, hasAudio: boolean, hasVideo: boolean): EvaluationMedia {
  const media: EvaluationMedia = { audio: [], frames: [] };
  let offset = 0, decodedFrames = 0;
  while (offset < output.length) {
    const separator = output.indexOf(10, offset);
    if (separator < offset || separator - offset > 64) throw new Error('Invalid media packet');
    const match = /^(audio|frame):(\d{1,9}):(\d{1,9}):(\d{1,7})$/u.exec(output.toString('ascii', offset, separator));
    if (!match) throw new Error('Invalid media packet');
    const [, type, start, end, length] = match;
    const startUs = Number(start), endUs = Number(end), size = Number(length);
    offset = separator + 1;
    if (endUs <= startUs || endUs > duration || offset + size > output.length) throw new Error('Invalid media packet');
    const data = output.subarray(offset, offset + size);
    offset += size;
    if (type === 'audio') {
      if (!hasAudio || media.audio.length >= 5 || size <= 100 || size > 2_000_000
        || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid audio packet');
      media.audio.push({ startUs, endUs, data });
    } else {
      if (!hasVideo || ++decodedFrames > 12 || size <= sampleBytes + 2 || size > sampleBytes + 512_000
        || data[sampleBytes] !== 255 || data[sampleBytes + 1] !== 216) throw new Error('Invalid frame packet');
      if (hasVisualDetail(data.subarray(0, sampleBytes))) media.frames.push({ startUs, endUs, data: data.subarray(sampleBytes) });
    }
  }
  if ((hasAudio && !media.audio.length) || (hasVideo && !decodedFrames)) throw new Error('Missing media');
  return media;
}

/** Resolve only a persisted request and its tenant/student-owned recording. */
export function privateEvaluationMedia(db: Database, storage: LocalStorage, executor: MediaExecutor) {
  return async (context: EvaluationContext, signal: AbortSignal): Promise<EvaluationMedia> => {
    const found = await db.query<{
      object_key: string; duration_us: string; has_audio: boolean; has_video: boolean; container: string;
    }>(
      `SELECT m.object_key,m.duration_us,m.has_audio,m.has_video,m.container
       FROM evaluation_requests r JOIN recordings m
         ON m.id=r.recording_id AND m.org_id=r.org_id AND m.student_id=r.student_id
       WHERE r.id=$1 AND m.id=$2 AND m.media_retired_at IS NULL AND r.provider='openai' AND r.status='processing'`,
      [context.requestId, context.recording.id],
    );
    const row = found.rows[0];
    if (!row || Number(row.duration_us) !== context.recording.durationMicroseconds
      || row.has_audio !== context.recording.hasAudio || row.has_video !== context.recording.hasVideo) {
      throw new EvaluationProviderError('media', false);
    }
    return extractEvaluationMedia(executor, storage.path(row.object_key), row.container, context.recording, signal);
  };
}


export async function extractEvaluationMedia(
  executor: MediaExecutor, path: string, container: string, recording: EvaluationContext['recording'], signal: AbortSignal,
): Promise<EvaluationMedia> {
  const duration = recording.durationMicroseconds;
  if (!['mp4', 'webm', 'wav', 'mp3'].includes(container) || !Number.isSafeInteger(duration) || duration <= 0
    || duration > liveEvaluationMaximumSeconds * 1_000_000 || (!recording.hasAudio && !recording.hasVideo)) {
    throw new EvaluationProviderError('media', false);
  }
  try {
    const output = await runMediaDecoder(executor, path, [
      container, String(duration), recording.hasAudio ? '1' : '0', recording.hasVideo ? '1' : '0',
    ], signal);
    return parseMedia(output, duration, recording.hasAudio, recording.hasVideo);
  } catch (error) {
    if (signal.aborted) throw new EvaluationProviderError('timeout', true);
    if (error instanceof MediaExecutorError) throw new EvaluationProviderError(error.kind, true);
    throw new EvaluationProviderError('media', false);
  }
}
